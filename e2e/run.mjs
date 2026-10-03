// Adversarial E2E tests for Teaspoon IDE (res-and-dev.md), driven by
// Playwright's Electron support.
//
// The Gemini API is stubbed via page.route(), so the "model" emits scripted
// command output deterministically - no real API key, no network calls.
// Each test launches the app with a private --user-data-dir, so the user's
// real profile (API keys, chat history) is never touched.
//
// Run: node e2e/run.mjs   (or: npm run test:e2e)
// Requires the built/vite dev pipeline only - no `npm run build` needed.

import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import assert from 'node:assert'
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

// ---------- helpers ----------

const fwd = (p) => p.replace(/\\/g, '/')
const mkTmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

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

const geminiReply = (text) => JSON.stringify({
  candidates: [{
    content: { role: 'model', parts: [{ text }] },
    finishReason: 'STOP',
    index: 0,
  }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
})

// Route every Gemini API call to a scripted reply queue and capture the
// request bodies, so a test can assert that a secret never leaves the app.
async function mockGemini(page, replies, captured, { delayMs = 0 } = {}) {
  await page.route(/generativelanguage\.googleapis\.com/, async (route) => {
    captured.push(route.request().postData() ?? '')
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const text = replies.length ? replies.shift() : 'E2E_DONE'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: geminiReply(text),
    })
  })
}

async function launchApp({ profileDir, focus = false }) {
  const args = [mainJs, `--user-data-dir=${profileDir}`]
  // This shell runs inside an Electron-based tool, so ELECTRON_RUN_AS_NODE
  // leaks into every child process and would launch the app as plain Node.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: electronExe, args, env, timeout: 90000 })
  const page = await app.firstWindow()
  await page.addInitScript(({ focus }) => {
    localStorage.setItem('gemini_api_key', 'pw-e2e-key')
    localStorage.setItem('llm_provider', 'gemini')
    localStorage.setItem('language', 'en')
    localStorage.setItem('auto_summarize', '0')
    localStorage.removeItem('last_project_path')
    localStorage.removeItem('last_no_project_conv')
    localStorage.setItem('chat_focus', focus ? '1' : '0')
  }, { focus })
  await page.reload()
  await page.waitForSelector('.chat-input textarea', { timeout: 60000 })
  // Sanity: the private profile dir must be honored - otherwise the test
  // would touch the user's real chat history and API key.
  const userData = await app.evaluate(async ({ app }) => app.getPath('userData'))
  if (path.resolve(userData) !== path.resolve(profileDir)) {
    await app.close()
    throw new Error(
      `--user-data-dir was not honored (got ${userData}); ` +
      'aborting to avoid polluting the real profile',
    )
  }
  return { app, page, userData }
}

// Open a project via the same window event the main-process folder-drop
// path dispatches, then wait until the Explorer shows it as open.
async function openProject(page, dir) {
  await page.evaluate((p) => {
    window.dispatchEvent(new CustomEvent('teaspoon:open-project-path', { detail: p }))
  }, fwd(dir))
  await page.waitForSelector('.close-project-button', { timeout: 20000 })
}

async function sendChat(page, text) {
  await page.fill('.chat-input textarea', text)
  await page.click('.send-button')
}

const messagesText = (page) => page.locator('.chat-messages').innerText()

function waitForMarker(page, text, timeout = 45000) {
  return page.waitForFunction(
    (t) => document.querySelector('.chat-messages')?.innerText?.includes(t),
    text, { timeout },
  )
}

// ---------- tests ----------

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// G-1: the fixed exfiltration hole - a bare absolute-path READ_FILE with no
// project open must be rejected, and the file's contents must never reach
// the model (checked in the actual outgoing request bodies).
test('G-1  no-project absolute READ_FILE is rejected; content never sent', async () => {
  const tmp = mkTmp('tsp-g1-')
  const sentinel = path.join(tmp, 'sentinel.txt')
  fs.writeFileSync(sentinel, 'SENTINEL_SECRET_G1_12345')
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    const reqs = []
    await mockGemini(page, [`// READ_FILE: ${fwd(sentinel)}`, 'G1_DONE'], reqs)
    await sendChat(page, 'read the file for me')
    await waitForMarker(page, 'G1_DONE')
    const msgs = await messagesText(page)
    assert.ok(msgs.includes('No project is open'), 'rejection note missing:\n' + msgs)
    assert.ok(
      !reqs.join('\n').includes('SENTINEL_SECRET_G1'),
      'file content was transmitted to the model endpoint',
    )
  } finally { await app.close() }
})

// G-2: with a project open, ../ must not escape the root (normalization).
test('G-2  ../ traversal READ_FILE is rejected with a project open', async () => {
  const tmp = mkTmp('tsp-g2-')
  const proj = path.join(tmp, 'proj')
  fs.mkdirSync(proj)
  fs.writeFileSync(path.join(tmp, 'sentinel.txt'), 'SENTINEL_SECRET_G2_abcde')
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    await openProject(page, proj)
    const reqs = []
    await mockGemini(page, ['// READ_FILE: ../sentinel.txt', 'G2_DONE'], reqs)
    await sendChat(page, 'read ../sentinel.txt')
    await waitForMarker(page, 'G2_DONE')
    const msgs = await messagesText(page)
    assert.ok(msgs.includes('outside the project root'), 'traversal not rejected:\n' + msgs)
    assert.ok(
      !reqs.join('\n').includes('SENTINEL_SECRET_G2'),
      'file content was transmitted to the model endpoint',
    )
  } finally { await app.close() }
})

// B-4: the same normalization protects writes - nothing may land on disk.
test('B-4  ../../ WRITE_FILE is rejected; no file created', async () => {
  const tmp = mkTmp('tsp-b4-')
  const proj = path.join(tmp, 'proj')
  fs.mkdirSync(proj)
  const escapeName = `pw-escape-${Date.now()}.txt`
  const escaped = path.resolve(proj, '..', '..', escapeName)
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    await openProject(page, proj)
    const reqs = []
    await mockGemini(
      page,
      [`// WRITE_FILE: ../../${escapeName}\npwned\n// END_WRITE_FILE`, 'B4_DONE'],
      reqs,
    )
    await sendChat(page, 'write a file')
    await waitForMarker(page, 'B4_DONE')
    const msgs = await messagesText(page)
    assert.ok(msgs.includes('outside the project root'), 'traversal not rejected:\n' + msgs)
    assert.strictEqual(await page.locator('.file-edit-approval').count(), 0,
      'rejected write reached the approval dialog')
    assert.ok(!fs.existsSync(escaped), `escape file exists: ${escaped}`)
  } finally { await app.close() }
})

// A-3: a command-looking line inside a WRITE_FILE body must stay body text.
test('A-3  nested command line inside WRITE_FILE body is not re-parsed', async () => {
  const tmp = mkTmp('tsp-a3-')
  const proj = path.join(tmp, 'proj')
  fs.mkdirSync(proj)
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    await openProject(page, proj)
    const reqs = []
    await mockGemini(page, [
      '// WRITE_FILE: guide.md\nUsage example:\n// WRITE_FILE: evil.md\nend of guide\n// END_WRITE_FILE',
      'A3_DONE',
    ], reqs)
    await sendChat(page, 'create a guide file')
    await page.waitForSelector('.file-edit-approval', { timeout: 30000 })
    // The approval dialog must list exactly the outer file.
    const items = await page.locator('.edit-item .file-path').allInnerTexts()
    assert.deepStrictEqual(items.length, 1, `expected 1 approval item, got ${items.length}: ${items}`)
    await page.click('.approve-button')
    await waitForMarker(page, 'A3_DONE')
    assert.ok(fs.existsSync(path.join(proj, 'guide.md')), 'guide.md was not written')
    assert.ok(!fs.existsSync(path.join(proj, 'evil.md')), 'evil.md was created!')
    assert.ok(
      fs.readFileSync(path.join(proj, 'guide.md'), 'utf8').includes('// WRITE_FILE: evil.md'),
      'inner command line was stripped from the body',
    )
  } finally { await app.close() }
})

// A-2: an unclosed ::: block must produce retry feedback, not a file.
test('A-2  unclosed ::: block yields retry feedback and no write', async () => {
  const tmp = mkTmp('tsp-a2-')
  const proj = path.join(tmp, 'proj')
  fs.mkdirSync(proj)
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    await openProject(page, proj)
    const reqs = []
    await mockGemini(page, [
      ':::WRITE_FILE: a.md\nunterminated body\nand trailing prose',
      'A2_DONE',
    ], reqs)
    await sendChat(page, 'create a.md')
    await waitForMarker(page, 'A2_DONE')
    const msgs = await messagesText(page)
    assert.ok(msgs.includes('Incomplete command block'), 'no malformed-block feedback:\n' + msgs)
    assert.ok(!fs.existsSync(path.join(proj, 'a.md')), 'a.md was created from a malformed block')
    assert.ok(reqs.length >= 2 && reqs[1].includes('Malformed'),
      'model was not told the block was malformed')
  } finally { await app.close() }
})

// B-1: the create-project modal shows at most once per turn; cancelling
// rejects the writes instead of looping the modal.
test('B-1  create-project modal once per turn; cancel rejects writes', async () => {
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    const reqs = []
    await mockGemini(page, [
      '// WRITE_FILE: a.txt\naaa\n// END_WRITE_FILE\n// WRITE_FILE: b.txt\nbbb\n// END_WRITE_FILE',
      'B1_DONE',
    ], reqs)
    await sendChat(page, 'make two files')
    await page.waitForSelector('.create-project-modal', { timeout: 30000 })
    await page.click('.create-project-modal .dialog-actions button >> nth=1') // Cancel
    await waitForMarker(page, 'B1_DONE')
    const msgs = await messagesText(page)
    assert.ok(msgs.includes('No project is open'), 'writes were not rejected:\n' + msgs)
    assert.strictEqual(await page.locator('.create-project-modal').count(), 0,
      'modal reappeared after cancel')
  } finally { await app.close() }
})

// E-1: assistant HTML must be sanitized by DOMPurify.
test('E-1  assistant markup is sanitized (no script/event handlers run)', async () => {
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    await page.evaluate(() => { window.__xss = 0; window.__xss2 = 0 })
    const reqs = []
    await mockGemini(page, [
      'Here: <img src=x onerror="window.__xss=1"> <script>window.__xss2=1</script> E1_DONE',
    ], reqs)
    await sendChat(page, 'show me some html')
    await waitForMarker(page, 'E1_DONE')
    await page.waitForTimeout(300)
    const flags = await page.evaluate(() => [window.__xss, window.__xss2])
    assert.deepStrictEqual(flags, [0, 0], `injected code executed: ${flags}`)
    const onerror = await page.locator('.markdown-body [onerror]').count()
    assert.strictEqual(onerror, 0, 'onerror attribute survived sanitization')
  } finally { await app.close() }
})

// E-3: user messages must stay plain text.
test('E-3  user message renders as plain text, not markdown', async () => {
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    const reqs = []
    await mockGemini(page, ['E3_DONE'], reqs)
    await sendChat(page, '# heading **bold**')
    await waitForMarker(page, 'E3_DONE')
    const userMsg = page.locator('.chat-message.user .message-text').last()
    assert.strictEqual(await userMsg.locator('h1').count(), 0, 'user msg rendered <h1>')
    assert.strictEqual(await userMsg.locator('strong').count(), 0, 'user msg rendered <strong>')
    assert.ok((await userMsg.innerText()).includes('# heading'), 'raw text lost')
  } finally { await app.close() }
})

// D-1 companion: the current user message must go out once - as the
// request prompt - not duplicated inside the history array.
test('D-1a current user message appears exactly once in the request', async () => {
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    const reqs = []
    await mockGemini(page, ['UNIQ_DONE'], reqs)
    await sendChat(page, 'E2E_UNIQ_PHRASE_987')
    await waitForMarker(page, 'UNIQ_DONE')
    const count = (reqs[0] ?? '').split('E2E_UNIQ_PHRASE_987').length - 1
    assert.strictEqual(count, 1, `user message appeared ${count} times in the payload`)
  } finally { await app.close() }
})

// D-1b: once stored history exceeds the 20-message window, the prompt
// must disclose that earlier turns are omitted - otherwise the model
// confidently answers about a conversation start it cannot see.
test('D-1b truncated history is disclosed in the prompt', async () => {
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    const reqs = []
    await mockGemini(page, [], reqs) // every reply defaults to E2E_DONE
    // 12 turns = 24 stored messages > 20-window on the last send.
    for (let i = 0; i < 12; i++) {
      await page.fill('.chat-input textarea', `msg ${i}`)
      await page.click('.send-button')
      await page.waitForSelector('.chat-input textarea:not([disabled])', { timeout: 20000 })
    }
    assert.ok(
      (reqs[reqs.length - 1] ?? '').includes('only the last 20 messages are shown'),
      'truncation note missing once history exceeded the window',
    )
    assert.ok(
      !(reqs[0] ?? '').includes('only the last 20 messages are shown'),
      'truncation note sent before any history was dropped',
    )
  } finally { await app.close() }
})

// F-3: toggling chat focus mid-generation must not break the turn.
test('F-3  chat focus toggled during streaming keeps generating', async () => {
  const { app, page } = await launchApp({ profileDir: mkTmp('tsp-prof-') })
  try {
    const reqs = []
    await mockGemini(page, ['F3_DONE'], reqs, { delayMs: 2000 })
    await sendChat(page, 'hello')
    await page.waitForSelector('.loading-dots', { timeout: 15000 })
    await page.click('button[title="Chat focus"]')
    await page.waitForSelector('.chat-list-rail', { timeout: 10000 })
    await waitForMarker(page, 'F3_DONE')
    await page.click('button[title="Exit chat focus"]')
    await page.waitForSelector('.chat-list-rail', { state: 'detached', timeout: 10000 })
  } finally { await app.close() }
})

// C-5: a corrupt index.json must be rebuilt by scanning conv files.
test('C-5  corrupt index.json rebuilds the conversation list', async () => {
  const profile = mkTmp('tsp-prof-')
  const { app, page } = await launchApp({ profileDir: profile })
  let histDir
  try {
    const reqs = []
    await mockGemini(page, ['C5_SEED_DONE'], reqs)
    await sendChat(page, 'e2e c5 seed message')
    await waitForMarker(page, 'C5_SEED_DONE')
    const userData = await app.evaluate(async ({ app }) => app.getPath('userData'))
    histDir = path.join(userData, 'chat-history')
    // Wait until the conversation file actually exists (async put IPC).
    const deadline = Date.now() + 10000
    while (Date.now() < deadline &&
           !fs.readdirSync(histDir).some((n) => /^conv_.*\.json$/.test(n))) {
      await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(fs.readdirSync(histDir).some((n) => /^conv_.*\.json$/.test(n)),
      'conversation was not saved')
  } finally { await app.close() }

  fs.writeFileSync(path.join(histDir, 'index.json'), '{')

  const { app: app2, page: page2 } = await launchApp({ profileDir: profile, focus: true })
  try {
    await page2.waitForSelector('.chat-list-item', { timeout: 30000 })
    const titles = await page2.locator('.chat-list-item-title').allInnerTexts()
    assert.ok(titles.some((t) => t.includes('e2e c5 seed message')),
      `conversation not rebuilt into list: ${titles}`)
    // The rebuild must also have repaired index.json on disk.
    const idx = JSON.parse(fs.readFileSync(path.join(histDir, 'index.json'), 'utf8'))
    assert.ok(Array.isArray(idx.conversations) && idx.conversations.length > 0,
      'index.json was not rebuilt')
  } finally { await app2.close() }
})

// G-3: a hand-edited conversation file is display-only - stored command
// text must never reach the execution path.
test('G-3  tampered conversation file renders but does not execute', async () => {
  const profile = mkTmp('tsp-prof-')
  const histDir = path.join(profile, 'chat-history')
  fs.mkdirSync(histDir, { recursive: true })
  const convId = 'conv_e2e_g3_tamper'
  fs.writeFileSync(path.join(histDir, `${convId}.json`), JSON.stringify({
    id: convId,
    title: 'G3_TAMPERED_CHAT',
    projectPath: null,
    createdAt: 1,
    updatedAt: Date.now(),
    summarizedCount: 0,
    contextSummary: '',
    messages: [
      { role: 'user', content: 'hi', timestamp: 1 },
      { role: 'assistant', content: '// RUN_COMMAND: calc.exe', timestamp: 2 },
    ],
  }))
  // No index entry -> chat-history-list falls back to a directory scan.
  const { app, page } = await launchApp({ profileDir: profile, focus: true })
  try {
    await page.waitForSelector('.chat-list-item', { timeout: 30000 })
    await page.click('.chat-list-item:has-text("G3_TAMPERED_CHAT")')
    await waitForMarker(page, 'RUN_COMMAND')
    await page.waitForTimeout(1000)
    assert.strictEqual(await page.locator('.file-edit-approval').count(), 0,
      'stored command text reached the approval path - it would execute!')
  } finally { await app.close() }
})

// ---------- runner ----------

async function main() {
  for (const f of [electronExe, viteBin, mainJs]) {
    if (!fs.existsSync(f)) throw new Error(`missing: ${f} (run npm install / build first)`)
  }

  // Reuse an existing dev server if one is already running.
  let vite = null
  if (!(await serverUp())) {
    console.log('starting vite dev server...')
    vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
    process.on('exit', () => vite && vite.kill())
  }
  await waitForServer()
  console.log(`dev server ready at ${BASE}\n`)

  const results = []
  for (const { name, fn } of tests) {
    process.stdout.write(`  ${name}\n`)
    const t0 = Date.now()
    try {
      await fn()
      results.push({ name, ok: true })
      console.log(`     ✅ PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    } catch (e) {
      results.push({ name, ok: false, error: e })
      console.log(`     ❌ FAIL (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
      console.log(`     ${String(e && e.message ? e.message : e).split('\n').join('\n     ')}`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? ` - failed: ${failed.map((r) => r.name.split(' ')[0]).join(', ')}` : ''))

  if (vite) vite.kill()
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('e2e runner failed:', e)
  process.exit(2)
})
