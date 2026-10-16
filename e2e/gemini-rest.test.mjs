// Unit tests for src/services/geminiRest.ts - the pure helpers behind the
// main-process LLM relay. Usage: node e2e/gemini-rest.test.mjs (bundles the
// TS via esbuild into a temp .mjs first).
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const out = path.join(mkdtempSync(path.join(tmpdir(), 'tsip-gemini-')), 'geminiRest.mjs')

execFileSync('npx', ['esbuild', 'src/services/geminiRest.ts', '--bundle', '--format=esm', `--outfile=${out}`], {
  cwd: root, stdio: 'inherit', shell: true,
})

const { generateContentPath, geminiErrorMessage, extractResponseText } = await import(pathToFileURL(out).href)

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${detail}`) }
}

// --- generateContentPath ---
check('path shape', generateContentPath('gemini-3.8-flash') === '/v1beta/models/gemini-3.8-flash:generateContent')
check('path is relative (relay host-bound)', generateContentPath('x').startsWith('/'))
check('model id is encoded', generateContentPath('a b').includes('a%20b'))

// --- extractResponseText ---
{
  const json = {
    candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'world' }] } }],
  }
  check('joins text parts', extractResponseText(json) === 'Hello world')
}
{
  let threw = null
  try { extractResponseText({ promptFeedback: { blockReason: 'SAFETY' } }) } catch (e) { threw = e.message }
  check('block reason surfaces', threw === 'Response blocked: SAFETY', threw)
}
{
  let threw = null
  try { extractResponseText({ candidates: [] }) } catch (e) { threw = e.message }
  check('empty candidates throw', threw === 'Empty response from Gemini', threw)
}
{
  // non-text parts (e.g. functionCall) are ignored, not stringified
  const json = { candidates: [{ content: { parts: [{ functionCall: { name: 'x' } }, { text: 'ok' }] } }] }
  check('non-text parts skipped', extractResponseText(json) === 'ok')
}

// --- geminiErrorMessage ---
{
  const json = { error: { message: 'models/gemini-x is not found' } }
  check('error.message preferred', geminiErrorMessage(json, 'fallback') === 'models/gemini-x is not found')
}
check('text fallback', geminiErrorMessage(null, 'raw body') === 'raw body')
check('last resort', geminiErrorMessage(null, '') === 'Unknown error')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
