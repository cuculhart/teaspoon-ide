// Thread-count benchmark for the Ollama provider (Unreleased "CPU Threads").
//
// Measures what the feature actually promises: with all cores pinned, token
// generation may be fast but the renderer starves and streamed text lags
// behind / the UI stops responding; with a thread cap the display keeps up.
//
// Design:
//  - A local proxy (127.0.0.1:11436 -> :11434) sits between the app and
//    Ollama. It records the wire-arrival time of every NDJSON chunk (accurate
//    even when the renderer is starved) and injects num_predict / temperature
//    0 / seed / think:false / keep_alive so output length is fixed.
//  - In the renderer, a MutationObserver records how many characters of the
//    streaming bubble are displayed over time; a setTimeout-drift sampler and
//    a requestAnimationFrame counter measure event-loop starvation.
//  - Mid-generation, a real UI action (Chat focus toggle) is timed, plus
//    periodic evaluate() round-trips - proxies for "can I still do light
//    work while the LLM runs".
//  - num_thread itself goes through the app's own config (localStorage
//    ollama_num_thread) so the shipped feature path is what gets measured.
//
// Usage:
//   node e2e/bench-threads.mjs
//   BENCH_THREADS=0,4,2 BENCH_RUNS=3 BENCH_MODEL=qwen3.5:4b node e2e/bench-threads.mjs
//   (0 = unset / let Ollama use every core)

import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const viteBin = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js')
const mainJs = path.join(appDir, 'electron', 'main.js')
const PORT = 5173
const BASE = `http://localhost:${PORT}`

const OLLAMA = 'http://127.0.0.1:11434'
const PROXY_PORT = 11436
const PROXY = `http://localhost:${PROXY_PORT}`

const THREADS = (process.env.BENCH_THREADS || '0,4,2')
  .split(',').map((s) => parseInt(s.trim(), 10))
const RUNS = parseInt(process.env.BENCH_RUNS || '3', 10)
const MODEL = process.env.BENCH_MODEL || 'qwen3.5:4b'
const NUM_PREDICT = parseInt(process.env.BENCH_PREDICT || '600', 10)
const PROMPT = process.env.BENCH_PROMPT ||
  'Output the integers from 1 to 600 separated by spaces. Output nothing else.'
const OUT_FILE = process.env.BENCH_OUT ||
  path.join(appDir, 'e2e', 'bench-threads-results.json')
const RUN_TIMEOUT = 360000
// The measurement window starts when the first wire chunk arrives and ends
// BENCH_WINDOW_MS later OR when generation finishes - UI responsiveness
// during generation is the metric, so we don't need to wait for `done`.
const WINDOW_MS = parseInt(process.env.BENCH_WINDOW_MS || '90000', 10)

const mkTmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

// ---------- measuring proxy ----------

// Per-request state: each /api/chat POST gets its own log so a stale stream
// from a closed app can never contaminate the next run's measurements.
let wireReqT = 0    // when the request reached the proxy
let injectThreads = 0
let curLog = null   // {wire: [], done: null} of the most recent /api/chat

function startProxy() {
  const server = http.createServer((req, res) => {
    const isChat = req.method === 'POST' && req.url === '/api/chat'
    const chunks = []
    req.on('data', (d) => chunks.push(d))
    req.on('end', () => {
      let body = Buffer.concat(chunks)
      if (isChat) {
        wireReqT = Date.now()
        curLog = { wire: [], done: null }
        try {
          const json = JSON.parse(body.toString('utf8'))
          json.stream = true
          json.think = false
          json.keep_alive = '30m'
          json.options = {
            ...(json.options || {}),
            num_predict: NUM_PREDICT,
            temperature: 0,
            seed: 1,
            ...(injectThreads ? { num_thread: injectThreads } : {}),
          }
          if (!injectThreads && json.options) delete json.options.num_thread
          body = Buffer.from(JSON.stringify(json))
        } catch { /* forward as-is */ }
      }
      const upstream = http.request(
        {
          hostname: '127.0.0.1',
          port: 11434,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, 'content-length': body.length, host: '127.0.0.1:11434' },
        },
        (ures) => {
          res.writeHead(ures.statusCode, ures.headers)
          if (!isChat) {
            ures.pipe(res)
            return
          }
          let buf = ''
          let cumLen = 0
          const log = curLog
          ures.on('data', (d) => {
            const t = Date.now()
            res.write(d)
            buf += d.toString('utf8')
            let nl
            while ((nl = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line) continue
              try {
                const obj = JSON.parse(line)
                const piece = obj?.message?.content
                if (typeof piece === 'string') cumLen += piece.length
                log.wire.push({ t, cumLen, done: !!obj.done })
                if (obj.done) log.done = obj
              } catch { /* partial line */ }
            }
          })
          ures.on('end', () => res.end())
        },
      )
      upstream.on('error', (e) => {
        res.statusCode = 502
        res.end(`proxy upstream error: ${e.message}`)
      })
      upstream.end(body)
    })
  })
  return new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', () => resolve(server)))
}

// ---------- vite dev server (same pattern as run.mjs) ----------

function serverUp() {
  return new Promise((resolve) => {
    http.get(BASE, (res) => { res.resume(); resolve(true) })
      .on('error', () => resolve(false))
  })
}

async function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await serverUp()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`vite dev server not ready at ${BASE}`)
}

// ---------- renderer instrumentation ----------

// Runs in the page before app scripts: seeds config and installs observers.
function initScript({ threads, model }) {
  localStorage.setItem('llm_provider', 'ollama')
  localStorage.setItem('ollama_base_url', 'http://localhost:11436')
  localStorage.setItem('ollama_model', model)
  if (threads) localStorage.setItem('ollama_num_thread', String(threads))
  else localStorage.removeItem('ollama_num_thread')
  localStorage.setItem('ollama_think', '0')
  localStorage.setItem('language', 'en')
  localStorage.setItem('auto_summarize', '0')
  localStorage.removeItem('last_project_path')
  localStorage.removeItem('last_no_project_conv')
  localStorage.setItem('chat_focus', '0')

  const install = () => {
    const b = (window.__bench = { dom: [], lag: [], raf: [] })

    // Displayed-length timeline of the streaming bubble. While generating the
    // app renders TWO assistant bubbles - the streaming text and a trailing
    // "Generating response"/cancel bubble (.message-text.loading) - so the
    // streaming one is the LAST assistant .message-text that is neither the
    // loading bubble nor a completed .markdown-body message.
    const record = () => {
      const texts = document.querySelectorAll('.chat-messages .chat-message.assistant .message-text')
      let last = null
      for (const el of texts) {
        if (!el.classList.contains('loading') && !el.querySelector('.markdown-body')) last = el
      }
      b.dom.push({
        t: Date.now(),
        streamLen: last ? last.textContent.length : -1,
        loading: !!document.querySelector('.loading-dots'),
      })
    }
    new MutationObserver(() => {
      if (document.querySelector('.chat-messages')) record()
    }).observe(document.body, { subtree: true, childList: true, characterData: true })

    // Event-loop starvation sampler: scheduled 100ms, measure actual drift.
    let expected = performance.now() + 100
    const lagTick = () => {
      const now = performance.now()
      b.lag.push({ t: Date.now(), ms: Math.max(0, now - expected) })
      expected = now + 100
      setTimeout(lagTick, 100)
    }
    setTimeout(lagTick, 100)

    // Effective frame rate.
    const rafTick = () => { b.raf.push(Date.now()); requestAnimationFrame(rafTick) }
    requestAnimationFrame(rafTick)
  }
  // addInitScript can run before documentElement/body exist.
  if (document.body) install()
  else document.addEventListener('DOMContentLoaded', install, { once: true })
}

// ---------- one measured run ----------

async function launchApp(threads) {
  const profileDir = mkTmp('tsp-bench-')
  const args = [mainJs, `--user-data-dir=${profileDir}`]
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: electronExe, args, env, timeout: 90000 })
  const page = await app.firstWindow()
  await page.addInitScript(initScript, { threads, model: MODEL })
  await page.reload()
  await page.waitForSelector('.chat-input textarea', { timeout: 60000 })
  return { app, page }
}

const pct = (arr, p) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const med = (arr) => pct(arr, 50)

async function runOnce(threads, runIdx) {
  curLog = null
  wireReqT = 0
  injectThreads = threads

  const { app, page } = await launchApp(threads)
  const result = { threads: threads || 'all', run: runIdx }
  try {
    const sendT = Date.now()
    await page.fill('.chat-input textarea', PROMPT)
    await page.click('.send-button')

    // Probes while the request is in flight: evaluate-RTT samples (timestamped
    // so they can be split into the prefill phase vs the streaming phase) plus
    // real UI actions timed in each phase - prefill saturates all cores too,
    // so it is part of the "can I still use the PC" question.
    const rtts = []
    let uiProbeMs = null
    let uiProbePreMs = null
    let preProbeDone = false
    let probeDone = false
    const deadline = Date.now() + RUN_TIMEOUT
    let windowEnd = null
    let finished = false
    const uiProbe = async () => {
      const c0 = Date.now()
      try {
        await page.click('button[title="Chat focus"]', { timeout: 30000 })
        await page.waitForSelector('.chat-list-rail', { timeout: 30000 })
        const ms = Date.now() - c0
        await page.click('button[title="Exit chat focus"]', { timeout: 30000 })
        await page.waitForSelector('.chat-list-rail', { state: 'detached', timeout: 30000 })
        return ms
      } catch { return -1 }
    }
    while (Date.now() < deadline && !finished) {
      const t0 = Date.now()
      try {
        await page.evaluate(() => 1)
        rtts.push({ t: t0, ms: Date.now() - t0 })
      } catch { /* navigation etc. */ }
      const w = curLog ? curLog.wire : []
      const streamDone = w.some((c) => c.done)
      const uiDone = await page.locator('.chat-input textarea:not([disabled])').count() > 0
      finished = streamDone && uiDone
      if (w.length > 0 && windowEnd === null) windowEnd = w[0].t + WINDOW_MS
      if (windowEnd !== null && Date.now() > windowEnd) break // measured enough
      // Prefill probe: request sent, no content on the wire yet.
      if (!preProbeDone && wireReqT > 0 && w.length === 0) {
        preProbeDone = true
        uiProbePreMs = await uiProbe()
      }
      if (!probeDone && w.length > 15) {
        probeDone = true
        uiProbeMs = await uiProbe()
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    const endT = Date.now()

    const bench = await page.evaluate(() => window.__bench).catch(() => null)
    const log = curLog || { wire: [], done: null }
    const wireDone = log.done
    const wEnd = windowEnd ?? (log.wire.length ? log.wire[log.wire.length - 1].t : endT)
    // Chunks that arrived on the wire inside the measurement window.
    const w = log.wire.filter((c) => c.cumLen > 0 && c.t <= wEnd)
    const lastWire = w.length ? w[w.length - 1].t : null
    const winCum = w.length ? w[w.length - 1].cumLen : 0

    // Chunks with no visible content (thinking trace / role-only lines) that
    // arrived before the first content chunk - verifies think:false applied.
    const firstContentT = log.wire.find((c) => c.cumLen > 0)?.t
    const preContentChunks = firstContentT
      ? log.wire.filter((c) => c.t < firstContentT).length
      : log.wire.length

    // Per-chunk display lag: first DOM sample whose shown length covers the
    // chunk's cumulative length, minus the chunk's wire-arrival time.
    const dom = (bench?.dom || []).filter((d) => d.t >= sendT - 1000 && d.streamLen >= 0)
    const lags = []
    let di = 0
    for (const c of w) {
      while (di < dom.length && (dom[di].streamLen < c.cumLen || dom[di].t < c.t)) di++
      if (di < dom.length) lags.push(dom[di].t - c.t)
    }
    const win0 = w.length ? w[0].t : sendT
    const win1 = wEnd
    const winLag = (bench?.lag || []).filter((l) => l.t >= win0 && l.t <= win1).map((l) => l.ms)
    const winRaf = (bench?.raf || []).filter((r) => r >= win0 && r <= win1)
    // Prefill phase: request sent -> first content chunk. Prefill is
    // compute-bound and pins every allowed core, so UI starvation shows here
    // even when decode leaves headroom.
    const preLag = (bench?.lag || []).filter((l) => l.t >= sendT && l.t < win0).map((l) => l.ms)
    const preRaf = (bench?.raf || []).filter((r) => r >= sendT && r < win0)
    const preRtts = rtts.filter((r) => r.t < win0).map((r) => r.ms)
    const winRtts = rtts.filter((r) => r.t >= win0 && r.t <= win1).map((r) => r.ms)
    // Client-visible generation rate inside the window (chars arriving/sec).
    const wireChS = w.length > 1 ? +((winCum / ((lastWire - win0) / 1000))).toFixed(1) : null

    Object.assign(result, {
      ok: w.length > 0,
      genDone: finished,
      ttftMs: w.length ? w[0].t - wireReqT : null,
      wireTokS: wireDone?.eval_count && wireDone?.eval_duration
        ? +(wireDone.eval_count / (wireDone.eval_duration / 1e9)).toFixed(2) : null,
      wireChS,
      lagP50: med(lags),
      lagP95: pct(lags, 95),
      lagMax: lags.length ? Math.max(...lags) : null,
      totalMs: endT - sendT,
      loopLagP50: med(winLag),
      loopLagP95: pct(winLag, 95),
      loopLagMax: winLag.length ? Math.max(...winLag) : null,
      fps: win1 > win0 ? +(winRaf.length / ((win1 - win0) / 1000)).toFixed(1) : null,
      rttP50: med(winRtts),
      rttP95: pct(winRtts, 95),
      rttMax: winRtts.length ? Math.max(...winRtts) : null,
      uiProbeMs,
      preLoopLagP95: pct(preLag, 95),
      preLoopLagMax: preLag.length ? Math.max(...preLag) : null,
      preFps: win0 > sendT ? +(preRaf.length / ((win0 - sendT) / 1000)).toFixed(1) : null,
      preRttP50: med(preRtts),
      preRttP95: pct(preRtts, 95),
      uiProbePreMs,
      winCum,
      chunksInWindow: w.length,
      preContentChunks,
      domSamples: dom.length,
      lagSamples: lags.length,
    })
  } finally {
    await app.close().catch(() => {})
  }
  return result
}

// ---------- main ----------

async function main() {
  for (const f of [electronExe, viteBin, mainJs]) {
    if (!fs.existsSync(f)) throw new Error(`missing: ${f} (run npm install first)`)
  }
  const tags = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json()).catch(() => null)
  if (!tags) throw new Error('Ollama is not running at ' + OLLAMA)
  if (!tags.models?.some((m) => m.name === MODEL)) {
    console.warn(`warning: model "${MODEL}" not in ollama list; attempting anyway`)
  }

  const proxy = await startProxy()
  console.log(`proxy ${PROXY} -> ${OLLAMA}`)

  let vite = null
  if (!(await serverUp())) {
    console.log('starting vite dev server...')
    vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
    process.on('exit', () => { vite && vite.kill(); proxy.close() })
  }
  await waitForServer()

  console.log(`model=${MODEL} num_predict=${NUM_PREDICT} threads=[${THREADS.join(',')}] runs=${RUNS}`)

  // Warmup: load the model and settle caches; result discarded.
  console.log('warmup...')
  await runOnce(0, -1).catch((e) => console.warn('warmup failed:', e.message))

  const results = []
  for (let r = 0; r < RUNS; r++) {
    for (const t of THREADS) {
      process.stdout.write(`  threads=${t || 'all'} run ${r + 1}/${RUNS} ... `)
      try {
        const res = await runOnce(t, r)
        results.push(res)
        console.log(`wire=${res.wireChS}ch/s lagP95=${res.lagP95}ms lagN=${res.lagSamples} loopLagP95=${res.loopLagP95}ms fps=${res.fps} rttP95=${res.rttP95}ms ui=${res.uiProbeMs}ms | pre: lag=${res.preLoopLagP95}ms fps=${res.preFps} ui=${res.uiProbePreMs}ms`)
      } catch (e) {
        results.push({ threads: t || 'all', run: r, ok: false, error: e.message })
        console.log(`FAILED: ${e.message}`)
      }
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ meta: { model: MODEL, num_predict: NUM_PREDICT, prompt: PROMPT, threads: THREADS, runs: RUNS, date: new Date().toISOString() }, results }, null, 2))
  console.log(`\nresults written to ${OUT_FILE}`)

  // Median-per-setting summary table.
  const keys = ['wireChS', 'ttftMs', 'lagP50', 'lagP95', 'lagMax', 'loopLagP50', 'loopLagP95', 'loopLagMax', 'fps', 'rttP50', 'rttP95', 'uiProbeMs', 'preLoopLagP95', 'preLoopLagMax', 'preFps', 'preRttP50', 'preRttP95', 'uiProbePreMs']
  const byThreads = new Map()
  for (const r of results.filter((x) => x.ok)) {
    const k = String(r.threads)
    if (!byThreads.has(k)) byThreads.set(k, [])
    byThreads.get(k).push(r)
  }
  console.log('\n| threads | ' + keys.join(' | ') + ' |')
  console.log('|---|' + keys.map(() => '---').join('|') + '|')
  for (const [k, rows] of byThreads) {
    const cells = keys.map((key) => {
      const v = med(rows.map((r) => r[key]).filter((x) => x != null))
      return v == null ? '-' : v
    })
    console.log(`| ${k} | ${cells.join(' | ')} |`)
  }

  proxy.close()
  if (vite) vite.kill()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
