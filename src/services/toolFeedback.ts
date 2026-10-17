// Pure helpers that shape the feedback text sent back to the model after
// each tool step. Kept dependency-free so e2e tests can bundle them with
// esbuild (see e2e/tool-feedback.test.mjs).

// Commands that run a test suite. Shared with the agent loop's failure
// classification so "0 tests ran" is only diagnosed on actual test runs.
export const TEST_COMMAND_RE =
  /pytest|unittest|npm test|yarn test|pnpm test|cargo test|go test|jest|vitest|mocha/i

// A canonical one-line verdict prepended to RUN_COMMAND feedback. Weak
// models misread raw output (a failing pytest run became "command not
// found"; a 0-test run became "all pass"), so the harness states the
// outcome explicitly instead of making them parse it.
export function commandResultVerdict(
  command: string,
  exitCode: number | null,
  timedOut: boolean,
  output: string,
): string {
  if (timedOut) {
    return '[RESULT] STILL RUNNING - the command did not finish before the timeout; its process continues in the Terminal panel.'
  }
  const tail = output.slice(-4000)
  const failed = /(\d+)\s+failed/i.exec(tail)?.[1]
  const passed = /(\d+)\s+passed/i.exec(tail)?.[1]
  const counts = [failed && `${failed} failed`, passed && `${passed} passed`]
    .filter(Boolean)
    .join(', ')
  const noTests =
    TEST_COMMAND_RE.test(command) &&
    !failed &&
    (/collected 0 items|no tests? (?:ran|found|collected)|^0 passed/i.test(tail) ||
      (passed !== undefined && passed === '0'))

  if (exitCode === 0) {
    if (noTests) {
      return '[RESULT] NO TESTS RAN - the command exited 0 but executed no tests. This is NOT a pass; run the suite correctly.'
    }
    return `[RESULT] OK - exit code 0${counts ? ` (${counts})` : ''}`
  }
  return `[RESULT] FAILED - exit code ${exitCode ?? 'unknown'}${counts ? ` (${counts})` : ''}`
}

// One-line harness-side record of what this agent run has already done,
// prepended to the next-turn feedback. Small models forget their own
// writes ("shall I add hello.py?" after writing it) and re-read files
// they already have - the digest answers both without trusting memory.
export function formatStateDigest(state: {
  modifiedFiles?: Set<string>
  readFiles?: Set<string>
}): string {
  const cap = (s: Set<string>) => {
    const list = [...s]
    return list.length > 12 ? `${list.slice(0, 12).join(', ')} (+${list.length - 12} more)` : list.join(', ')
  }
  const parts: string[] = []
  if (state.modifiedFiles?.size) {
    parts.push(`files you have already changed: ${cap(state.modifiedFiles)}`)
  }
  if (state.readFiles?.size) {
    parts.push(`files you have already read: ${cap(state.readFiles)}`)
  }
  return parts.length ? `[STATE] ${parts.join('; ')}.\n\n` : ''
}
