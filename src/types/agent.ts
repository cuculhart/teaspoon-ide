// One executed file/shell action inside an agent-loop step, recorded in
// the order it actually ran (writes wait for approval, so this order can
// differ from the commands' order in the model's text). Persisted with
// the message so a finished run renders as a step card instead of
// inline note lines - and so later features (scope guard, quoting
// checks) can match on structured kind/target/status rather than
// re-parsing note strings.
export interface AgentAction {
  kind: 'read' | 'list' | 'grep' | 'find' | 'write' | 'edit' | 'run' | 'close' | 'notice'
  // Localized verb phrase at write time ("Read file", "Ran")
  label: string
  // Root-relative path, search pattern, or command line. Empty for
  // notices and project-level actions.
  target: string
  // 'rejected' is reserved for user-declined approvals; policy/path
  // rejections count as 'failed'.
  status: 'ok' | 'failed' | 'rejected'
  // Short status suffix ("exit code 1", "unchanged", an error string)
  detail?: string
}
