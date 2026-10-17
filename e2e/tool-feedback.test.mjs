// Unit tests for src/services/toolFeedback.ts - the canonical verdict and
// state-digest lines prepended to model-facing tool feedback. Usage:
// node e2e/tool-feedback.test.mjs (bundles the TS via esbuild first).
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const out = path.join(mkdtempSync(path.join(tmpdir(), 'tsip-fb-')), 'toolFeedback.mjs')

execFileSync('npx', ['esbuild', 'src/services/toolFeedback.ts', '--bundle', '--format=esm', `--outfile=${out}`], {
  cwd: root, stdio: 'inherit', shell: true,
})

const { commandResultVerdict, formatStateDigest } = await import(pathToFileURL(out).href)

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${detail}`) }
}

// --- commandResultVerdict ---
check('timeout', commandResultVerdict('npm start', null, true, '').includes('STILL RUNNING'))
check(
  'pytest all pass',
  commandResultVerdict('python -m pytest test_calc.py', 0, false, '===== 4 passed in 0.01s =====') ===
    '[RESULT] OK - exit code 0 (4 passed)'
)
check(
  'pytest failure reports counts',
  commandResultVerdict('python -m pytest test_calc.py', 1, false, '===== 1 failed, 3 passed in 0.02s =====') ===
    '[RESULT] FAILED - exit code 1 (1 failed, 3 passed)'
)
check(
  'zero-test run is not a pass',
  commandResultVerdict('python -m pytest test_calc.py', 0, false, '===== collected 0 items =====').includes('NO TESTS RAN')
)
check(
  'python test_calc.py (functions never execute) is not a pass',
  commandResultVerdict('pytest -q', 0, false, 'no tests ran').includes('NO TESTS RAN')
)
check(
  'non-test command exit 0',
  commandResultVerdict('ls', 0, false, 'file1\nfile2') === '[RESULT] OK - exit code 0'
)
check(
  'generic failure keeps exit code',
  commandResultVerdict('make build', 2, false, 'make: *** error').includes('FAILED - exit code 2')
)

// --- formatStateDigest ---
check('empty state emits nothing', formatStateDigest({}) === '')
check(
  'modified files listed',
  formatStateDigest({ modifiedFiles: new Set(['hello.py']) }) ===
    '[STATE] files you have already changed: hello.py.\n\n'
)
{
  const line = formatStateDigest({
    modifiedFiles: new Set(['calc.py']),
    readFiles: new Set(['calc.py', 'cart.py']),
  })
  check('digest covers changed+read', line.includes('changed: calc.py') && line.includes('read: calc.py, cart.py'), line)
}
{
  const many = new Set(Array.from({ length: 15 }, (_, i) => `f${i}.py`))
  const line = formatStateDigest({ modifiedFiles: many })
  check('long lists are capped', line.includes('(+3 more)'), line)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
