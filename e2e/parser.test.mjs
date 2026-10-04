// Unit tests for src/services/commandParser.ts - runs the REAL parser,
// not a copy. Usage: node e2e/parser.test.mjs (builds the TS via esbuild
// into a temp .cjs first). Covers the model-output failures observed in
// real chat logs.
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const out = path.join(mkdtempSync(path.join(tmpdir(), 'tsip-parser-')), 'commandParser.mjs')

execFileSync('npx', ['esbuild', 'src/services/commandParser.ts', '--bundle', '--format=esm', `--outfile=${out}`], {
  cwd: root, stdio: 'inherit', shell: true,
})

// hostOpenCommand() reads window.electronAPI.platform - pretend Windows.
globalThis.window = { electronAPI: { platform: 'win32' } }
const { findFileCommands } = await import(pathToFileURL(out).href)

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${detail}`) }
}
const types = (r) => r.commands.map(c => c.type).join(',')
const args = (r) => r.commands.map(c => c.arg)

// --- observed failure: URL truncated at // ---
{
  const r = findFileCommands('// RUN_COMMAND: start https://www.apple.com/jp/shop/refurbished/mac')
  check('url not truncated', r.commands.length === 1 && r.commands[0].arg === 'start https://www.apple.com/jp/shop/refurbished/mac', JSON.stringify(args(r)))
}
// --- glued commands still split at "// KEYWORD" ---
{
  const r = findFileCommands('// READ_FILE: a.txt// LIST_FILES: docs')
  check('glued commands split', types(r) === 'read,list' && r.commands[0].arg === 'a.txt' && r.commands[1].arg === 'docs', JSON.stringify(args(r)))
}
// --- UNC path kept ---
{
  const r = findFileCommands('// READ_FILE: //server/share/file.txt')
  check('unc path kept', r.commands.length === 1 && r.commands[0].arg === '//server/share/file.txt', JSON.stringify(args(r)))
}
// --- trailing "// comment" still stripped ---
{
  const r = findFileCommands('// READ_FILE: a.txt // read the file')
  check('ws comment stripped', r.commands.length === 1 && r.commands[0].arg === 'a.txt', JSON.stringify(args(r)))
}
// --- observed failure: JSON command blob ---
{
  const r = findFileCommands('[{"command": "WRITE_FILE", "path": "README.md", "content": "# Apple調査\\n\\n本文\\n"}]')
  check('json write parsed', r.commands.length === 1 && r.commands[0].type === 'write' && r.commands[0].arg === 'README.md' && r.commands[0].body === '# Apple調査\n\n本文\n', JSON.stringify(r.commands))
}
// --- JSON with "command" inside a code fence stays inert ---
{
  const r = findFileCommands('```json\n[{"command": "WRITE_FILE", "path": "x.md", "content": "y"}]\n```')
  check('fenced json inert', r.commands.length === 0, JSON.stringify(r.commands))
}
// --- malformed JSON left as text ---
{
  const r = findFileCommands('[{"command": "WRITE_FILE", "path": broken}]')
  check('malformed json inert', r.commands.length === 0, JSON.stringify(r.commands))
}
// --- observed failure: bare WRITE_FILE with no markers, body to end ---
{
  const r = findFileCommands('説明しますね。\nWRITE_FILE: README.md\n# しりとりのルール\n\n1. 交互に言う\n2. んがついたら負け\n')
  check('bare write to eof', r.commands.length === 1 && r.commands[0].type === 'write' && r.commands[0].arg === 'README.md' && r.commands[0].body.includes('しりとり'), JSON.stringify(r.commands.map(c => ({ t: c.type, a: c.arg }))))
}
// --- bare single-line command ---
{
  const r = findFileCommands('RUN_COMMAND: start https://example.com/x')
  check('bare run command', r.commands.length === 1 && r.commands[0].type === 'run' && r.commands[0].arg === 'start https://example.com/x', JSON.stringify(args(r)))
}
// --- prose starting with "GREP:" still executes (colon required but prose
//     at line start IS treated as a command attempt - acceptable) ---
{
  const r = findFileCommands('解説：WRITE_FILE はファイルを作成します')  // mid-line, not line start
  check('mid-line prose ignored', r.commands.length === 0, JSON.stringify(r.commands))
}
// --- markdown link run arg resolves to real url ---
{
  const r = findFileCommands('// RUN_COMMAND: start https://[www.apple.com/jp/x](https://www.apple.com/jp/x)')
  check('markdown link url', r.commands.length === 1 && r.commands[0].arg === 'start https://www.apple.com/jp/x', JSON.stringify(args(r)))
}
// --- normal write still works ---
{
  const r = findFileCommands('// WRITE_FILE: ok.md\nhello world\n// END_WRITE_FILE')
  check('normal write', r.commands.length === 1 && r.commands[0].type === 'write' && r.commands[0].arg === 'ok.md' && r.commands[0].body === 'hello world\n', JSON.stringify(r.commands.map(c => c.arg)))
}
// --- fenced command example stays inert ---
{
  const r = findFileCommands('```\n// WRITE_FILE: example.md\nbody\n// END_WRITE_FILE\n```')
  check('fenced example inert', r.commands.length === 0, JSON.stringify(r.commands))
}
// --- command inside a write body is file content ---
{
  const r = findFileCommands('// WRITE_FILE: README.md\nuse "// RUN_COMMAND: npm test" to test\n// END_WRITE_FILE')
  check('cmd in body is content', r.commands.length === 1 && r.commands[0].type === 'write' && r.commands[0].body.includes('RUN_COMMAND'), JSON.stringify(r.commands))
}
// --- path + glued CJK prose cut at extension ---
{
  const r = findFileCommands('// READ_FILE: docs/Spec.mdプロジェクトの説明')
  check('cjk prose cut', r.commands.length === 1 && r.commands[0].arg === 'docs/Spec.md', JSON.stringify(args(r)))
}
// --- real CJK dir name kept (separator after) ---
{
  const r = findFileCommands('// READ_FILE: 資料.メモ/file.txt')
  check('cjk dir kept', r.commands.length === 1 && r.commands[0].arg === '資料.メモ/file.txt', JSON.stringify(args(r)))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
