import React, { useState, useRef, useEffect } from 'react'
import { llmService } from '../services/llmService'
import { getProvider } from '../services/providers'
import { configService } from '../services/configService'
import { managedService } from '../services/managedService'
import { projectService } from '../services/projectService'
import { Project } from '../types/project'
import { contextService } from '../services/contextService'
import { chatHistoryService, ConversationMeta } from '../services/chatHistoryService'
import FileEditApproval, { FileEdit } from './FileEditApproval'
import CommandApproval from './CommandApproval'
import ProcessApproval, { ProcessPrompt } from './ProcessApproval'
import CreateProjectModal from './CreateProjectModal'
import { i18nService, useT } from '../services/i18nService'
import { findFileCommands } from '../services/commandParser'
import { checkpointService } from '../services/checkpointService'
import {
  isPlanFileName, formatPlanDigest, newlyCheckedItems, itemFileRefs,
  refMatchesPath, justCompletedPhase, normPlanItemText, parsePlanItems,
} from '../services/planTracker'
import { OllamaEmptyResponseError } from '../services/ollamaService'
import { recommendedNumCtxForModel } from '../services/modelGuide'
import type { AgentAction } from '../types/agent'
import { commandResultVerdict, formatStateDigest, TEST_COMMAND_RE } from '../services/toolFeedback'
import { validateFileSyntax } from '../services/syntaxValidator'
import { renderMarkdown, MARKDOWN_CSS } from '../utils/markdown'
import './Chat.css'

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  // Round-trip time of the LLM call that produced this message (ms)
  latencyMs?: number
  // Model that produced this response (e.g. "ollama:qwen3.5:4b")
  model?: string
  // Token counts reported by the provider for this response
  tokens?: { input?: number; output?: number; cached?: number; doneReason?: string }
  // The model's raw output, before command blocks were replaced with
  // readable notes. Sent back as history so the model never sees the
  // "Ran: ..." note format (small models imitate it and emit fake notes).
  rawContent?: string
  // Agent-loop step: the file/shell actions this response caused, in
  // execution order. Rendered as a step card; the same events are also
  // embedded in `content` as note lines for history and legacy clients.
  actions?: AgentAction[]
  // UI-only turn (request failure, client-side warning). It is shown to
  // the user but must never be sent back to the model - as a `model`
  // role entry it would look like the AI said the error text itself.
  isError?: boolean
  // One-click recovery offer for a context-saturated empty reply: a
  // proposed num_ctx value the user can raise for this session and
  // retry with. Ollama only.
  canRaiseNumCtx?: number
  // Ask mode blocked a mutating command - offer one-click retry in
  // agent mode under the reply.
  canRetryInCodeMode?: boolean
}

const formatLatency = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

// Drop execution-note lines (▶️ Ran:, ⚠️ ..., 📖 ..., etc.) from display text.
// Used when sending legacy assistant messages back as model history.
const stripNoteLines = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*(▶️|⚠️|📖|🔍|⏭️|↩️|✅)/u.test(l))
    .join('\n')

// Turns that must stay out of model-bound history. `isError` marks
// them going forward; the heuristic catches legacy histories saved
// before the flag existed - an assistant bubble that is only an
// "Error: ..."/"エラー: ..." line, with no raw output or actions, is a
// failure bubble rather than a real model reply.
const isErrorMessage = (m: Message) =>
  m.isError === true ||
  (m.role === 'assistant' && !m.rawContent && !m.actions?.length &&
    /^(Error|エラー):\s/.test(m.content.trim()))

// Step-card row icon: the action kind for successes, the outcome for
// failures/rejections (mirrors the emoji vocabulary of the note lines).
const ACTION_ICON: Record<AgentAction['kind'], string> = {
  read: '📖', list: '📁', grep: '🔍', find: '🔍',
  write: '✏️', edit: '✏️', run: '▶️', close: '🚪', notice: '⚠️',
}
const actionIcon = (a: AgentAction) =>
  a.status === 'rejected' ? '⏭️' : a.status === 'failed' ? '⚠️' : a.status === 'pending' ? '⏳' : ACTION_ICON[a.kind]

// File bodies the model emitted sit in model-bound history as dead
// weight: once written they are on disk and re-readable, but each
// full block still consumes the context budget on EVERY later call -
// this is the dominant accumulator that pushes long implementation
// runs into context saturation (which then surfaces as truncated or
// empty replies). Reduce older blocks to their marker lines so the
// model keeps the record of WHAT it did; the freshest assistant reply
// stays intact so "continue where you stopped" still matches it.
const elideFileBlocks = (text: string) => {
  let out = text.replace(
    /((?:\/\/|:::)[ \t]*(?:WRITE_FILE|EDIT_FILE)[ \t]*:[^\n]*\n)[\s\S]*?((?:\/\/|:::)[ \t]*END_(?:WRITE_FILE|EDIT_FILE))/g,
    (_m, open, close) => `${open}(content omitted - on disk, emit READ_FILE to view)\n${close}`,
  )
  // A truncated reply leaves an opener whose body runs to the end of
  // the message - same dead weight. Elide it only when no complete END
  // marker follows, so a later intact block is never eaten.
  const tailOpen = /(?:\/\/|:::)[ \t]*(?:WRITE_FILE|EDIT_FILE)[ \t]*:[^\n]*\n/g
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = tailOpen.exec(out)) !== null) last = m
  if (last && !/(?:\/\/|:::)[ \t]*END_(?:WRITE_FILE|EDIT_FILE)/.test(out.slice(last.index + last[0].length))) {
    out = out.slice(0, last.index + last[0].length) + '(partial block omitted - the reply was cut off)'
  }
  return out
}

// Recent messages sent to the model verbatim; older turns are folded
// into the rolling contextSummary instead, keeping model input bounded.
const HISTORY_WINDOW = 20
// Compact when this many stored messages sit past the summarized range
const SUMMARY_TRIGGER = 30
const SUMMARY_TARGET_CHARS = 1500

const formatConvTime = (ts: number) => {
  const d = new Date(ts)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString()
}

interface ChatProps {
  onOpenSettings: () => void
  chatFocus?: boolean
  onToggleFocus?: () => void
}

// Resolve "." and ".." segments in a "/"-separated path so traversal
// cannot hide from the root check. Segments that would climb above the
// path's own root stay as ".." - they fail the root check anyway.
function normalizePathSegments(p: string): string {
  const leading = p.startsWith('\\\\') ? '//' : p.startsWith('/') ? '/' : ''
  const out: string[] = []
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
    } else {
      out.push(part)
    }
  }
  return leading + out.join('/')
}

// Resolve a path from the AI against the current project root.
// All file access requires an open project; anything resolving outside
// the root is rejected.
function resolveFilePath(inputPath: string): { path?: string; error?: string } {
  const trimmed = inputPath.trim().replace(/^["']|["']$/g, '')

  const project = projectService.getCurrentProject()
  if (!project || !project.isOpen) {
    // Absolute paths used to pass through here - a bare READ_FILE could
    // silently pull any file on disk (its contents go straight back to
    // the model). Writes reach this point only after the create-project
    // prompt opens a folder, so denying does not block the write flow.
    return { error: i18nService.t('No project is open - file operations are unavailable.') }
  }

  const root = project.rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\') || trimmed.startsWith('/')
  // Join and normalize first: "../x" must not survive as a string that
  // looks root-relative while the OS resolves it outside the root.
  const normalized = normalizePathSegments(isAbsolute ? trimmed : `${root}/${trimmed}`)
  // The root itself is allowed ("LIST_FILES: ." lists the project
  // root); anything resolving above it is rejected.
  const lowerRoot = root.toLowerCase()
  const lowerPath = normalized.toLowerCase()
  if (lowerPath !== lowerRoot && !lowerPath.startsWith(lowerRoot + '/')) {
    return { error: i18nService.t('Path "{path}" is outside the project root.').replace('{path}', trimmed) }
  }
  return { path: normalized }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Key for per-path run-state maps (re-read gate, SEARCH-miss streak,
// syntax-rollback count). Resolved paths already use forward slashes;
// lowercasing keeps "Script.js" and "script.js" the same file.
const gateKey = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

// Stagnation-watchdog helpers: compare consecutive model replies for
// near-duplication. Replies are normalized (case + whitespace) and
// compared on word-bigram overlap (Dice coefficient) - robust to the
// small drift local models add on each turn.
const normReply = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

function replySimilarity(a: string, b: string): number {
  if (a === b) return 1
  const grams = (s: string): Set<string> => {
    const w = s.split(' ')
    const g = new Set<string>()
    for (let i = 0; i < w.length - 1; i++) g.add(`${w[i]} ${w[i + 1]}`)
    return g
  }
  const ga = grams(a), gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let shared = 0
  for (const g of ga) if (gb.has(g)) shared++
  return (2 * shared) / (ga.size + gb.size)
}

// Resolved absolute path -> path relative to the project root (or unchanged
// when no project / outside the root)
function pathRelativeToRoot(absPath: string): string {
  const project = projectService.getCurrentProject()
  const root = project?.rootPath.replace(/\\/g, '/').replace(/\/+$/, '') ?? ''
  const norm = absPath.replace(/\\/g, '/')
  return root && norm.toLowerCase().startsWith(root.toLowerCase() + '/')
    ? norm.slice(root.length + 1)
    : norm
}

// Locate the project's plan file (L2): root-level candidates from the
// directory listing first, then a name search for nested ones. Returns
// the resolved absolute path (forward slashes), or null when the
// project has no plan file.
async function detectPlanFile(rootPath: string): Promise<string | null> {
  if (!window.electronAPI) return null
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  try {
    const res = await window.electronAPI.readDirectory(root)
    if (res.success && res.items) {
      const hit = res.items.find(i => !i.isDirectory && isPlanFileName(i.name))
      if (hit) return hit.path.replace(/\\/g, '/')
    }
    // Substring search covers both "*-plan.md" / "plan.md" and "todo.md"
    // in subdirectories; isPlanFileName filters lookalikes (myplan.md).
    for (const pat of ['plan.md', 'todo.md']) {
      const ff = await window.electronAPI.findFiles(root, pat, 20)
      const cands = (ff.files ?? []).filter(isPlanFileName)
      if (ff.success && cands.length > 0) {
        cands.sort((a, b) => a.length - b.length)
        return `${root}/${cands[0]}`
      }
    }
  } catch { /* detection is advisory - a failure just means no plan */ }
  return null
}

// The user asked for a bare file name ("index.html") but the model targets a
// subdirectory they never mentioned ("views/index.html") -> return that
// directory so the write can be redirected to the project root.
function findUnrequestedSubdir(userText: string, relPath: string): string | null {
  const parts = relPath.replace(/\\/g, '/').split('/')
  const dirs = parts.slice(0, -1).filter(p => p && p !== '.')
  if (dirs.length === 0) return null
  const basename = parts[parts.length - 1]
  const mentioned = new RegExp(`(^|[^\\w])${escapeRegExp(basename)}([^\\w]|$)`, 'i').test(userText)
  if (!mentioned) return null
  const lower = userText.toLowerCase()
  return dirs.some(d => !lower.includes(d.toLowerCase())) ? dirs.join('/') : null
}

interface RunResult {
  output: string
  exitCode: number | null
  timedOut: boolean
  // The command was an "open in browser" handled via the OS shell, not the PTY
  opened?: boolean
}

interface CommandExecutionResult {
  // Response text for display, with command blocks replaced by readable notes
  display: string
  // Results to feed back to the model for the next step (empty = done)
  feedback: string[]
  // True when the model needs the results to continue (reads/lists/failures).
  // A successful write alone does not require another turn.
  needsContinuation: boolean
  // Executed actions in execution order - drives the step-card view
  actions?: AgentAction[]
  // Snapshot of files before AI writes - enables rollback
  checkpoint?: { path: string; prevContent: string; existed: boolean }[]
  // The user explicitly bounded this run's scope and the model ended on
  // a permission question - the loop stops there instead of treating it
  // as a deferral and continuing past the user's stated boundary.
  stopAtUserBoundary?: boolean
  // Ask (read-only) mode bounced at least one mutating command back to
  // the model - the reply gets a "retry in agent mode" button.
  blockedInAskMode?: boolean
  // Full READ_FILE result bodies fed back this step - kept so a
  // saturated context can swap their copies in history/input for a
  // placeholder instead of keeping the whole file in the prompt.
  readBodies?: { path: string; text: string }[]
}

// Command parsing lives in ../services/commandParser (unit-testable there).

// Parse Aider-style SEARCH/REPLACE blocks inside an EDIT_FILE body
interface EditBlock {
  search: string
  replace: string
}

function parseEditBlocks(body: string): EditBlock[] {
  // Small models wrap blocks in ``` fences, emit delimiters with the wrong
  // run length, or drop the SEARCH/REPLACE words entirely - accept all of
  // these instead of rejecting the whole edit.
  const cleaned = body.replace(/^[ \t]*```[^\n]*$/gm, '')
  const blocks: EditBlock[] = []
  const strict = /<{3,}[ \t]*SEARCH[^\n]*\r?\n([\s\S]*?)\r?\n?={3,}[ \t]*\r?\n([\s\S]*?)\r?\n?>{3,}[ \t]*REPLACE[^\n]*/g
  let match
  while ((match = strict.exec(cleaned)) !== null) {
    blocks.push({ search: match[1], replace: match[2] })
  }
  if (blocks.length === 0) {
    // Fallback: bare delimiters, or with stray/missing SEARCH/REPLACE words
    const loose = /<{3,}[^\n]*\r?\n([\s\S]*?)\r?\n?={3,}[^\n]*\r?\n([\s\S]*?)\r?\n?>{3,}[^\n]*/g
    while ((match = loose.exec(cleaned)) !== null) {
      blocks.push({ search: match[1], replace: match[2] })
    }
  }
  return blocks
}

// Apply SEARCH/REPLACE blocks sequentially. Each SEARCH must match the
// file exactly once; CRLF files get an EOL-normalized retry so edits
// don't fail just because the model emitted LF line endings.
function applyEditBlocks(
  content: string,
  blocks: EditBlock[]
): { content?: string; error?: string; alreadyApplied?: boolean } {
  if (blocks.length === 0) {
    return { error: 'no SEARCH/REPLACE blocks found' }
  }
  const fileEol = content.includes('\r\n') ? '\r\n' : '\n'
  let out = content
  let changed = false
  let sawAlreadyApplied = false
  for (let i = 0; i < blocks.length; i++) {
    let search = blocks[i].search
    let replace = blocks[i].replace
    let idx = out.indexOf(search)
    if (idx === -1 && fileEol === '\r\n') {
      search = search.replace(/\n/g, '\r\n')
      replace = replace.replace(/\n/g, '\r\n')
      idx = out.indexOf(search)
    }
    if (idx === -1) {
      // Idempotent re-emit: models repeat an edit whose result is already
      // on disk (e.g. the same SEARCH/REPLACE sent again after a
      // successful apply). A replacement that appears exactly once means
      // the block's desired end-state holds - count it as applied rather
      // than failing the batch.
      const repIdx = replace.length > 0 ? out.indexOf(replace) : -1
      if (repIdx !== -1 && out.indexOf(replace, repIdx + 1) === -1) {
        sawAlreadyApplied = true
        continue
      }
      return { error: `SEARCH block #${i + 1} not found in the file (re-read the file and retry)` }
    }
    if (out.indexOf(search, idx + 1) !== -1) {
      return { error: `SEARCH block #${i + 1} matches multiple locations - include more surrounding context` }
    }
    out = out.slice(0, idx) + replace + out.slice(idx + search.length)
    changed = true
  }
  return { content: out, alreadyApplied: sawAlreadyApplied && !changed }
}

// A write/edit result that shrinks a non-trivial file to under half
// its size - or empties it - is almost always a fragment: the model
// sent "the first section for now" as a complete file. Blocking it
// once beats silently deleting the rest.
function looksLikeFragment(oldContent: string, newContent: string): boolean {
  if (oldContent.trim() === '') return false
  if (newContent.trim() === '') return true
  const oldLines = oldContent.split('\n').length
  return oldLines >= 20 && newContent.split('\n').length * 2 < oldLines
}

// Identifiers the scanner must never flag: language keywords and the
// calls a script can always make without a project-local definition.
const JS_NO_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do',
  'else', 'typeof', 'new', 'delete', 'void', 'in', 'of', 'instanceof',
  'await', 'yield', 'with', 'case', 'throw', 'super', 'this', 'async',
  'constructor', 'import', 'export', 'try', 'finally', 'class', 'extends',
  'const', 'let', 'var', 'static', 'get', 'set', 'default',
])
const JS_GLOBAL_CALLS = new Set([
  'alert', 'confirm', 'prompt', 'require', 'eval',
  'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout',
  'setImmediate', 'clearImmediate', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'Number', 'String', 'Boolean', 'BigInt', 'Symbol',
  'Array', 'Object', 'Date', 'Promise', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy',
  'Intl', 'fetch', 'atob', 'btoa',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
  'escape', 'unescape', 'structuredClone',
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'getComputedStyle', 'matchMedia', 'open', 'close', 'print',
  'focus', 'blur', 'scrollTo', 'scrollBy', 'postMessage',
  'Worker', 'Blob', 'URL', 'FormData', 'AbortController',
  'TextEncoder', 'TextDecoder', 'URLSearchParams', 'FileReader',
])

// A call to a function that is defined nowhere is the residue of a
// partial write - the model declares "implemented isStoneValid" while
// only the call site ever reached the disk. Scan the new content for
// bare calls whose name has no definition in the same content; a
// project-wide grep afterwards decides whether the definition lives
// elsewhere. Advisory only - heuristics, not a compiler.
function findUndefinedCallees(content: string): string[] {
  // Strip comments so prose like "// call isStoneValid here" cannot
  // register a phantom call site.
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
  const defs = new Set<string>()
  const addAll = (re: RegExp, gi = 1) => {
    for (const m of stripped.matchAll(re)) defs.add(m[gi])
  }
  // function f / class F / const|let|var f / f: / f = / f() { method shorthand / f =>
  addAll(/\b(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/g)
  addAll(/\b([A-Za-z_$][\w$]*)\s*[:=]/g)
  addAll(/\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)
  // Any identifier on an import line counts as defined (import {a, b}).
  for (const m of stripped.matchAll(/^[^\n]*\bimport\b[^\n]*$/gm)) {
    for (const w of m[0].matchAll(/\b[A-Za-z_$][\w$]*\b/g)) defs.add(w[0])
  }
  const suspects = new Set<string>()
  for (const m of stripped.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]
    if (defs.has(name) || JS_NO_CALL.has(name) || JS_GLOBAL_CALLS.has(name)) continue
    // PascalCase reads as a constructor/class, not a project helper.
    if (!/^[a-z]/.test(name)) continue
    suspects.add(name)
  }
  return [...suspects].slice(0, 5)
}

// Parse and execute file commands from AI response.
// Reads/lists run immediately; writes are collected and held until the
// user approves them via the approval callback.
// Returns display text (commands replaced by readable notes) and
// results to send back to the model so it can continue its work.
async function parseAndExecuteFileCommands(
  response: string,
  requestApproval: (edits: FileEdit[], note?: string) => Promise<FileEdit[] | null>,
  requestCommandApproval: (commands: string[], note?: string) => Promise<string[] | null>,
  runCommandAndWait: (command: string) => Promise<RunResult>,
  userText: string,
  requestProject?: () => Promise<string | null>,
  // Process-approval prompts (L5): phase transitions and repeated-
  // failure decisions ask the user about the approach, not a diff.
  requestProcessApproval?: (prompt: ProcessPrompt) => Promise<string | null>,
  state?: {
    editFailCount: number
    unresolvedFailure: boolean
    // A file write/edit that failed and was never retried. Tracked
    // separately from unresolvedFailure because a successful RUN_COMMAND
    // must not clear it - otherwise the model can abandon a failed edit,
    // run tests, and falsely report the change as done.
    unresolvedEdit?: boolean
    // Consecutive RUN_COMMAND failures - used to stop the model from
    // probing alternate interpreters/paths when a result is just a
    // test failure.
    runFailStreak?: number
    // Successful file edits so far; a test command failing before any
    // edit means the failure is pre-existing, not a regression.
    editsApplied?: number
    // WRITE/EDIT commands parsed this run (attempted, not necessarily
    // applied) - lets the run-end disclosure distinguish "every change
    // failed" from "the model never emitted a write command".
    editsAttempted?: number
    lastRunFailure?: { command: string; exitCode: number | null; timedOut: boolean; tail: string } | null
    preEditTestFailure?: { command: string; tail: string } | null
    // Files read so far this run (absolute path -> content). A repeat
    // READ_FILE with unchanged content gets a short-circuit reply instead
    // of the full text - models re-read files they already have and each
    // re-read costs a full prefill on local inference.
    readCache?: Map<string, string>
    // Paths (root-relative) for the next-turn state digest: files the
    // model has read and files it has successfully changed.
    readFiles?: Set<string>
    modifiedFiles?: Set<string>
    // The "code shown but not written" nudge fires at most once per run.
    codeShownNudged?: boolean
    // The last model reply was cut off by the output/context token
    // limit (done_reason 'length'). Malformed-block feedback then tells
    // the model to shrink its next output instead of resending the same
    // size block that truncated before.
    lastTurnTruncated?: boolean
    // Root-relative paths whose earlier READ_FILE result body was elided
    // from model-bound history. A repeat read must return full content -
    // the "unchanged" shortcut would point at content the model cannot
    // see any more.
    elidedReads?: Set<string>
    // Paths already warned about a drastic-shrink write/edit this run.
    // A resend after the block counts as an intentional rewrite.
    shrinkWarned?: Set<string>
    // Syntax-validation rollbacks per file this run; past a small cap
    // the writes keep being rolled back but the feedback warns louder.
    syntaxRollbacks?: Map<string, number>
    // Consecutive SEARCH-miss EDIT_FILE failures per resolved path. At 2
    // the path enters readGate and stays until a READ_FILE succeeds -
    // small models otherwise retry the same stale edit forever (the
    // "re-read and retry" instruction is reliably ignored).
    searchFailStreak?: Map<string, number>
    // Paths whose next WRITE/EDIT is held until the model reads the
    // file again - enforced before the approval dialog ever opens.
    readGate?: Set<string>
    // Paths already warned about for context-heavy READ_FILE results
    // (one advisory per file per run is enough).
    largeReadWarned?: Set<string>
    // Context-window size the run's provider works with (0 = unknown /
    // not applicable). Drives the large-read advisory threshold.
    numCtxLimit?: number
    // Consecutive write/edit/validation failures per resolved path -
    // at the threshold the user picks continue/change-approach/skip.
    pathFailStreak?: Map<string, number>
    // Paths the user chose to skip - further writes/edits bounce back.
    pathSkipped?: Set<string>
    // A plan phase just completed - the agent loop consumes this and
    // asks the user before the next phase starts.
    phaseGate?: { file: string; done: string; next: string } | null
    // Phase keys ("file:title") whose transition was already gated.
    phaseGatesFired?: Set<string>
    // Plan-file driven mode (L2). planPath: detected/written plan file
    // (absolute); planScanDone: detection ran already this run.
    planPath?: string | null
    planScanDone?: boolean
    // Files whose latest applied change passed every check the harness
    // runs (applied + syntax OK + no missing-callee note). A "- [x]"
    // plan mark is trusted only when it maps to one of these.
    verifiedFiles?: Set<string>
    // Plan items already warned about for an unverified "- [x]".
    planWarnedItems?: Set<string>
  },
  // Ask (read-only) mode: WRITE_FILE/EDIT_FILE/RUN_COMMAND/CLOSE_PROJECT
  // are blocked before any approval prompt or disk/shell access.
  readOnly?: boolean,
  // Called each time an action lands so the step card grows live instead
  // of appearing only after every command in the step has finished.
  onAction?: (actions: AgentAction[]) => void
): Promise<CommandExecutionResult> {
  const { commands, docSpans } = findFileCommands(response)

  // The model's prose minus command blocks. Approval dialogs hide the
  // chat behind a modal, so the user would otherwise approve a diff or
  // a shell command without ever seeing the model's stated intent -
  // surface this text inside the dialog itself.
  const proseParts: string[] = []
  {
    let pc = 0
    for (const cmd of commands) {
      if (cmd.start > pc) proseParts.push(response.slice(pc, cmd.start))
      pc = Math.max(pc, cmd.end)
    }
    proseParts.push(response.slice(pc))
  }
  const approvalNote = proseParts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    .slice(0, 4000)

  // Text inside WRITE_FILE/EDIT_FILE blocks is file content, not commands -
  // mask it so mentions like "// WRITE_FILE:" in a README don't trigger the
  // malformed/invented checks. Documented syntax (code fences, "<...>"
  // placeholder args) is masked for the same reason.
  const mask = (s: string, [a, b]: [number, number]) =>
    s.slice(0, a) + ' '.repeat(b - a) + s.slice(b)
  const scanText = [...docSpans,
    ...commands
      .filter(c => c.type === 'write' || c.type === 'edit')
      .map(c => [c.start, c.end] as [number, number]),
  ].reduce(mask, response)

  // Small models sometimes open a WRITE_FILE/EDIT_FILE block but close it
  // with the wrong terminator (e.g. // END_EDIT_FILE) or none at all (a
  // truncated/streaming-aborted response). The block then parses as
  // nothing and would be silently shown as raw text - report it back so
  // the model can re-emit a complete block. Successfully parsed write/
  // edit commands are masked out of scanText, so any opener still visible
  // there is dangling by definition - no need to check whether ANY write
  // or edit parsed (a successful index.html write must not hide a
  // truncated script.js block).
  const malformedBlocks: string[] = []
  const malformedDetails: string[] = []
  const malformedArgs: string[] = []
  // For each dangling opener, extract the target path and the tail of the
  // partial body. Without this the model rewrites the file from memory
  // and silently drops whatever it hadn't emitted yet (e.g. helper
  // functions at the end of a large file).
  const collectDangling = (name: 'WRITE_FILE' | 'EDIT_FILE') => {
    const re = new RegExp(`(?:^|\\n)[ \\t]*(?:\\/\\/|:::)[ \\t]*${name}[ \\t]*:[ \\t]*([^\\n]*)`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(scanText)) !== null) {
      malformedBlocks.push(name)
      const arg = m[1].trim() || '<unknown>'
      malformedArgs.push(arg)
      const rest = scanText.slice(m.index + m[0].length)
      const bodyLines = rest.split('\n').filter(l => l.trim().length > 0)
      const tail = bodyLines.slice(-8).map(l => l.trimEnd()).join('\n')
      malformedDetails.push(
        `${name} ${arg}: your previous response was cut off mid-block after ~${bodyLines.length} line(s).` +
        (tail ? ` The last lines you emitted were:\n${tail}` : '')
      )
    }
  }
  collectDangling('WRITE_FILE')
  collectDangling('EDIT_FILE')

  // Invented commands like "// CREATE_INDEX.HTML" - the model made up its own
  // grammar. Only names containing "_" or "." count (plain "// TODO"-style
  // comments are ignored), and known command names/terminators are excluded.
  const KNOWN_COMMAND_NAMES = new Set([
    'WRITE_FILE', 'EDIT_FILE', 'READ_FILE', 'LIST_FILES', 'RUN_COMMAND',
    'GREP', 'FIND_FILES', 'CLOSE_PROJECT', 'END_WRITE_FILE', 'END_EDIT_FILE',
  ])
  const inventedCmds = [...new Set(
    (scanText.match(/^(?:\/\/|:::)[ \t]*[A-Z][A-Z0-9_.-]*(?=[ \t:]|$)/gm) ?? [])
      .map(m => m.replace(/^(?:\/\/|:::)[ \t]*/, '').replace(/[ \t:].*$/, '').trim())
      .filter(name => (name.includes('_') || name.includes('.'))
        && !KNOWN_COMMAND_NAMES.has(name)
        // "// END_READ_FILE"-style invented terminators are harmless - the
        // command itself already parsed (or is caught as a malformed block).
        && !name.startsWith('END_'))
  )]

  // Truncated command names: a cut-off "// READ" or "// WRITE: x" is a
  // proper prefix of READ_FILE/WRITE_FILE, and "READFILE" is the same
  // name with the underscore dropped. The invented scan above ignores
  // names without "_" or "." (so plain "// TODO" comments stay inert),
  // which lets these pass as prose while the model waits for a result
  // that never comes. Flag them only when the rest of the line is empty
  // or a single token - "// WRITE your code here" stays text.
  const KNOWN_SQUASHED = new Set([...KNOWN_COMMAND_NAMES].map(k => k.replace(/_/g, '')))
  const truncatedCmds = new Set<string>()
  for (const m of scanText.matchAll(/^(?:\/\/|:::)[ \t]*([A-Z][A-Z0-9]*)[ \t]*:?[ \t]*(\S[^\n]*)?$/gm)) {
    const name = m[1]
    const rest = (m[2] ?? '').trim()
    if (KNOWN_COMMAND_NAMES.has(name) || name.startsWith('END_')) continue
    // The name regex stops at "_", so "END_WRITE_FILE" reads as
    // name=END, rest=_WRITE_FILE. Underscored tokens are the invented
    // scan's job (or a parsed terminator) - leave them alone.
    if (rest.startsWith('_')) continue
    const isVariant = KNOWN_SQUASHED.has(name)
      || [...KNOWN_COMMAND_NAMES].some(k => k.startsWith(name))
    if (!isVariant || /\s/.test(rest)) continue
    truncatedCmds.add(name)
  }
  if (truncatedCmds.size > 0) inventedCmds.push(...truncatedCmds)

  // Two more small-model failure modes worth retrying instead of showing raw:
  // (a) the model echoes the app's own "Command execution results:" wrapper
  //     as if it were the app, and
  // (b) it answers a file-creation request by showing a markdown code fence
  //     (with or without prose), which never reaches the disk.
  const echoingResults = /^\s*Command execution results:/.test(response)
  const hasFence = response.includes('```')

  // A model that writes part of the requested files then ends the turn
  // with "say 'continue' and I'll emit the rest" forces a useless user
  // round-trip - the agent loop can continue by itself. Detect the
  // deferral (ja/en phrasings that ask the user to prompt continuation)
  // and carry on. Ordinary closings like "質問があればお知らせください"
  // don't match because they lack a continuation phrase up front.
  const JA_DEFERRAL =
    /(?:次の応答|次回の応答|次のメッセージ|続きを|続けて|残りの).{0,60}?(?:お知らせください|教えてください|言ってください|進めてください)|(?:進めてください|続けてください|続きをどうぞ)/u
  const EN_DEFERRAL =
    /\b(?:in the next (?:response|message|turn)|next response|say (?:the word )?["']?continue["']?|shall (?:I|we) (?:continue|proceed|implement|create|write|add|start)|to (?:continue|proceed)[,.]? (?:just )?(?:let me know|say)|let me know.{0,40}(?:continue|proceed|go ahead))/i
  // Polite work-offer endings defer the same way: "〜を作成します。
  // よろしいでしょうか？" or "〜に取り掛かりましょうか？" announce the next
  // unit of work and wait for a confirmation the loop does not need.
  // Small local models emit one file per turn and stop this way.
  const JA_WORK_OFFER =
    /(?:取り掛か|取りかか|着手|開始|作成|作り|書き|実装|記述|実行|進め|続け|修正|変更|追加|対応|仕上げ|確認|実施|始め)(?:り|し)?ましょうか/u
  const JA_ANNOUNCE_THEN_ASK =
    /(?:取り掛か|取りかか|着手|作成|作製|実装|記述|実行|進め|続け|修正|変更|追加|対応|仕上げ|確認|実施)(?:り|し|いたし)?ます[^。]{0,30}。\s*(?:よろしい|いかが|よい|いい|大丈夫)でしょうか/u
  // Declarative next-work endings defer the same way without asking:
  // "次に script.js を実装します" / "次はフェーズ2に進めます" announce
  // unfinished work then stop. The 次/今後/残り marker plus a work verb
  // in declarative (non-question) form is the signal - past tense and
  // user-instructions ("〜してください") are excluded by the endings.
  const JA_NEXT_WORK =
    /(?:次[にのは、\s]|今後|残り|以降)[^。！？\n]{0,60}(?:実装|進め|進み|着手|取り掛か|取りかか|作成|作製|作り|開発|継続|対応|修正|追加|実施|確認|説明)(?:り|し|ていき|る|ましょ|ま)?(?:ます|す|ましょう|う|です|でしょう|予定|べき)/u
  const EN_NEXT_WORK =
    /\b(?:next,?|then,?|I(?:'ll| will| shall) (?:now )?|let me (?:now )?|we(?:'ll| will) (?:now )?)\s*(?:implement|proceed|continue|create|write|add|start|build|move on|work on)/i
  const deferred = JA_DEFERRAL.test(scanText) || EN_DEFERRAL.test(scanText)
    || JA_WORK_OFFER.test(scanText) || JA_ANNOUNCE_THEN_ASK.test(scanText)
    || JA_NEXT_WORK.test(scanText) || EN_NEXT_WORK.test(scanText)

  // User-scoped stop: when the request explicitly bounded the work
  // ("ステップ1のみ", "stop after X", "do not proceed"), a reply ending
  // with a permission question is a legitimate stop point - otherwise
  // the feedback-driven continuation steamrolls the user's boundary
  // (observed: "のみ…停止してください" ignored across several more
  // command turns). Both conditions are required: a scope marker alone
  // is too loose, and unanswered questions mid-run are normal.
  const USER_SCOPED_STOP =
    /(?:のみ|だけ|まで|停止|止めて|止まれ|止まって|進んではいけ|進まない|超えないで|\bonly\b|\bjust\b|\bstop\b|\bhalt\b|do not (?:continue|proceed)|don't (?:continue|proceed))/i
  const replyTail = response.trim().slice(-160)
  const ASKS_PERMISSION =
    /[?？]\s*$/.test(replyTail) ||
    // Japanese models close polite questions with 。 too
    // ("実装してもよろしいでしょうか。") - a bare "か。" tail is a
    // question. Scoped-only via USER_SCOPED_STOP, so a stray
    // declarative "か。" costs at most an early stop.
    /か[？?。]?\s*$/.test(replyTail) ||
    /(?:お知らせください|お待ちしています|待っています|教えてください|連絡ください|聞かせてください|let me know|waiting for (?:you|your)|awaiting your)\s*[。.\s]*$/i.test(replyTail)
  let stopAtUserBoundary = USER_SCOPED_STOP.test(userText) && ASKS_PERMISSION
  // "how is X created" / "where is X written" are questions, not
  // file-creation requests - a fenced snippet there is an explanation.
  // Missing a real nudge is cheap; a false one burns a paid turn.
  const creationIntent = /(作成|作って|作る|生成|実装|create|write|generate|make|build)/i.test(userText)
    && !/(方法|作り方|作りかた|やり方|手順|書き方|教えて|書かれ|記載さ|記述さ|どうやって|どうすれば|how to|how do|how can|what is|where is)/i.test(userText)
  // A model that still shows a fence after being told is displaying it on
  // purpose (e.g. a shell example) - re-nudging wastes a step.
  const codeShownNudge = commands.length === 0 && creationIntent && hasFence && !readOnly && !state?.codeShownNudged

  if (commands.length === 0 && malformedBlocks.length === 0 && inventedCmds.length === 0
    && !echoingResults && !deferred && !codeShownNudge) {
    return { display: response, feedback: [], needsContinuation: false }
  }
  if (!window.electronAPI) {
    return { display: response + '\n\n(Error: Electron API not available)', feedback: [], needsContinuation: false }
  }

  const notes: (string | null)[] = new Array(commands.length).fill(null)
  const feedback: string[] = []
  const readBodies: { path: string; text: string }[] = []
  // Structured mirror of the note lines: one entry per executed action,
  // in the order it actually ran (writes run after reads regardless of
  // their position in the model's text).
  const actions: AgentAction[] = []
  const pushAction = (a: AgentAction) => {
    actions.push(a)
    onAction?.(actions)
  }
  const checkpoint: { path: string; prevContent: string; existed: boolean }[] = []
  let needsContinuation = false

  // Repeated-failure process gate (L5): the same file failing its
  // write/edit/validation over and over means the model is stuck on
  // this item - the failure loop cannot fix itself. The user decides:
  // keep trying, change approach, or skip the item.
  const notePathFailure = async (absPath: string) => {
    if (!state) return
    const k = gateKey(absPath)
    const n = (state.pathFailStreak?.get(k) ?? 0) + 1
    state.pathFailStreak?.set(k, n)
    if (n < 3 || !requestProcessApproval) return
    state.pathFailStreak?.set(k, 0)
    const rel = pathRelativeToRoot(absPath)
    const choice = await requestProcessApproval({
      title: i18nService.t('Repeated failure'),
      body: i18nService.t('Changes to "{path}" have failed {count} times in a row. How should the work proceed?')
        .replace('{path}', rel).replace('{count}', String(n)),
      options: [
        { id: 'continue', label: i18nService.t('Keep trying') },
        { id: 'approach', label: i18nService.t('Change approach') },
        { id: 'skip', label: i18nService.t('Skip this item') },
      ],
      note: approvalNote || null,
    })
    if (choice === 'skip') {
      state.pathSkipped?.add(k)
      pushAction({ kind: 'notice', label: i18nService.t('Skipped at user request'), target: rel, status: 'rejected' })
      feedback.push(
        `NOTE: the user chose to SKIP work on ${rel} - do not emit further WRITE_FILE/EDIT_FILE for it. ` +
        `Move on to other items, or report this one as skipped in your final answer.`
      )
    } else if (choice === 'approach') {
      feedback.push(
        `NOTE: the user asked you to CHANGE APPROACH on ${rel}. Do not repeat the same edit - ` +
        `try a different method (a different SEARCH anchor, a short WRITE_FILE rewrite, or a different fix entirely).`
      )
    } else {
      // 'continue' - and a dismissed dialog - both mean keep going.
      feedback.push(`NOTE: the user chose to continue - keep working on ${rel}.`)
    }
  }

  // No project open but the model wants to write files: offer to create
  // a project folder instead of rejecting every command. When the user
  // creates one, path resolution below picks it up via projectService.
  if (requestProject && !readOnly && !projectService.getCurrentProject()?.isOpen
    && commands.some(c => c.type === 'write' || c.type === 'edit')) {
    if (await requestProject()) {
      feedback.push('A project folder was created and opened - file paths are relative to its root.')
    }
  }

  // Protocol-level problems (truncated blocks, invented commands,
  // deferrals) become notice rows in the step card - they explain why
  // the run needed another turn.
  if (malformedBlocks.length > 0) {
    feedback.push(
      `Malformed command block(s): ${[...new Set(malformedBlocks)].join(', ')}. ` +
      'A WRITE_FILE block must end with "// END_WRITE_FILE" and an EDIT_FILE block with "// END_EDIT_FILE". ' +
      'Emit the complete block again with the correct terminator - do not omit any part of the file.' +
      // A token-limit cut means the SAME resend truncates again - the
      // model must shrink this turn's output, not repeat the block.
      (state?.lastTurnTruncated
        ? ' Your reply hit the output token limit - keep this turn SHORT: minimal prose, and emit file content in small pieces (a few EDIT_FILE blocks at a time, or WRITE_FILE a first part then append with EDIT_FILE).'
        : '') +
      (malformedDetails.length ? `\n${malformedDetails.join('\n')}` : '')
    )
    pushAction({ kind: 'notice', label: i18nService.t('Incomplete command block - asking the model to retry'), target: '', status: 'failed' })
    needsContinuation = true
    // A dangling write/edit is a failed attempt on that path - count it
    // toward the repeated-failure gate. Token-limit resends of the same
    // oversized block reliably truncate again (observed on a real run:
    // the model re-emitted the identical ~300-line WRITE_FILE twice in a
    // row despite the split guidance), so the loop needs the user, not
    // another blind retry.
    for (const arg of malformedArgs) {
      const r = resolveFilePath(arg)
      if (r.path) await notePathFailure(r.path)
    }
  }
  if (inventedCmds.length > 0) {
    feedback.push(
      `Unknown command(s): ${inventedCmds.map(c => `// ${c}`).join(', ')}. ` +
      'Valid commands are "// WRITE_FILE:", "// EDIT_FILE:", "// READ_FILE:", "// LIST_FILES:", "// GREP:", "// FIND_FILES:", "// RUN_COMMAND:", "// CLOSE_PROJECT" ' +
      '(WRITE_FILE/EDIT_FILE blocks close with "// END_WRITE_FILE" / "// END_EDIT_FILE"). ' +
      'To create a file, emit "// WRITE_FILE: <file_path>", the content, then "// END_WRITE_FILE".'
    )
    pushAction({ kind: 'notice', label: i18nService.t('Unknown command - asking the model to retry'), target: inventedCmds.map(c => `// ${c}`).join(', '), status: 'failed' })
    needsContinuation = true
  }
  if (echoingResults) {
    feedback.push(
      'The "Command execution results:" block is generated by the app, not by you - do not repeat it. ' +
      'Respond as the assistant: emit the corrected file command or answer the user.'
    )
    pushAction({ kind: 'notice', label: i18nService.t('Result block imitated - asking the model to retry'), target: '', status: 'failed' })
    needsContinuation = true
  }
  // In a user-scoped run a deferral after applied work is the user's
  // stop line, not a stall ("4.1だけ" + "次は4.2に進みます" crosses the
  // boundary the user drew - observed). The write batch decides it
  // below: a deferral with nothing applied stays an anti-stall
  // continuation.
  const deferralBoundaryPending = deferred && !stopAtUserBoundary && USER_SCOPED_STOP.test(userText)
  if (deferred && !stopAtUserBoundary && !deferralBoundaryPending) {
    feedback.push(
      'You ended your turn asking the user to say "continue" (or similar) before emitting the rest of the work. ' +
      'Do not wait for the user - continue NOW in this response and emit the remaining file commands or output you listed.'
    )
    pushAction({ kind: 'notice', label: i18nService.t('Deferred to a later response - asking the model to continue now'), target: '', status: 'failed' })
    needsContinuation = true
  }
  if (stopAtUserBoundary) {
    pushAction({ kind: 'notice', label: i18nService.t("Stopped at the model's question - reply to continue"), target: '', status: 'ok' })
  }
  if (codeShownNudge) {
    feedback.push(
      'You showed code inside a markdown code fence - fenced lines are shown to the user as text and never executed, so nothing was written to disk. ' +
      'Emit the command OUTSIDE any code fence: "// WRITE_FILE: <file_path>", the content, then "// END_WRITE_FILE".'
    )
    pushAction({ kind: 'notice', label: i18nService.t('Code shown but not written - asking the model to retry'), target: '', status: 'failed' })
    if (state) state.codeShownNudged = true
    needsContinuation = true
  }
  // A block can be syntactically valid yet still burn most of the
  // output budget - giant write/edit bodies are exactly what gets
  // truncated next turn. The command is executed as-is; the advisory
  // only steers the model to split the NEXT one.
  const hugeCmd = commands.find(c =>
    (c.type === 'write' || c.type === 'edit')
    && (c.body?.split('\n').length ?? 0) >= 80)
  if (hugeCmd) {
    const name = hugeCmd.type === 'write' ? 'WRITE_FILE' : 'EDIT_FILE'
    feedback.push(
      `${name} ${hugeCmd.arg}: that block was ~${hugeCmd.body!.split('\n').length} lines long. ` +
      `Large blocks risk being cut off by the output limit before they finish - ` +
      `next time split the work into smaller pieces ` +
      `(several small SEARCH/REPLACE pairs, or a short WRITE_FILE part appended with EDIT_FILE).`
    )
    pushAction({ kind: 'notice', label: i18nService.t('Large block - asking the model to split future work'), target: hugeCmd.arg, status: 'ok' })
  }
  const pendingWrites: { index: number; path: string; arg: string; body: string }[] = []
  const pendingEdits: { index: number; path: string; arg: string; body: string }[] = []
  const pendingRuns: { index: number; command: string }[] = []
  let blockedInAskMode = false

  if (state) {
    state.editsAttempted = (state.editsAttempted ?? 0) +
      commands.filter(c => c.type === 'write' || c.type === 'edit').length
  }

  // First pass: run reads/lists, collect writes for approval
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]

    // Ask (read-only) mode: mutating commands never reach approval,
    // disk, or the shell - they bounce back to the model as feedback.
    if (readOnly && (cmd.type === 'write' || cmd.type === 'edit' || cmd.type === 'run' || cmd.type === 'close')) {
      const name = cmd.type === 'write' ? 'WRITE_FILE'
        : cmd.type === 'edit' ? 'EDIT_FILE'
        : cmd.type === 'run' ? 'RUN_COMMAND' : 'CLOSE_PROJECT'
      notes[i] = `🚫 ${i18nService.t('Blocked (ask mode)')}: ${name}`
      pushAction({ kind: 'notice', label: i18nService.t('Blocked (ask mode)'), target: `${name} ${cmd.arg}`.trim(), status: 'failed' })
      feedback.push(
        `${name} ${cmd.arg}: blocked - ask (read-only) mode is active. ` +
        'WRITE_FILE, EDIT_FILE, RUN_COMMAND, and CLOSE_PROJECT are disabled. ' +
        'Do not emit them again - answer the user in text; if a change is needed, ' +
        'describe it or show the suggested code inside a markdown code fence.'
      )
      needsContinuation = true
      blockedInAskMode = true
      continue
    }

    const resolved = resolveFilePath(cmd.arg)

    if (cmd.type === 'write') {
      if (resolved.error || !resolved.path) {
        notes[i] = `⚠️ ${i18nService.t('Rejected write to')} ${cmd.arg}: ${resolved.error}`
        pushAction({ kind: 'write', label: i18nService.t('Rejected write to'), target: cmd.arg, status: 'failed', detail: resolved.error })
        feedback.push(`WRITE_FILE ${cmd.arg}: rejected - ${resolved.error}`)
        needsContinuation = true
      } else if (state?.pathSkipped?.has(gateKey(resolved.path))) {
        // The user chose "skip" on this item at the repeated-failure
        // gate - bounce further writes to it back to the model.
        const rel = pathRelativeToRoot(resolved.path)
        notes[i] = `⏭️ ${i18nService.t('Skipped at user request')}: WRITE_FILE ${rel}`
        pushAction({ kind: 'notice', label: i18nService.t('Skipped at user request'), target: rel, status: 'rejected' })
        feedback.push(
          `WRITE_FILE ${rel}: rejected - the user chose to skip this item. ` +
          `Do not emit further writes/edits to it; move on to other work or report it as skipped.`
        )
        needsContinuation = true
      } else if (state?.readGate?.has(gateKey(resolved.path))) {
        // Re-read gate: repeated SEARCH misses mean the model's copy of
        // this file is stale. Hold every write/edit to it until a
        // READ_FILE succeeds - enforced here so the command never
        // reaches the approval dialog (instructions alone get ignored).
        const rel = pathRelativeToRoot(resolved.path)
        notes[i] = `⏭️ ${i18nService.t('Held until the file is re-read')}: WRITE_FILE ${rel}`
        pushAction({ kind: 'notice', label: i18nService.t('Held until the file is re-read'), target: rel, status: 'failed' })
        feedback.push(
          `WRITE_FILE ${rel}: held - your earlier edits to this file kept missing their SEARCH text, ` +
          `which means your copy of it is stale. Emit "// READ_FILE: ${rel}" first and base the next ` +
          `change on the content it returns.`
        )
        needsContinuation = true
      } else {
        const rel = pathRelativeToRoot(resolved.path)
        const strayDir = findUnrequestedSubdir(userText, rel)
        if (strayDir) {
          const base = rel.split('/').pop() ?? cmd.arg
          notes[i] = `⚠️ ${i18nService.t('Rejected write to')} ${cmd.arg}: ${i18nService.t('subdirectory was not requested')}`
          pushAction({ kind: 'write', label: i18nService.t('Rejected write to'), target: cmd.arg, status: 'failed', detail: i18nService.t('subdirectory was not requested') })
          feedback.push(
            `WRITE_FILE ${cmd.arg}: rejected - the user asked for "${base}" with no directory; ` +
            `"${strayDir}/" was never requested. Emit "// WRITE_FILE: ${base}" to write it at the project root instead.`
          )
          needsContinuation = true
        } else {
          pendingWrites.push({ index: i, path: resolved.path, arg: cmd.arg, body: cmd.body ?? '' })
        }
      }
    } else if (cmd.type === 'edit') {
      if (resolved.error || !resolved.path) {
        notes[i] = `⚠️ ${i18nService.t('Rejected edit to')} ${cmd.arg}: ${resolved.error}`
        pushAction({ kind: 'edit', label: i18nService.t('Rejected edit to'), target: cmd.arg, status: 'failed', detail: resolved.error })
        feedback.push(`EDIT_FILE ${cmd.arg}: rejected - ${resolved.error}`)
        needsContinuation = true
      } else if (state?.pathSkipped?.has(gateKey(resolved.path))) {
        // Same user-skip gate as WRITE_FILE above.
        const rel = pathRelativeToRoot(resolved.path)
        notes[i] = `⏭️ ${i18nService.t('Skipped at user request')}: EDIT_FILE ${rel}`
        pushAction({ kind: 'notice', label: i18nService.t('Skipped at user request'), target: rel, status: 'rejected' })
        feedback.push(
          `EDIT_FILE ${rel}: rejected - the user chose to skip this item. ` +
          `Do not emit further writes/edits to it; move on to other work or report it as skipped.`
        )
        needsContinuation = true
      } else if (state?.readGate?.has(gateKey(resolved.path))) {
        // Same re-read gate as WRITE_FILE above.
        const rel = pathRelativeToRoot(resolved.path)
        notes[i] = `⏭️ ${i18nService.t('Held until the file is re-read')}: EDIT_FILE ${rel}`
        pushAction({ kind: 'notice', label: i18nService.t('Held until the file is re-read'), target: rel, status: 'failed' })
        feedback.push(
          `EDIT_FILE ${rel}: held - your earlier edits to this file kept missing their SEARCH text, ` +
          `which means your copy of it is stale. Emit "// READ_FILE: ${rel}" first and base the next ` +
          `change on the content it returns.`
        )
        needsContinuation = true
      } else {
        pendingEdits.push({ index: i, path: resolved.path, arg: cmd.arg, body: cmd.body ?? '' })
      }
    } else if (cmd.type === 'run') {
      const project = projectService.getCurrentProject()
      if (!project?.isOpen) {
        notes[i] = `⚠️ ${i18nService.t('No project is open; cannot run commands.')}`
        pushAction({ kind: 'run', label: i18nService.t('Ran'), target: cmd.arg, status: 'failed', detail: i18nService.t('no project open') })
        feedback.push(`RUN_COMMAND ${cmd.arg}: failed - no project open`)
        needsContinuation = true
      } else {
        pendingRuns.push({ index: i, command: cmd.arg })
      }
    } else if (cmd.type === 'close') {
      needsContinuation = true
      const project = projectService.getCurrentProject()
      if (!project?.isOpen) {
        notes[i] = `⚠️ ${i18nService.t('No project is open; cannot close.')}`
        pushAction({ kind: 'close', label: i18nService.t('Close Project'), target: '', status: 'failed', detail: i18nService.t('no project open') })
        feedback.push('CLOSE_PROJECT: failed - no project open')
      } else {
        // Same cleanup as File > Close Project, but without the
        // app-menu path - that one remounts Chat and would orphan this
        // in-flight agent loop. The project-opened event lets the
        // Explorer and editor clear themselves instead. Reversible and
        // non-destructive, so no approval.
        window.electronAPI?.unwatchProject?.()
        projectService.closeProject()
        contextService.clearContext()
        configService.setLastProjectPath('')
        configService.setLastOpenFile('')
        window.dispatchEvent(new CustomEvent('teaspoon:project-opened', { detail: { rootPath: null } }))
        notes[i] = `✅ ${i18nService.t('Closed project')}`
        pushAction({ kind: 'close', label: i18nService.t('Closed project'), target: '', status: 'ok' })
        feedback.push('CLOSE_PROJECT: the project is now closed. Any further file commands will fail - finish your answer.')
      }
    } else if (cmd.type === 'grep' || cmd.type === 'find') {
      // Content/path search across the whole project - no path resolution needed
      needsContinuation = true
      const project = projectService.getCurrentProject()
      if (!project?.isOpen) {
        notes[i] = `⚠️ ${i18nService.t('No project is open; cannot search.')}`
        pushAction({ kind: cmd.type === 'grep' ? 'grep' : 'find', label: cmd.type === 'grep' ? i18nService.t('Searched') : i18nService.t('Found'), target: `"${cmd.arg}"`, status: 'failed', detail: i18nService.t('no project open') })
        feedback.push(`${cmd.type === 'grep' ? 'GREP' : 'FIND_FILES'} ${cmd.arg}: failed - no project open`)
        continue
      }
      try {
        if (cmd.type === 'grep') {
          const result = await window.electronAPI.searchFiles(project.rootPath, cmd.arg)
          if (result.success && result.matches) {
            notes[i] = `🔍 ${i18nService.t('Searched')} "${cmd.arg}": ${result.matches.length} ${i18nService.t('match(es)')}`
            pushAction({ kind: 'grep', label: i18nService.t('Searched'), target: `"${cmd.arg}"`, status: 'ok', detail: `${result.matches.length} ${i18nService.t('match(es)')}` })
            const body = result.matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n')
            feedback.push(`GREP ${cmd.arg} result (${result.matches.length} matches${result.truncated ? ', truncated' : ''}):\n${body || '(no matches)'}` +
              (result.matches.length === 0 ? '\nHint: nothing matched. The pattern may be too specific - try a single word, or READ_FILE the file you expect it in.' : ''))
          } else {
            notes[i] = `⚠️ ${i18nService.t('Search failed for')} "${cmd.arg}": ${result.error}`
            pushAction({ kind: 'grep', label: i18nService.t('Searched'), target: `"${cmd.arg}"`, status: 'failed', detail: `${result.error}` })
            feedback.push(`GREP ${cmd.arg}: failed - ${result.error}`)
          }
        } else {
          const result = await window.electronAPI.findFiles(project.rootPath, cmd.arg)
          if (result.success && result.files) {
            notes[i] = `🔍 ${i18nService.t('Found')} ${result.files.length} ${i18nService.t('file(s) matching')} "${cmd.arg}"`
            pushAction({ kind: 'find', label: i18nService.t('Found'), target: `"${cmd.arg}"`, status: 'ok', detail: `${result.files.length} ${i18nService.t('file(s) matching')}` })
            feedback.push(`FIND_FILES ${cmd.arg} result (${result.files.length} files${result.truncated ? ', truncated' : ''}):\n${result.files.join('\n') || '(no matches)'}`)
          } else {
            notes[i] = `⚠️ ${i18nService.t('Find failed for')} "${cmd.arg}": ${result.error}`
            pushAction({ kind: 'find', label: i18nService.t('Found'), target: `"${cmd.arg}"`, status: 'failed', detail: `${result.error}` })
            feedback.push(`FIND_FILES ${cmd.arg}: failed - ${result.error}`)
          }
        }
      } catch (error) {
        notes[i] = `⚠️ ${i18nService.t('Search error')}: ${error}`
        pushAction({ kind: cmd.type === 'grep' ? 'grep' : 'find', label: i18nService.t('Search error'), target: `"${cmd.arg}"`, status: 'failed', detail: `${error}` })
        feedback.push(`${cmd.type.toUpperCase()} ${cmd.arg}: failed - ${error}`)
      }
    } else if (cmd.type === 'read') {
      needsContinuation = true
      // Never fall back to cmd.arg on resolution failure - that would
      // read relative to the app's cwd (or anywhere via ../) instead
      // of rejecting the read.
      if (resolved.error || !resolved.path) {
        notes[i] = `⚠️ ${i18nService.t('Error reading file')} ${cmd.arg}: ${resolved.error}`
        pushAction({ kind: 'read', label: i18nService.t('Read file'), target: cmd.arg, status: 'failed', detail: resolved.error })
        feedback.push(`READ_FILE ${cmd.arg}: failed - ${resolved.error}`)
        continue
      }
      const filePath = resolved.path
      try {
        const result = await window.electronAPI.readFile(filePath)
        if (result.success) {
          const rel = pathRelativeToRoot(filePath)
          console.log(`File read: ${filePath}`)
          // A successful read refreshes the model's copy of the file -
          // release the re-read gate (an "unchanged" reply counts: the
          // model now knows its existing copy is current) and reset the
          // SEARCH-miss streak.
          state?.readGate?.delete(gateKey(filePath))
          state?.searchFailStreak?.delete(gateKey(filePath))
          if (state?.readCache?.get(filePath) === result.content
            // An elided earlier result is NOT in history any more -
            // "unchanged" would tell the model to use content it
            // cannot see. Elided paths always get the full body again.
            && !state?.elidedReads?.has(rel)) {
            // Same file, same content - the model is re-verifying a file
            // it already has. Answer without re-sending the full text.
            notes[i] = `📖 ${i18nService.t('Read file')}: ${rel} (${i18nService.t('unchanged')})`
            pushAction({ kind: 'read', label: i18nService.t('Read file'), target: rel, status: 'ok', detail: i18nService.t('unchanged') })
            feedback.push(
              `READ_FILE ${rel}: unchanged since your previous read - the content you already received is still current. Do not read it again; use what you have.`
            )
          } else {
            state?.readCache?.set(filePath, result.content ?? '')
            state?.readFiles?.add(rel)
            notes[i] = `📖 ${i18nService.t('Read file')}: ${rel}`
            pushAction({ kind: 'read', label: i18nService.t('Read file'), target: rel, status: 'ok' })
            const resultText = `READ_FILE ${rel} result:\n${result.content}`
            feedback.push(resultText)
            readBodies.push({ path: rel, text: resultText })
            // Context-pressure advisory: a single read that already
            // occupies most of the context window means the next few
            // reads will saturate it (which surfaces as empty replies).
            // Warn before that happens instead of diagnosing it after.
            const readContent = result.content ?? ''
            const numCtx = state?.numCtxLimit ?? 0
            const estTokens = Math.ceil(readContent.length / 3)
            if (numCtx > 0 && estTokens >= numCtx * 0.4 && !state?.largeReadWarned?.has(rel)) {
              state?.largeReadWarned?.add(rel)
              const pct = Math.round((estTokens / numCtx) * 100)
              pushAction({
                kind: 'notice',
                label: i18nService.t('Large file - most of the context window'),
                target: rel,
                status: 'failed',
                detail: `~${estTokens} tokens (${pct}% of num_ctx ${numCtx})`,
              })
              feedback.push(
                `NOTE: ${rel} alone is ~${estTokens} tokens - about ${pct}% of the ${numCtx}-token context window. ` +
                `A few more reads of this size can saturate the context and produce empty replies; ` +
                `read only what you need next (use GREP to find the relevant part instead of reading whole files).`
              )
            }
          }
        } else {
          console.error(`Failed to read file: ${filePath}`, result.error)
          notes[i] = `⚠️ ${i18nService.t('Error reading file')} ${pathRelativeToRoot(filePath)}: ${result.error}`
          pushAction({ kind: 'read', label: i18nService.t('Read file'), target: pathRelativeToRoot(filePath), status: 'failed', detail: `${result.error}` })
          feedback.push(`READ_FILE ${pathRelativeToRoot(filePath)}: failed - ${result.error}`)
        }
      } catch (error) {
        console.error(`Error reading file: ${filePath}`, error)
        notes[i] = `⚠️ ${i18nService.t('Error reading file')} ${pathRelativeToRoot(filePath)}: ${error}`
        pushAction({ kind: 'read', label: i18nService.t('Read file'), target: pathRelativeToRoot(filePath), status: 'failed', detail: `${error}` })
        feedback.push(`READ_FILE ${pathRelativeToRoot(filePath)}: failed - ${error}`)
      }
    } else {
      needsContinuation = true
      if (resolved.error || !resolved.path) {
        notes[i] = `⚠️ ${i18nService.t('Error listing files')} ${cmd.arg}: ${resolved.error}`
        pushAction({ kind: 'list', label: i18nService.t('Listed files in'), target: cmd.arg, status: 'failed', detail: resolved.error })
        feedback.push(`LIST_FILES ${cmd.arg}: failed - ${resolved.error}`)
        continue
      }
      const directoryPath = resolved.path
      try {
        const result = await window.electronAPI.readDirectory(directoryPath)
        if (result.success && result.items) {
          console.log(`Files listed: ${directoryPath}`)
          notes[i] = `📁 ${i18nService.t('Listed files in')}: ${pathRelativeToRoot(directoryPath)}`
          pushAction({ kind: 'list', label: i18nService.t('Listed files in'), target: pathRelativeToRoot(directoryPath), status: 'ok' })
          const fileList = result.items.map((item: any) =>
            `${item.isDirectory ? 'DIR' : 'FILE'}: ${item.name}`
          ).join('\n')
          feedback.push(`LIST_FILES ${pathRelativeToRoot(directoryPath)} result:\n${fileList}`)
        } else {
          console.error(`Failed to list files: ${directoryPath}`, result.error)
          notes[i] = `⚠️ ${i18nService.t('Error listing files')} ${pathRelativeToRoot(directoryPath)}: ${result.error}`
          pushAction({ kind: 'list', label: i18nService.t('Listed files in'), target: pathRelativeToRoot(directoryPath), status: 'failed', detail: `${result.error}` })
          feedback.push(`LIST_FILES ${pathRelativeToRoot(directoryPath)}: failed - ${result.error}`)
        }
      } catch (error) {
        console.error(`Error listing files: ${directoryPath}`, error)
        notes[i] = `⚠️ ${i18nService.t('Error listing files')} ${pathRelativeToRoot(directoryPath)}: ${error}`
        pushAction({ kind: 'list', label: i18nService.t('Listed files in'), target: pathRelativeToRoot(directoryPath), status: 'failed', detail: `${error}` })
        feedback.push(`LIST_FILES ${pathRelativeToRoot(directoryPath)}: failed - ${error}`)
      }
    }
  }

  // Ask the user to approve pending writes/edits before touching the disk
  if (pendingWrites.length > 0 || pendingEdits.length > 0) {
    interface PlanItem {
      index: number
      path: string
      arg: string
      kind: 'write' | 'edit'
      body: string
      existed: boolean
    }
    const items: PlanItem[] = [
      ...pendingWrites.map(w => ({ ...w, kind: 'write' as const, existed: false })),
      ...pendingEdits.map(e => ({ ...e, kind: 'edit' as const, existed: true })),
    ].sort((a, b) => a.index - b.index)

    const edits: FileEdit[] = []
    const planByEdit = new Map<FileEdit, PlanItem>()
    // Track per-batch outcome for agentState.unresolvedEdit: a failed
    // write/edit stays outstanding until a later write/edit succeeds.
    let batchEditFailed = false
    let batchEditSucceeded = false
    // Plan-file writes/edits that landed this batch - their checkbox
    // transitions are audited AFTER the batch so same-turn verified
    // changes count toward the items they claim to finish.
    const appliedPlanEdits: { rel: string; old: string; new: string }[] = []

    for (const item of items) {
      const label = item.kind === 'write' ? 'WRITE_FILE' : 'EDIT_FILE'
      let oldContent = ''
      let readable = true
      try {
        const result = await window.electronAPI.readFile(item.path)
        if (result.success) oldContent = result.content ?? ''
        else readable = false
      } catch {
        // New file - oldContent stays empty (writes); edits require readability
      }

      item.existed = readable
      if (item.kind === 'write') {
        // Weak models sometimes paste SEARCH/REPLACE diff syntax inside a
        // WRITE_FILE body - writing it literally produces a broken file.
        // Reject and ask for raw file content instead.
        if (/^<{3,}/m.test(item.body) && /^>{3,}/m.test(item.body)) {
          batchEditFailed = true
          notes[item.index] = `⚠️ ${i18nService.t('Write failed for')} ${item.arg}: ${i18nService.t('diff markers found in content')}`
          pushAction({ kind: 'write', label: i18nService.t('Write failed for'), target: item.arg, status: 'failed', detail: i18nService.t('diff markers found in content') })
          feedback.push(
            `WRITE_FILE ${item.arg}: rejected - the content contains SEARCH/REPLACE diff markers ` +
            `(<<<<<<< / ======= / >>>>>>>). WRITE_FILE takes the raw file content only; ` +
            `re-emit it with just the file content, no diff syntax.`
          )
          needsContinuation = true
          await notePathFailure(item.path)
          continue
        }
        // A "full rewrite" that shrinks a real file to a fraction of
        // its size is usually a fragment - the model emitted the first
        // section as if it were the whole file. Block it once and let
        // the model split it into pieces; a repeat counts as an
        // intentional rewrite and goes through.
        if (looksLikeFragment(oldContent, item.body)
          && !state?.shrinkWarned?.has(item.arg)) {
          if (state) (state.shrinkWarned ??= new Set()).add(item.arg)
          batchEditFailed = true
          notes[item.index] = `⚠️ ${i18nService.t('Write blocked - result much smaller')} ${item.arg}`
          pushAction({ kind: 'write', label: i18nService.t('Write blocked - result much smaller'), target: item.arg, status: 'failed' })
          feedback.push(
            `WRITE_FILE ${item.arg}: blocked - the file is ~${oldContent.split('\n').length} lines but your ` +
            `write contains only ~${item.body.split('\n').length} lines, which looks like a fragment, not the ` +
            `complete file. Emit the REST of the file content as an "// EDIT_FILE: ${item.arg}" block (SEARCH = ` +
            `the last lines of the current content, REPLACE = those lines plus the new part). If you truly ` +
            `intended to replace the whole file with this shorter version, emit the WRITE_FILE block again unchanged.`
          )
          needsContinuation = true
          await notePathFailure(item.path)
          continue
        }
        const edit: FileEdit = { filePath: item.path, oldContent, newContent: item.body }
        edits.push(edit)
        planByEdit.set(edit, item)
      } else {
        if (!readable) {
          batchEditFailed = true
          notes[item.index] = `⚠️ ${i18nService.t('Cannot edit')} ${item.arg}: ${i18nService.t('file not found or unreadable')}`
          pushAction({ kind: 'edit', label: i18nService.t('Cannot edit'), target: item.arg, status: 'failed', detail: i18nService.t('file not found or unreadable') })
          feedback.push(`${label} ${item.arg}: failed - file not found or unreadable. If you intended to create it, use // WRITE_FILE: with the full content instead.`)
          needsContinuation = true
          await notePathFailure(item.path)
          continue
        }
        const applied = applyEditBlocks(oldContent, parseEditBlocks(item.body))
        if (applied.error) {
          batchEditFailed = true
          if (state) state.editFailCount++
          // Two SEARCH misses in a row on the same file = the model's
          // copy is stale. Arm the re-read gate so the next WRITE/EDIT
          // to it is held until it reads the current content.
          if (state?.searchFailStreak && /SEARCH block #\d+ not found/.test(applied.error)) {
            const k = gateKey(item.path)
            const misses = (state.searchFailStreak.get(k) ?? 0) + 1
            state.searchFailStreak.set(k, misses)
            // Plan files gate at the first miss: the model only has the
            // compressed digest, so a miss here is almost certainly a
            // stale-copy edit rather than bad luck.
            if (misses >= (isPlanFileName(item.path) ? 1 : 2)) state.readGate?.add(k)
          }
          notes[item.index] = `⚠️ ${i18nService.t('Edit failed for')} ${item.arg}: ${applied.error}`
          pushAction({ kind: 'edit', label: i18nService.t('Edit failed for'), target: item.arg, status: 'failed', detail: applied.error })
          // Weak models recover better from a tiny complete example than
          // from prose rules. After repeated failures, steer to WRITE_FILE
          // (a full-file rewrite is easier for them than diff syntax).
          let hint = ` A complete EDIT_FILE looks like this:\n` +
            `// EDIT_FILE: ${item.arg}\n<<<<<<< SEARCH\n<exact lines to replace>\n=======\n<new lines>\n>>>>>>> REPLACE\n// END_EDIT_FILE`
          // "No SEARCH blocks" means the model emitted the new content
          // directly - a full-rewrite intent funneled into EDIT_FILE
          // (observed on a real run). Steer to WRITE_FILE immediately
          // rather than waiting for the repeated-failure steer.
          if (/no SEARCH\/REPLACE blocks/.test(applied.error)) {
            hint += `\nIf you meant to rewrite the WHOLE file, emit "// WRITE_FILE: ${item.arg}" followed by the complete new content - EDIT_FILE only works with SEARCH/REPLACE blocks.`
          }
          if (state && state.editFailCount >= 2) {
            hint += `\nEDIT_FILE has failed ${state.editFailCount} times in a row - stop using it and emit "// WRITE_FILE: ${item.arg}" with the FULL corrected file content instead.`
          }
          if (state?.readGate?.has(gateKey(item.path))) {
            hint += `\nYour SEARCH text has now failed to match ${item.arg} repeatedly - your copy of the file is stale. ` +
              `Emit "// READ_FILE: ${item.arg}" and rebuild the change from the content it returns; ` +
              `further writes/edits to this file are held until you read it.`
          }
          feedback.push(`${label} ${item.arg}: failed - ${applied.error}.${hint}`)
          needsContinuation = true
          await notePathFailure(item.path)
          continue
        }
        if (applied.alreadyApplied) {
          // The desired end-state is already on disk (e.g. the model
          // re-sent a diff that succeeded earlier). No write, no approval
          // dialog - report it as done so the model moves on and the
          // unresolved-edit tracker is cleared.
          if (state) state.editFailCount = 0
          state?.searchFailStreak?.delete(gateKey(item.path))
          state?.readGate?.delete(gateKey(item.path))
          state?.pathFailStreak?.delete(gateKey(item.path))
          state?.verifiedFiles?.add(pathRelativeToRoot(item.path))
          notes[item.index] = `✅ ${i18nService.t('Already applied')}: ${pathRelativeToRoot(item.path)}`
          pushAction({ kind: 'edit', label: i18nService.t('Already applied'), target: pathRelativeToRoot(item.path), status: 'ok' })
          feedback.push(`${label} ${item.arg}: already applied - the replacement text is already in the file; no change needed`)
          batchEditSucceeded = true
          continue
        }
        if (state) state.editFailCount = 0
        state?.searchFailStreak?.delete(gateKey(item.path))
        state?.readGate?.delete(gateKey(item.path))
        state?.pathFailStreak?.delete(gateKey(item.path))
        // Same fragment guard as the WRITE_FILE path: a syntactically
        // valid edit can still shrink the file to a stub.
        if (looksLikeFragment(oldContent, applied.content!)
          && !state?.shrinkWarned?.has(item.arg)) {
          if (state) (state.shrinkWarned ??= new Set()).add(item.arg)
          batchEditFailed = true
          notes[item.index] = `⚠️ ${i18nService.t('Edit blocked - result much smaller')} ${item.arg}`
          pushAction({ kind: 'edit', label: i18nService.t('Edit blocked - result much smaller'), target: item.arg, status: 'failed' })
          feedback.push(
            `EDIT_FILE ${item.arg}: blocked - the file is ~${oldContent.split('\n').length} lines but your edit ` +
            `leaves only ~${applied.content!.split('\n').length} lines, which looks like an accidental fragment. ` +
            `Split the change into smaller SEARCH/REPLACE pairs (one function or one section per pair). If the ` +
            `shrink is intentional, emit the same block again unchanged and it will be applied.`
          )
          needsContinuation = true
          await notePathFailure(item.path)
          continue
        }
        const edit: FileEdit = { filePath: item.path, oldContent, newContent: applied.content! }
        edits.push(edit)
        planByEdit.set(edit, item)
      }
    }

    // All edits may have failed to apply - don't open an empty modal
    const approved = edits.length > 0 ? await requestApproval(edits, approvalNote) : []
    const approvedSet = new Set(approved ?? [])

    for (const edit of edits) {
      const item = planByEdit.get(edit)!
      const label = item.kind === 'write' ? 'WRITE_FILE' : 'EDIT_FILE'
      if (!approvedSet.has(edit)) {
        notes[item.index] = `⏭️ ${i18nService.t('Skipped (rejected by user)')}: ${pathRelativeToRoot(item.path)}`
        pushAction({ kind: item.kind, label: i18nService.t('Skipped (rejected by user)'), target: pathRelativeToRoot(item.path), status: 'rejected' })
        feedback.push(`${label} ${pathRelativeToRoot(item.path)}: rejected by user`)
        needsContinuation = true
        continue
      }
      try {
        // Snapshot before writing so the user can roll this back later
        checkpoint.push({ path: item.path, prevContent: edit.oldContent, existed: item.existed })
        // Go through projectService so the file content cache stays in sync
        await projectService.writeFile(item.path, edit.newContent)

        // Post-write syntax validation: a "successful" write can still be
        // a fragment that is broken at the language level (the shrink
        // guard only counts lines). Roll the file back so broken content
        // never stays on disk, and tell the model to re-emit it valid.
        const syntax = await validateFileSyntax(item.path, edit.newContent)
        if (!syntax.ok) {
          try {
            if (item.existed) {
              await projectService.writeFile(item.path, edit.oldContent)
            } else {
              const project = projectService.getCurrentProject()
              if (project?.isOpen) await window.electronAPI.deleteFile(project.rootPath, item.path)
              projectService.invalidateFile(item.path)
            }
          } catch (rbError) {
            console.error(`Syntax-rollback failed for ${item.path}:`, rbError)
          }
          checkpoint.pop()
          if (item.existed) state?.readCache?.set(item.path, edit.oldContent)
          else {
            state?.readCache?.delete(item.path)
            // A rolled-back new file is gone from disk - it can no
            // longer stand as a verified or modified change.
            state?.verifiedFiles?.delete(pathRelativeToRoot(item.path))
            state?.modifiedFiles?.delete(pathRelativeToRoot(item.path))
          }
          const rollCount = (state?.syntaxRollbacks?.get(gateKey(item.path)) ?? 0) + 1
          state?.syntaxRollbacks?.set(gateKey(item.path), rollCount)
          const rel = pathRelativeToRoot(item.path)
          batchEditFailed = true
          notes[item.index] = `⚠️ ${i18nService.t('Syntax error - file rolled back')}: ${rel} (${syntax.error})`
          pushAction({ kind: 'notice', label: i18nService.t('Syntax error - file rolled back'), target: rel, status: 'failed', detail: syntax.error })
          feedback.push(
            `${label} ${rel}: written but rolled back - the content has a syntax error (${syntax.error}). ` +
            `The file was restored to its previous state. Re-emit the corrected content and make sure ` +
            `the result is syntactically valid.` +
            (rollCount >= 2
              ? ` This file's content has now been rolled back ${rollCount} times for syntax errors - check the syntax carefully before emitting.`
              : '')
          )
          needsContinuation = true
          window.dispatchEvent(new CustomEvent('file-created', { detail: { filePath: item.path } }))
          await notePathFailure(item.path)
          continue
        }

        console.log(`File written: ${item.path}`)
        notes[item.index] = item.kind === 'write'
          ? `✅ ${i18nService.t('Wrote file')}: ${pathRelativeToRoot(item.path)}`
          : `✅ ${i18nService.t('Edited file')}: ${pathRelativeToRoot(item.path)}`
        pushAction({
          kind: item.kind,
          label: item.kind === 'write' ? i18nService.t('Wrote file') : i18nService.t('Edited file'),
          target: pathRelativeToRoot(item.path),
          status: 'ok',
        })
        feedback.push(`${label} ${pathRelativeToRoot(item.path)}: success`)
        batchEditSucceeded = true
        if (state) {
          state.editsApplied = (state.editsApplied ?? 0) + 1
          state.modifiedFiles?.add(pathRelativeToRoot(item.path))
          // A successful write proves the model's copy of the file is
          // workable - clear the miss streak / re-read gate / failure
          // streak.
          state.searchFailStreak?.delete(gateKey(item.path))
          state.readGate?.delete(gateKey(item.path))
          state.pathFailStreak?.delete(gateKey(item.path))
          // The model already knows the new content - it wrote it - so a
          // follow-up READ_FILE can be answered "unchanged" as well.
          state.readCache?.set(item.path, edit.newContent)
        }

        // Semantic residue check: a "successful" write can still be a
        // fragment - the call site landed but the function body it
        // references was lost to a truncated or partial edit. Calls
        // whose name is defined nowhere in the project are exactly the
        // "declared but never written" lie seen on real runs - tell the
        // model so it can supply the missing definition.
        let changeVerified = true
        if (/\.(?:jsx?|tsx?|mjs|cjs)$/i.test(item.path)) {
          const suspects = findUndefinedCallees(edit.newContent)
          const missing: string[] = []
          const project = projectService.getCurrentProject()
          for (const name of suspects) {
            let defined = false
            if (project?.isOpen && window.electronAPI) {
              try {
                const defPat =
                  `(function|class|const|let|var)\\s+${escapeRegExp(name)}\\b` +
                  `|\\b${escapeRegExp(name)}\\s*[:=]` +
                  `|\\bimport\\b[^\\n]*\\b${escapeRegExp(name)}\\b`
                const res = await window.electronAPI.searchFiles(project.rootPath, defPat)
                if (res.success && res.matches && res.matches.length > 0) defined = true
              } catch { /* leave as suspect */ }
            }
            if (!defined) missing.push(name)
          }
          if (missing.length > 0) {
            changeVerified = false
            pushAction({
              kind: 'notice',
              label: i18nService.t('Possibly undefined function call'),
              target: `${item.arg}: ${missing.join(', ')}`,
              status: 'failed',
            })
            feedback.push(
              `NOTE: the file now calls ${missing.map(n => `\`${n}()\``).join(', ')} ` +
              `but no definition for ${missing.length === 1 ? 'it' : 'them'} was found in the project. ` +
              `A function body may have been dropped by a truncated or partial edit - ` +
              `add the missing definition${missing.length === 1 ? '' : 's'} now with EDIT_FILE, ` +
              `or explain where ${missing.length === 1 ? 'it is' : 'they are'} supposed to come from.`
            )
            needsContinuation = true
          }
        }

        // The change counts as "verified" when it applied, passed
        // syntax validation, and raised no missing-callee note - plan
        // completion marks are audited against this set.
        if (state && changeVerified) {
          const relV = pathRelativeToRoot(item.path)
          state.verifiedFiles?.add(relV)
          // A plan file the model writes becomes the tracked plan -
          // the digest injection picks it up from the next step.
          if (isPlanFileName(item.path)) {
            state.planPath = item.path
            appliedPlanEdits.push({ rel: relV, old: edit.oldContent, new: edit.newContent })
          }
        }

        // Emit event to refresh explorer (and editor if the file is open)
        window.dispatchEvent(new CustomEvent('file-created', {
          detail: { filePath: item.path }
        }))
      } catch (error) {
        console.error(`Error writing file: ${item.path}`, error)
        notes[item.index] = `⚠️ ${i18nService.t('Error writing file')} ${pathRelativeToRoot(item.path)}: ${error}`
        pushAction({ kind: item.kind, label: i18nService.t('Error writing file'), target: pathRelativeToRoot(item.path), status: 'failed', detail: `${error}` })
        feedback.push(`${label} ${pathRelativeToRoot(item.path)}: failed - ${error}`)
        needsContinuation = true
        batchEditFailed = true
        await notePathFailure(item.path)
      }
    }

    if (state) {
      if (batchEditFailed) state.unresolvedEdit = true
      else if (batchEditSucceeded) state.unresolvedEdit = false
    }

    // The deferral decision postponed above resolves here: applied
    // work in a user-scoped run makes "next I'll do X" the user's stop
    // line instead of a stall to push through.
    if (deferralBoundaryPending && batchEditSucceeded) {
      stopAtUserBoundary = true
      pushAction({ kind: 'notice', label: i18nService.t("Stopped at the model's question - reply to continue"), target: '', status: 'ok' })
    }

    // Plan-file audit (L2c): a "- [ ]" -> "- [x]" flip is trusted only
    // when the run produced a verified change the item could map to.
    // The mark itself stays (the user's approval applied it) - the
    // warning sends the model back to actually do the work. Audited
    // post-batch so same-turn writes count.
    for (const pe of appliedPlanEdits) {
      if (!state) break
      for (const item of newlyCheckedItems(pe.old, pe.new)) {
        const key = normPlanItemText(item.text)
        if (state.planWarnedItems?.has(key)) continue
        const refs = itemFileRefs(item.text)
        const verified = [...(state.verifiedFiles ?? [])]
        const matched = refs.some(r => verified.some(p => refMatchesPath(r, p)))
        // Weak judgment stays advisory: no file ref in the item only
        // warns when the run produced no verified change at all.
        if (matched || (refs.length === 0 && verified.length > 0)) continue
        state.planWarnedItems?.add(key)
        pushAction({
          kind: 'notice',
          label: i18nService.t('Completion mark without a verified change'),
          target: `${pe.rel}: ${item.text.slice(0, 60)}`,
          status: 'failed',
        })
        feedback.push(
          `NOTE: plan item "${item.text.slice(0, 100)}" in ${pe.rel} was marked done, ` +
          `but this run has no verified file change${refs.length > 0 ? ` to ${refs.join(', ')}` : ''} it could correspond to. ` +
          `A "- [x]" mark is only trusted after the WRITE_FILE/EDIT_FILE it reports actually succeeded - ` +
          `apply the change first and mark it done afterwards, or explain why no file change was needed.`
        )
        needsContinuation = true
      }
      // Phase transition gate (L5): a just-completed phase is reported
      // to the agent loop, which asks the user before the next one.
      const gate = justCompletedPhase(pe.old, pe.new)
      if (gate && !state.phaseGatesFired?.has(`${pe.rel}:${gate.done}`)) {
        state.phaseGate = { file: pe.rel, done: gate.done, next: gate.next }
      }
    }
  }

  // Ask the user to approve shell commands before running them
  if (pendingRuns.length > 0) {
    const approvedCommands = await requestCommandApproval(pendingRuns.map(r => r.command), approvalNote)
    const approvedSet = new Set(approvedCommands ?? [])

    for (const r of pendingRuns) {
      if (!approvedSet.has(r.command)) {
        notes[r.index] = `⏭️ ${i18nService.t('Skipped (rejected by user)')}: ${r.command}`
        pushAction({ kind: 'run', label: i18nService.t('Skipped (rejected by user)'), target: r.command, status: 'rejected' })
        feedback.push(`RUN_COMMAND ${r.command}: rejected by user`)
        needsContinuation = true
        continue
      }
      // Publish a pending row before the (potentially long) execution so
      // the card shows what is running right now, not only afterwards.
      const runAction: AgentAction = {
        kind: 'run',
        label: i18nService.t('Running'),
        target: r.command,
        status: 'pending',
      }
      pushAction(runAction)
      try {
        const result = await runCommandAndWait(r.command)
        // Strip the project root from output before feeding it to the model -
        // absolute paths would leak the OS user name to cloud providers.
        const runRoot = projectService.getCurrentProject()?.rootPath
          .replace(/\\/g, '/').replace(/\/+$/, '') ?? ''
        const rootPattern = escapeRegExp(runRoot).replace(/\//g, '[/\\\\]')
        const rawTail = stripAnsi(result.output)
        const tail = (runRoot ? rawTail.replace(new RegExp(rootPattern, 'gi'), '.') : rawTail)
          .slice(-8000) // errors usually appear at the end
        const statusText = result.opened
          ? i18nService.t('opened')
          : result.timedOut
            ? i18nService.t('still running after timeout (visible in the Terminal panel; the user can type stdin input there if the program is interactive)')
            : `${i18nService.t('exit code')} ${result.exitCode}`
        notes[r.index] = `▶️ ${i18nService.t('Ran')}: ${r.command} (${statusText})`
        // A non-zero exit reads as a failed step row; opens and timeouts
        // stay neutral since the process may still be alive.
        runAction.label = i18nService.t('Ran')
        runAction.status = result.exitCode !== null && result.exitCode !== 0 ? 'failed' : 'ok'
        runAction.detail = statusText
        onAction?.(actions)
        if (result.opened) {
          // Opening via the OS shell produces no terminal output - that IS
          // success. Feeding "(no output)" back makes small models read it as
          // failure and spiral into retries/platform hallucinations, so the
          // turn ends here (feedback still triggers the closing summary).
          feedback.push(
            `RUN_COMMAND ${r.command}: opened successfully in the user's default application. No terminal output is expected - do not retry or troubleshoot.`
          )
          if (state && (state.unresolvedEdit || state.unresolvedFailure)) {
            // The user is now looking at the app while unfinished work is
            // still outstanding - they may be seeing an incomplete
            // version. Resolve it before closing out; they can re-open
            // the app afterwards.
            notes[r.index] += ` ⚠️ ${i18nService.t('opened while work was still unresolved')}`
            runAction.detail = `${statusText} ⚠️ ${i18nService.t('opened while work was still unresolved')}`
            onAction?.(actions)
            feedback.push(
              'The app was opened while earlier work is still unresolved - the user may be looking at an incomplete version. ' +
              'Resolve the outstanding failure now (re-emit the file command or fix the failing command).'
            )
            needsContinuation = true
          }
        } else {
          // A bare exit code invites weak models to misdiagnose a test
          // failure as a broken environment (then they probe paths and
          // interpreters for dozens of steps). Classify the output and
          // spell out what kind of result this is.
          let hint = ''
          if (result.timedOut) {
            // statusText already explains it is still running
          } else if (result.exitCode !== 0) {
            if (state) {
              state.runFailStreak = (state.runFailStreak ?? 0) + 1
              state.lastRunFailure = { command: r.command, exitCode: result.exitCode, timedOut: false, tail }
              // A test command failing before any edit was applied means
              // the failure pre-dates the change, not a regression.
              const isTestCmd = TEST_COMMAND_RE.test(r.command)
              if (isTestCmd && (state.editsApplied ?? 0) === 0 && !state.preEditTestFailure) {
                state.preEditTestFailure = { command: r.command, tail }
              }
            }
            if (/is not recognized|command not found|no such file or directory|cannot find|file not found/i.test(tail)) {
              hint = '\nThe command or a path it referenced was not found - an environment/path issue, not a test result.'
            } else if (/FAILED|AssertionError|failures=[1-9]|FAIL:|failed,|\bfailed\b/i.test(tail)) {
              hint = '\nThe command ran correctly - this exit code means tests/assertions FAILED, not that the tool or environment is broken. Read the failing test names and assertion details in the output above.'
              if (state?.preEditTestFailure && (state.editsApplied ?? 0) > 0) {
                hint += ' This suite already failed BEFORE your edits - check whether the same tests were failing earlier; such pre-existing failures are not regressions from your change.'
              }
            } else {
              hint = '\nThe command ran and exited non-zero - the output above is the real result. A non-zero exit does not mean the tool or environment is broken.'
            }
            if ((state?.runFailStreak ?? 0) >= 3) {
              hint += '\nSeveral commands in a row have failed. Stop probing alternate paths/interpreters - re-read the outputs above and fix the cause they report.'
            }
          } else if (state) {
            state.runFailStreak = 0
          }
          // A canonical verdict line leads the result: weak models misread
          // raw output (a failing test run was once diagnosed as "command
          // not found"; a zero-test run as "all passed").
          feedback.push(
            `RUN_COMMAND ${r.command} result - ${statusText}:\n` +
            `${commandResultVerdict(r.command, result.exitCode, result.timedOut, tail)}\n` +
            `${tail || '(no output)'}${hint}`
          )
          needsContinuation = true
          // A non-zero exit leaves the task unresolved until a command
          // succeeds; timeouts/opens are ambiguous and keep the flag.
          if (state && !result.timedOut && result.exitCode !== null) {
            state.unresolvedFailure = result.exitCode !== 0
          }
        }
      } catch (error) {
        notes[r.index] = `⚠️ ${i18nService.t('Error running')} ${r.command}: ${error}`
        runAction.label = i18nService.t('Error running')
        runAction.status = 'failed'
        runAction.detail = `${error}`
        onAction?.(actions)
        feedback.push(`RUN_COMMAND ${r.command}: failed - ${error}`)
        needsContinuation = true
        if (state) state.unresolvedFailure = true
      }
    }
  }

  // The postponed scoped-deferral fallback: nothing was applied, so the
  // "next I'll do X" ending is still a stall to continue past.
  if (deferralBoundaryPending && !stopAtUserBoundary) {
    feedback.push(
      'You ended your turn asking the user to say "continue" (or similar) before emitting the rest of the work. ' +
      'Do not wait for the user - continue NOW in this response and emit the remaining file commands or output you listed.'
    )
    pushAction({ kind: 'notice', label: i18nService.t('Deferred to a later response - asking the model to continue now'), target: '', status: 'failed' })
    needsContinuation = true
  }

  // Rebuild display text: replace each command block with its readable note
  let display = ''
  let cursor = 0
  commands.forEach((cmd, i) => {
    display += response.slice(cursor, cmd.start)
    display += `\n${notes[i] ?? ''}\n`
    cursor = cmd.end
  })
  display += response.slice(cursor)
  if (malformedBlocks.length > 0) {
    display += `\n\n⚠️ ${i18nService.t('Incomplete command block - asking the model to retry')}`
  }
  if (inventedCmds.length > 0) {
    display += `\n\n⚠️ ${i18nService.t('Unknown command - asking the model to retry')}`
  }
  if (echoingResults) {
    display += `\n\n⚠️ ${i18nService.t('Result block imitated - asking the model to retry')}`
  }
  if (codeShownNudge) {
    display += `\n\n⚠️ ${i18nService.t('Code shown but not written - asking the model to retry')}`
  }
  if (deferred && !stopAtUserBoundary) {
    display += `\n\n⚠️ ${i18nService.t('Deferred to a later response - asking the model to continue now')}`
  }
  if (stopAtUserBoundary) {
    display += `\n\n⏹️ ${i18nService.t("Stopped at the model's question - reply to continue")}`
  }

  return { display: display.trim(), feedback, needsContinuation, checkpoint, actions, readBodies, stopAtUserBoundary, blockedInAskMode }
}

// PTY output contains ANSI escape sequences - strip them before
// feeding terminal output back to the model.
const ANSI_REGEX = /[\u001b\u009b][\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g
const stripAnsi = (s: string) => s.replace(ANSI_REGEX, '')

// Resolve once a project opens, or null on timeout. Used at startup so
// conversation restore can wait for the Explorer's async project
// restore instead of prematurely falling back to the project-less chat.
const waitForProjectOpen = (timeoutMs: number): Promise<Project | null> =>
  new Promise((resolve) => {
    const open = projectService.getCurrentProject()
    if (open?.isOpen) { resolve(open); return }
    const timer = setTimeout(() => { off(); resolve(null) }, timeoutMs)
    const off = projectService.onChange(() => {
      const p = projectService.getCurrentProject()
      if (p?.isOpen) { clearTimeout(timer); off(); resolve(p) }
    })
  })

const Chat: React.FC<ChatProps> = ({ onOpenSettings, chatFocus, onToggleFocus }) => {
  const t = useT()
  // Chat is persisted per conversation (file-backed). The component
  // remounts on project change via key in App.tsx, so mount-time load
  // is sufficient.
  const projectPath = projectService.getCurrentProject()?.rootPath
  const [messages, setMessages] = useState<Message[]>([])
  // Active conversation identity. convIdRef mirrors the state so async
  // paths (persistence, compaction) always see the latest id.
  const [convId, setConvIdState] = useState<string | null>(null)
  const convIdRef = useRef<string | null>(null)
  const setConvId = (id: string | null) => {
    convIdRef.current = id
    setConvIdState(id)
  }
  const convCreatedAtRef = useRef(0)
  // Project binding of the active conversation. Kept when the project
  // closes mid-conversation so reopening it restores this chat; updated
  // to the current project on every save while one is open.
  const convProjectPathRef = useRef<string | null>(null)
  const contextSummaryRef = useRef('')
  const summarizedCountRef = useRef(0)
  // The "raise num_ctx?" hint shows once per app session, not per run -
  // repeating it on every send would train the user to ignore it.
  const ctxGuideShownRef = useRef(false)
  // Set synchronously when the user interacts with this mount (send,
  // conversation pick). The mount-time conversation restore resolves
  // later (up to ~2s wait + history read); without this it would
  // overwrite messages pushed in the meantime - including a first
  // send's ctx-guide notice, while ctxGuideShownRef stays set and can
  // never refire.
  const userInteractedRef = useRef(false)
  const messagesRef = useRef<Message[]>([])
  const [convList, setConvList] = useState<ConversationMeta[]>([])
  const [convDeleteId, setConvDeleteId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isConfigured, setIsConfigured] = useState(false)
  const [currentModel, setCurrentModel] = useState<string>('')
  // Organization session: remaining budget from the management server
  const [managedUsage, setManagedUsage] = useState<{ spend: number; maxBudget: number | null; resetAt?: string } | null>(null)
  // Model pinned to the in-flight request (shown while generating)
  const [activeModel, setActiveModel] = useState<string>('')
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  const [pendingEdits, setPendingEdits] = useState<FileEdit[] | null>(null)
  const [approvalNote, setApprovalNote] = useState<string | null>(null)
  // Chat input mode switch (Agent / Ask) - persisted like chat_focus.
  const [chatMode, setChatMode] = useState<'agent' | 'ask'>(() => configService.getChatMode())
  const approvalResolverRef = useRef<((edits: FileEdit[] | null) => void) | null>(null)
  const [pendingCommands, setPendingCommands] = useState<string[] | null>(null)
  const commandResolverRef = useRef<((commands: string[] | null) => void) | null>(null)
  // Process-approval prompt (phase transitions, repeated-failure
  // decisions) - same resolver pattern as the approval dialogs.
  const [processPrompt, setProcessPrompt] = useState<ProcessPrompt | null>(null)
  const processResolverRef = useRef<((choice: string | null) => void) | null>(null)
  // "No project open" prompt for AI file writes - same resolver pattern
  // as the approval dialogs. Shown at most once per user turn.
  const [showProjectModal, setShowProjectModal] = useState(false)
  const projectResolverRef = useRef<((rootPath: string | null) => void) | null>(null)
  const projectPromptShownRef = useRef(false)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  // Live streaming bubble (separate from the committed message list)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  // Transient progress note for the loading line (rate-limit backoff etc.)
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const streamedRef = useRef('')
  // Stack of pre-write snapshots - each entry rolls back one AI write batch
  const checkpointsRef = useRef<{ path: string; prevContent: string; existed: boolean }[][]>([])
  const [canRollback, setCanRollback] = useState(false)
  const [confirmClearChat, setConfirmClearChat] = useState(false)

  const handleRollback = async () => {
    const cp = checkpointsRef.current.pop()
    setCanRollback(checkpointsRef.current.length > 0)
    if (!cp || !window.electronAPI) return
    const cpRoot = projectService.getCurrentProject()?.rootPath
    if (cpRoot) checkpointService.pop(cpRoot)
    const project = projectService.getCurrentProject()
    for (const f of cp) {
      try {
        if (f.existed) {
          await projectService.writeFile(f.path, f.prevContent)
        } else if (project) {
          // The AI created this file - remove it
          await window.electronAPI.deleteFile(project.rootPath, f.path)
        }
        window.dispatchEvent(new CustomEvent('file-created', { detail: { filePath: f.path } }))
      } catch (error) {
        console.error(`Rollback failed for ${f.path}:`, error)
      }
    }
    setMessages((prev) => [...prev, {
      role: 'assistant',
      content: `↩️ ${i18nService.t('Rolled back {count} file(s) changed by the last AI operation.').replace('{count}', String(cp.length))}`,
      timestamp: Date.now(),
      isError: true,
    }])
  }

  // Pause the agent loop until the user approves or rejects file writes.
  // Resolves with the approved edits (subset allowed) or null on reject-all.
  const requestApproval = (edits: FileEdit[], note?: string): Promise<FileEdit[] | null> => {
    return new Promise((resolve) => {
      approvalResolverRef.current = resolve
      setApprovalNote(note ?? null)
      setPendingEdits(edits)
    })
  }

  const resolveApproval = (edits: FileEdit[] | null) => {
    approvalResolverRef.current?.(edits)
    approvalResolverRef.current = null
    setPendingEdits(null)
    setApprovalNote(null)
  }

  const handleRejectOneEdit = (edit: FileEdit) => {
    if (!pendingEdits) return
    const next = pendingEdits.filter(e => e !== edit)
    if (next.length === 0) {
      resolveApproval([]) // Everything rejected individually
    } else {
      setPendingEdits(next)
    }
  }

  // Same approval pattern for shell commands
  const requestCommandApproval = (commands: string[], note?: string): Promise<string[] | null> => {
    return new Promise((resolve) => {
      commandResolverRef.current = resolve
      setApprovalNote(note ?? null)
      setPendingCommands(commands)
    })
  }

  const resolveCommandApproval = (commands: string[] | null) => {
    commandResolverRef.current?.(commands)
    commandResolverRef.current = null
    setPendingCommands(null)
    setApprovalNote(null)
  }

  // Same approval pattern for process prompts - resolves with the
  // chosen option id, or null when dismissed.
  const requestProcessApproval = (prompt: ProcessPrompt): Promise<string | null> => {
    return new Promise((resolve) => {
      processResolverRef.current = resolve
      setProcessPrompt(prompt)
    })
  }

  const resolveProcess = (choice: string | null) => {
    processResolverRef.current?.(choice)
    processResolverRef.current = null
    setProcessPrompt(null)
  }

  // Pause the agent loop until the user creates a project folder (or
  // declines). Resolves with the new project root, or null on cancel.
  const requestProject = (): Promise<string | null> => {
    if (projectPromptShownRef.current) return Promise.resolve(null)
    projectPromptShownRef.current = true
    return new Promise((resolve) => {
      projectResolverRef.current = resolve
      setShowProjectModal(true)
    })
  }

  const resolveProject = (rootPath: string | null) => {
    // A project materialized from this chat's file writes - bind the
    // conversation to it so it lists under that project from now on.
    if (rootPath && convIdRef.current) {
      convProjectPathRef.current = rootPath
      void chatHistoryService.setProjectPath(convIdRef.current, rootPath).then(refreshConvList)
    }
    projectResolverRef.current?.(rootPath)
    projectResolverRef.current = null
    setShowProjectModal(false)
  }

  // Reset the in-memory conversation identity without touching saved
  // files - used by "New chat" so the old conversation stays listed.
  const resetConvState = () => {
    setConvId(null)
    convCreatedAtRef.current = 0
    convProjectPathRef.current = null
    contextSummaryRef.current = ''
    summarizedCountRef.current = 0
    if (!projectService.getCurrentProject()?.isOpen) configService.setLastNoProjectConv(null)
  }

  const clearCurrentChat = () => {
    abortController?.abort()
    resolveApproval(null)
    resolveCommandApproval(null)
    resolveProject(null)
    streamedRef.current = ''
    setStreamingText(null)
    stickToBottomRef.current = true
    setMessages([])
    messagesRef.current = []
    if (convIdRef.current) void chatHistoryService.delete(convIdRef.current).then(refreshConvList)
    resetConvState()
  }

  const handleClearChat = () => {
    clearCurrentChat()
    setConfirmClearChat(false)
  }

  const handleNewChat = () => {
    if (isLoading) return
    resolveApproval(null)
    resolveCommandApproval(null)
    resolveProject(null)
    streamedRef.current = ''
    setStreamingText(null)
    stickToBottomRef.current = true
    setMessages([])
    messagesRef.current = []
    resetConvState()
  }

  // Chat list (focus mode): load a conversation in place. Opening a
  // bound project goes through projectService + the project-opened
  // event so the chat is NOT remounted (unlike Explorer's open path).
  const handleSelectConversation = async (meta: ConversationMeta) => {
    if (isLoading || meta.id === convIdRef.current) return
    userInteractedRef.current = true
    const conv = await chatHistoryService.getById(meta.id)
    if (!conv) return
    if (meta.projectPath) {
      try {
        await projectService.openProject(meta.projectPath)
        configService.setLastProjectPath(meta.projectPath)
      } catch { /* folder may be gone - still load the chat */ }
    } else {
      window.electronAPI?.unwatchProject?.()
      projectService.closeProject()
      contextService.clearContext()
      configService.setLastProjectPath('')
      configService.setLastOpenFile('')
    }
    window.dispatchEvent(new CustomEvent('teaspoon:project-opened', { detail: { rootPath: meta.projectPath } }))
    setConvId(conv.id)
    convCreatedAtRef.current = conv.createdAt
    convProjectPathRef.current = conv.projectPath
    contextSummaryRef.current = conv.contextSummary ?? ''
    summarizedCountRef.current = conv.summarizedCount ?? 0
    messagesRef.current = conv.messages
    setMessages(conv.messages)
    stickToBottomRef.current = true
    if (!meta.projectPath) configService.setLastNoProjectConv(meta.id)
    setConvDeleteId(null)
  }

  const handleDeleteConversation = async (id: string) => {
    await chatHistoryService.delete(id)
    setConvDeleteId(null)
    if (id === convIdRef.current) {
      // The on-screen conversation vanished - start a fresh chat
      resetConvState()
      setMessages([])
      messagesRef.current = []
    }
    await refreshConvList()
  }

  useEffect(() => {
    const handleClearAll = () => clearCurrentChat()
    window.addEventListener('teaspoon:chat-history-cleared', handleClearAll)
    return () => window.removeEventListener('teaspoon:chat-history-cleared', handleClearAll)
  }, [abortController, projectPath])

  const handleRejectOneCommand = (command: string) => {
    if (!pendingCommands) return
    const next = pendingCommands.filter(c => c !== command)
    if (next.length === 0) {
      resolveCommandApproval([])
    } else {
      setPendingCommands(next)
    }
  }

  // Run a shell command in the project root and wait for it to exit.
  // Long-running commands (npm start, docker) resolve with timedOut=true
  // and keep running - the user can watch/stop them in the Terminal panel.
  const RUN_COMMAND_TIMEOUT_MS = 60_000
  const runCommandAndWait = (command: string): Promise<RunResult> => {
    return new Promise<RunResult>(async (resolve, reject) => {
      const project = projectService.getCurrentProject()
      if (!project?.isOpen || !window.electronAPI) {
        reject(new Error(i18nService.t('No project is open')))
        return
      }

      // `start` inside a transient ConPTY cmd can exit before the launched
      // app appears. Open documents/URLs through the OS shell instead -
      // this also catches the Linux/macOS openers (xdg-open / open) and
      // works for a "start" emitted on any platform.
      const startMatch = command.match(/^\s*(?:cmd(?:\.exe)?\s+\/c\s+)?(?:start|xdg-open|open)\s+(.*)$/i)
      if (startMatch) {
        // Small models append prose like "  (or start http://...)" copied from
        // prompt examples - cut it off. Quoted targets are left alone (a file
        // name may legitimately contain parentheses).
        let target = startMatch[1].trim().replace(/^""\s*/, '')
        if (!target.startsWith('"')) {
          target = target.replace(/\s{2,}(?:\(|#|\/\/).*$/, '')
        }
        target = target.replace(/^"|"$/g, '')
        if (target) {
          const isUrl = /^https?:\/\//i.test(target)
          if ((isUrl && !window.electronAPI.openExternal) || (!isUrl && !window.electronAPI.openPath)) {
            reject(new Error(i18nService.t('Cannot open target - restart Teaspoon IDE to pick up the update')))
            return
          }
          try {
            const res = isUrl
              ? await window.electronAPI.openExternal(target)
              : await window.electronAPI.openPath(project.rootPath, target)
            if (res.success) {
              resolve({ output: '', exitCode: 0, timedOut: false, opened: true })
            } else {
              reject(new Error(res.error || i18nService.t('Failed to open')))
            }
          } catch (e) {
            reject(e)
          }
          return
        }
      }

      const result = await window.electronAPI.runCommand(project.rootPath, command)
      if (!result.success || !result.id) {
        reject(new Error(result.error || i18nService.t('Failed to start process')))
        return
      }
      const id = result.id

      // Show the spawned process in the Terminal panel too
      window.dispatchEvent(new CustomEvent('terminal-spawned', { detail: { id, command } }))

      let output = ''
      const offOutput = window.electronAPI.onTerminalOutput((payload) => {
        if (payload.id === id) output += payload.data
      })
      const offExit = window.electronAPI.onTerminalExit((payload) => {
        if (payload.id !== id) return
        cleanup()
        resolve({ output, exitCode: payload.code, timedOut: false })
      })
      const timer = setTimeout(() => {
        cleanup()
        resolve({ output, exitCode: null, timedOut: true })
      }, RUN_COMMAND_TIMEOUT_MS)

      const cleanup = () => {
        offOutput()
        offExit()
        clearTimeout(timer)
      }
    })
  }

  const scrollToBottom = () => {
    const container = messagesContainerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }

  const handleMessagesScroll = () => {
    const container = messagesContainerRef.current
    if (!container) return
    stickToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 40
  }

  useEffect(() => {
    if (!stickToBottomRef.current) return
    const frame = requestAnimationFrame(() => {
      if (stickToBottomRef.current) scrollToBottom()
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, streamingText, isLoading])

  const refreshConvList = async () => {
    setConvList(await chatHistoryService.listConversations())
  }

  // Persist the current conversation (file-backed, writes serialized
  // in the service so index updates cannot interleave).
  const persistConversation = async () => {
    const msgs = messagesRef.current
    if (msgs.length === 0) return
    const project = projectService.getCurrentProject()
    const id = convIdRef.current ?? chatHistoryService.createId()
    if (!convIdRef.current) setConvId(id)
    if (project?.isOpen) convProjectPathRef.current = project.rootPath
    await chatHistoryService.save({
      id,
      title: chatHistoryService.deriveTitle(msgs),
      projectPath: convProjectPathRef.current,
      createdAt: convCreatedAtRef.current || (convCreatedAtRef.current = msgs[0]?.timestamp ?? Date.now()),
      updatedAt: Date.now(),
      summarizedCount: summarizedCountRef.current,
      contextSummary: contextSummaryRef.current,
      messages: msgs,
    })
    await refreshConvList()
    if (project?.isOpen) {
      // This conversation is now project-bound - drop any stale pointer
      // that still names it as the last project-less chat.
      if (configService.getLastNoProjectConv() === id) configService.setLastNoProjectConv(null)
    } else {
      configService.setLastNoProjectConv(id)
    }
  }

  // Restore persisted AI-write checkpoints so the rollback button works
  // across restarts. Chat remounts on project open (key in App.tsx), so
  // mount-time load is sufficient; entries pushed this session are newer
  // and stay at the top of the stack.
  useEffect(() => {
    const root = projectService.getCurrentProject()?.rootPath
    if (!root) return
    void checkpointService.load(root).then((persisted) => {
      if (persisted.length === 0) return
      const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '')
      const restored = persisted.map((b) =>
        b.files.map((f) => ({
          path: `${rootNorm}/${f.path}`,
          prevContent: f.prevContent,
          existed: f.existed,
        })),
      )
      checkpointsRef.current = [...restored, ...checkpointsRef.current]
      setCanRollback(checkpointsRef.current.length > 0)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load the active conversation once on mount: the project's latest
  // conversation, or the last project-less chat when nothing is open.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Explorer restores the last project asynchronously - this mount can
      // run before the restore finishes, so wait briefly when a restore
      // is expected rather than wrongly loading the project-less chat.
      const project = projectPath
        ? projectService.getCurrentProject()
        : configService.getLastProjectPath()
          ? await waitForProjectOpen(2000)
          : null
      const conv = project?.isOpen
        ? await chatHistoryService.getByProject(project.rootPath)
        : await chatHistoryService.getById(configService.getLastNoProjectConv())
      if (cancelled) return
      // A send that started before this restore resolved has already
      // pushed messages - do not wipe them with the stored conversation.
      if (conv && !userInteractedRef.current) {
        setConvId(conv.id)
        convCreatedAtRef.current = conv.createdAt
        convProjectPathRef.current = conv.projectPath
        contextSummaryRef.current = conv.contextSummary ?? ''
        summarizedCountRef.current = conv.summarizedCount ?? 0
        if (conv.messages.length) {
          messagesRef.current = conv.messages
          setMessages(conv.messages)
        }
      }
      await refreshConvList()
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist conversation whenever it changes. Live-run updates arrive
  // per action now - debounce those bursts, but persist promptly once
  // the turn settles so save cadence matches the pre-live behavior.
  useEffect(() => {
    messagesRef.current = messages
    if (messages.length === 0) return
    const t = setTimeout(() => void persistConversation(), isLoading ? 800 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isLoading])

  // Fold older turns into the rolling summary once the stored
  // conversation outgrows the history window. Runs after a completed
  // turn (fire-and-forget); failures keep the old summary for next time.
  const compactHistory = async (llmPin: { provider?: string; model?: string }, signal: AbortSignal) => {
    const all = messagesRef.current
    const done = summarizedCountRef.current
    if (all.length - done <= SUMMARY_TRIGGER) return
    const end = Math.max(done, all.length - HISTORY_WINDOW)
    const excerpt = all.slice(done, end)
    if (excerpt.length === 0) return
    const transcript = excerpt
      .filter((m) => !isErrorMessage(m))
      .map((m) => `${m.role}: ${m.role === 'assistant' ? stripNoteLines(m.content) : m.content}`)
      .join('\n')
    const prior = contextSummaryRef.current
    const prompt =
      `Summarize this chat excerpt into a compact context note under ` +
      `${SUMMARY_TARGET_CHARS} characters, in the same language as the ` +
      `conversation. Preserve file paths, decisions made, and unfinished ` +
      `tasks.` +
      (prior ? `\n\nMerge with the previous summary:\n${prior}` : '') +
      `\n\nExcerpt:\n${transcript}`
    try {
      const summary = await llmService.sendMessage(prompt, undefined, [], () => {}, signal, llmPin, true)
      const trimmed = summary.trim()
      if (!trimmed || signal.aborted) return
      contextSummaryRef.current = trimmed.slice(0, SUMMARY_TARGET_CHARS)
      summarizedCountRef.current = end
      await persistConversation()
    } catch { /* keep the old summary - retried after the next turn */ }
  }

  useEffect(() => {
    const refreshLlm = () => {
      setIsConfigured(llmService.isConfigured())
      setCurrentModel(getProvider().modelLabel())
    }
    refreshLlm()
    // Settings can switch provider/model while the chat stays mounted
    window.addEventListener('teaspoon:llm-changed', refreshLlm)
    return () => window.removeEventListener('teaspoon:llm-changed', refreshLlm)
  }, [])

  // Organization session: poll the remaining budget once a minute and
  // re-check on session changes
  useEffect(() => {
    let cancelled = false
    const refreshUsage = async () => {
      const usage = await managedService.getUsage()
      if (!cancelled) setManagedUsage(usage)
    }
    refreshUsage()
    const interval = setInterval(refreshUsage, 60000)
    window.addEventListener('teaspoon:managed-changed', refreshUsage)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('teaspoon:managed-changed', refreshUsage)
    }
  }, [])

  // Each completed reply may have consumed budget - refresh then too
  const wasLoadingRef = useRef(false)
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading) {
      managedService.getUsage().then(setManagedUsage)
    }
    wasLoadingRef.current = isLoading
  }, [isLoading])

  const handleSend = async () => {
    if (!input.trim()) return

    if (!isConfigured) {
      onOpenSettings()
      return
    }

    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: Date.now(),
    }

    stickToBottomRef.current = true
    setMessages((prev) => [...prev, userMessage])
    setInput('')
    await sendToAI(userMessage, messages)
  }

  // Resend the last user message and discard the assistant turns after it
  const handleRetry = async () => {
    if (isLoading || !isConfigured) return

    let lastUserIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIndex = i
        break
      }
    }
    if (lastUserIndex < 0) return

    const retryMessage = messages[lastUserIndex]
    const base = messages.slice(0, lastUserIndex)
    stickToBottomRef.current = true
    setMessages([...base, retryMessage])
    await sendToAI(retryMessage, base)
  }

  // One-click recovery from a saturated context: raise num_ctx for this
  // session only (not persisted - a bigger window that outlives the
  // machine's RAM should be a deliberate Settings choice) and retry.
  const handleRaiseNumCtx = async (ctx: number) => {
    configService.setSessionOllamaNumCtx(ctx)
    await handleRetry()
  }

  // Ask mode blocked a file/command request: switch to agent mode and
  // resend the same user message - the model gets a clean second attempt
  // without the user having to retype or know the mode names.
  const handleRetryInCodeMode = () => {
    if (isLoading || !isConfigured) return
    let lastUserIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIndex = i
        break
      }
    }
    if (lastUserIndex < 0) return
    const retryMessage = messages[lastUserIndex]
    const base = messages.slice(0, lastUserIndex)
    configService.setChatMode('agent')
    setChatMode('agent')
    stickToBottomRef.current = true
    setMessages([...base, retryMessage])
    void sendToAI(retryMessage, base)
  }

  const sendToAI = async (userMessage: Message, historyBase: Message[]) => {
    userInteractedRef.current = true
    setIsLoading(true)
    setRunStatus(null)

    // Pin provider+model for this whole run: changing Settings while a
    // response is generating must not retarget later agent-loop steps or
    // relabel the in-flight reply.
    const runProvider = getProvider()
    const runLabel = currentModel
    const llmPin = { provider: runProvider.id, model: runProvider.resolveModel() }
    setActiveModel(runLabel)

    // Create abort controller for this request
    const controller = new AbortController()
    setAbortController(controller)

    // Usage from the most recent provider call - the Ollama
    // context-saturation check (empty replies near num_ctx) and the
    // history-elision thresholds both key off it, and the error path
    // below reads it after a failed call too.
    let lastUsage: Message['tokens']

    try {
      // Get project context dynamically
      let context: string | undefined
      try {
        const projectContext = await projectService.getProjectContext()
        const project = projectService.getCurrentProject()
        if (project && project.isOpen) {
          const header = `Project: ${project.name}\nAll file paths below are relative to the project root.`
          context = projectContext.length > 0 ? `${header}\n\n${projectContext}` : header
        } else {
          context = projectContext.length > 0 ? projectContext : undefined
        }
        console.log('Project context loaded:', context ? 'Yes' : 'No')
      } catch (projectError) {
        console.warn('Failed to get project context:', projectError)
        context = undefined
      }

      // Tell the model when the IDE panes are hidden so questions like
      // "where did the sidebar go" get the right answer (chat focus).
      if (chatFocus) {
        const focusNote =
          'UI state: chat focus is ON - only the chat panel is visible (sidebar, editor, and terminal are hidden). ' +
          'The user restores the panes with the ◫ button in the chat header or View > Toggle Chat Focus (Ctrl+Shift+B).'
        context = context ? `${context}\n\n${focusNote}` : focusNote
      }

      // Turns beyond the history window are carried as a compact
      // rolling summary instead of verbatim messages (compactHistory).
      if (contextSummaryRef.current) {
        const summaryNote = `Summary of earlier conversation in this chat:\n${contextSummaryRef.current}`
        context = context ? `${context}\n\n${summaryNote}` : summaryNote
      }

      // Error bubbles and client-side warnings never reach the model.
      // Filtering before the window slice keeps dropped error turns from
      // shrinking the effective history.
      const cleanHistoryBase = historyBase.filter((m) => !isErrorMessage(m))

      // When the window drops earlier turns, say so - otherwise the model
      // treats the first visible message as the conversation start and
      // confidently answers questions about history it cannot see.
      if (cleanHistoryBase.length > HISTORY_WINDOW) {
        const truncationNote =
          `Note: this conversation is long - only the last ${HISTORY_WINDOW} messages are shown verbatim` +
          (contextSummaryRef.current
            ? ', and earlier turns are covered by the summary above.'
            : ', so the first message you see may not be the start of the conversation.')
        context = context ? `${context}\n\n${truncationNote}` : truncationNote
      }

      // Agent loop: the AI may issue file commands (READ_FILE / LIST_FILES)
      // whose results it needs before it can continue. Execute the commands,
      // feed the results back to the model, and repeat until the model
      // responds without commands or we hit the step limit.
      // +1 over the work budget: the closing-summary turn runs inside
      // the loop too, so a model that keeps working (or defers) there
      // gets its results fed back instead of ending the run mid-task.
      const MAX_STEPS = 6
      // Feed raw model output as history - display notes like "Ran: ..."
      // are UI decoration, and small models imitate them as fake output.
      // Legacy messages saved before rawContent existed get their note
      // lines stripped instead.
      const historyForRequest: Message[] =
        // Only the recent window goes verbatim - older turns arrive via
        // the contextSummary injected into `context` above. The current
        // user message is NOT included here: sendMessage already appends
        // it as the request prompt, and listing it in history too would
        // send it twice. It is pushed after the first call so later
        // agent-loop steps still see the original turn.
        // Older assistant file bodies (WRITE_FILE/EDIT_FILE contents)
        // are dead weight in every subsequent prompt - the files are on
        // disk. All but the freshest assistant turn are reduced to
        // their marker lines so the record of what happened survives
        // while the context budget is freed.
        (() => {
          const base = cleanHistoryBase.slice(-HISTORY_WINDOW).map((m) => ({
            ...m,
            content: m.rawContent ?? (m.role === 'assistant' ? stripNoteLines(m.content) : m.content),
          }))
          let lastAssistant = -1
          for (let i = base.length - 1; i >= 0; i--) {
            if (base[i].role === 'assistant') { lastAssistant = i; break }
          }
          return base.map((m, i) =>
            m.role === 'assistant' && i !== lastAssistant
              ? { ...m, content: elideFileBlocks(m.content) }
              : m,
          )
        })()
      let currentInput = userMessage.content
      let lastStepRanCommands = false
      // Tracks consecutive EDIT_FILE failures across loop steps so the
      // feedback can steer the model to WRITE_FILE instead of retrying the
      // same broken diff syntax forever.
      const agentState = {
        editFailCount: 0,
        unresolvedFailure: false,
        unresolvedEdit: false,
        runFailStreak: 0,
        editsApplied: 0,
        editsAttempted: 0,
        lastRunFailure: null as { command: string; exitCode: number | null; timedOut: boolean; tail: string } | null,
        preEditTestFailure: null as { command: string; tail: string } | null,
        readCache: new Map<string, string>(),
        readFiles: new Set<string>(),
        modifiedFiles: new Set<string>(),
        lastTurnTruncated: false,
        elidedReads: new Set<string>(),
        shrinkWarned: new Set<string>(),
        syntaxRollbacks: new Map<string, number>(),
        searchFailStreak: new Map<string, number>(),
        readGate: new Set<string>(),
        largeReadWarned: new Set<string>(),
        numCtxLimit: 0,
        pathFailStreak: new Map<string, number>(),
        pathSkipped: new Set<string>(),
        phaseGate: null as { file: string; done: string; next: string } | null,
        phaseGatesFired: new Set<string>(),
        planPath: null as string | null,
        planScanDone: false,
        verifiedFiles: new Set<string>(),
        planWarnedItems: new Set<string>(),
      }
      // READ_FILE result bodies fed back so far this run - their copies
      // in historyForRequest get swapped for placeholders when the
      // context approaches saturation.
      let pendingReadBodies: { path: string; text: string }[] = []
      const numCtxLimit = llmPin.provider === 'ollama'
        ? (configService.getOllamaNumCtx() ?? 4096)
        : 0
      agentState.numCtxLimit = numCtxLimit
      // The Settings guide is easy to miss - surface the same
      // recommendation once per session when the selected model's
      // working num_ctx is below its known-good value. Session-only
      // raise (A-7) is offered as the one-click fix.
      if (numCtxLimit > 0 && !ctxGuideShownRef.current) {
        const recommended = recommendedNumCtxForModel(llmPin.model ?? '')
        if (recommended && numCtxLimit < recommended) {
          ctxGuideShownRef.current = true
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `💡 ${i18nService.t('This model is easier to drive with a larger context window ({n} recommended; current {cur}).').replace('{n}', String(recommended)).replace('{cur}', String(numCtxLimit))}`,
            timestamp: Date.now(),
            canRaiseNumCtx: recommended,
          }])
        }
      }
      // Swap each remembered read-result body in the request history for
      // a placeholder line, and mark the path so a re-read re-sends the
      // full content instead of the "unchanged" shortcut.
      const elideReadBodies = () => {
        if (pendingReadBodies.length === 0) return
        for (const e of historyForRequest) {
          if (e.role !== 'user') continue
          for (const b of pendingReadBodies) {
            if (e.content.includes(b.text)) {
              e.content = e.content.replace(
                b.text,
                `READ_FILE ${b.path} result:\n(content omitted - on disk, emit READ_FILE to view)`,
              )
              agentState.elidedReads.add(b.path)
            }
          }
        }
        pendingReadBodies = []
      }
      // Reduce older in-run assistant replies to their command marker
      // lines; the freshest stays intact for "continue where you stopped".
      const elideOlderAssistantBlocks = () => {
        let last = -1
        for (let i = historyForRequest.length - 1; i >= 0; i--) {
          if (historyForRequest[i].role === 'assistant') { last = i; break }
        }
        for (let i = 0; i < historyForRequest.length; i++) {
          const e = historyForRequest[i]
          if (e.role === 'assistant' && i !== last) {
            const elided = elideFileBlocks(e.content)
            if (elided !== e.content) e.content = elided
          }
        }
      }
      // One-shot guard: warn the user at most once per run when a failed
      // write/edit was never retried, regardless of which path ended it.
      let unresolvedWarned = false
      const warnUnresolvedEdit = () => {
        if (unresolvedWarned || !agentState.unresolvedEdit) return
        unresolvedWarned = true
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `⚠️ ${i18nService.t('A file edit failed and was never retried - the reported changes may not exist on disk. Please verify the file.')}`,
          timestamp: Date.now(),
          isError: true,
        }])
      }
      // One-shot guard: nudge the model at most once when it declares
      // completion while a failure is still unresolved.
      let failureNudged = false
      // The closing-summary request fires at most once per run, after a
      // step that executed commands.
      let summaryAsked = false
      // Stagnation watchdog: a reply that repeats the previous one almost
      // word-for-word while changing nothing on disk is the loop small
      // models fall into (context saturation makes it worse). One repeat
      // gets a warning; the second aborts the run - instructions alone
      // never break this loop.
      let prevReplyNorm = ''
      let stagnantStreak = 0
      let stagnantAborted = false
      // The user bounded the run's scope and the model closed on a
      // permission question - the boundary ended the run (loop-scoped
      // flag mirrored here so the post-loop summary knows to skip).
      let boundaryStopped = false
      // A step whose prompt already exceeds num_ctx gets one warning -
      // Ollama silently drops the system prompt past the limit, which is
      // precisely what produces the repetition loop above.
      let ctxOverflowWarned = false
      // Crossing ~80% of num_ctx warns once per run - before the
      // overflow notice, which only fires past the ceiling.
      let ctxDangerWarned = false
      // 'length' truncation at a saturated window ends the run outright
      // (continuing cannot fit) - set by the ctxExhausted check below.
      let ctxExhaustedAborted = false
      // Ask (read-only) mode for this run - read once so a mid-run mode
      // switch can't half-block the loop.
      const readOnly = configService.getChatMode() === 'ask'
      // Set when ask mode bounced a mutating command - gates the
      // zero-change warning (the mode's own feedback covers them).
      let askModeBlocked = false
      // The create-project prompt is offered at most once per user turn
      projectPromptShownRef.current = false

      // Streaming: deltas accumulate into a live bubble rendered below the
      // message list. Whether a stream callback is passed at all is decided
      // by the pinned model's declared capability, not the provider id.
      const supportsStream = runProvider.capabilities(llmPin.model || '').streaming
      const makeStreamHandler = () => {
        streamedRef.current = ''
        const onDelta = supportsStream
          ? (delta: string) => {
              streamedRef.current += delta
              setStreamingText(streamedRef.current)
            }
          : undefined
        return { onDelta, getStreamed: () => streamedRef.current }
      }

      // Plan digest (L2b): the plan file is re-read on every agent turn
      // and its open items are injected into the prompt - the "read the
      // memo each time" workflow without a READ_FILE round-trip, and it
      // survives elision of earlier read results. Detection runs once;
      // a plan file the model writes mid-run registers in the write
      // path (agentState.planPath).
      const readPlanSection = async (): Promise<string> => {
        const project = projectService.getCurrentProject()
        if (!project?.isOpen || !window.electronAPI) return ''
        if (!agentState.planPath && !agentState.planScanDone) {
          agentState.planScanDone = true
          agentState.planPath = await detectPlanFile(project.rootPath)
          // An existing plan file is seen as a compressed digest, not
          // verbatim content - a WRITE/EDIT without a fresh read is
          // almost guaranteed to miss its SEARCH text (observed on real
          // runs: the model edits the plan "from the digest" and fails).
          // Arm the re-read gate pre-emptively; one READ_FILE releases
          // it for the rest of the run.
          if (agentState.planPath) agentState.readGate?.add(gateKey(agentState.planPath))
        }
        if (!agentState.planPath) return ''
        try {
          const res = await window.electronAPI.readFile(agentState.planPath)
          if (!res.success) {
            // Plan file gone (deleted externally / never committed) -
            // release the pre-armed gate so it cannot deadlock a WRITE
            // that recreates it.
            agentState.readGate?.delete(gateKey(agentState.planPath))
            agentState.planPath = null
            return ''
          }
          const rel = pathRelativeToRoot(agentState.planPath)
          let section = formatPlanDigest(rel, res.content ?? '')
          // Verified changes exist but every checkbox is still open: keep
          // a standing reminder inside the digest until the marks move.
          // The instruction-only version is reliably ignored (observed:
          // a run that declared all items done in prose while the file
          // kept every "- [ ]" - the phase gate then has nothing to see).
          if (section && (agentState.verifiedFiles?.size ?? 0) > 0
            && parsePlanItems(res.content ?? '').some(i => !i.checked)) {
            section += `Verified changes exist in this run (${agentState.verifiedFiles!.size} file(s)) - mark the matching items "- [x]" in ${rel} once the change for them is confirmed on disk.\n`
          }
          return section
        } catch {
          return ''
        }
      }

      // A model that emits reasoning but no reply text routes its output
      // to a channel this protocol cannot read only when the model is
      // channel-routed (gpt-oss/harmony) - retry cannot fix that, so it
      // surfaces immediately. A plain empty reply (context exhaustion,
      // transient - also what an always-thinking model like gemma4
      // produces on a bad turn) gets a couple of retries.
      const sendAgent = (
        input: string,
        onDelta: ((delta: string) => void) | undefined,
        onUsage: (u: NonNullable<Message['tokens']>) => void,
      ): Promise<string> => {
        // A saturating context window surfaces as truncated or empty
        // replies - shrink the biggest prompt contributors before the
        // call instead of burning retries on a request that cannot fit.
        // Past ~90% of num_ctx even the input about to be sent gets its
        // read bodies elided: a placeholder beats an empty reply.
        if (numCtxLimit > 0 && lastUsage?.input != null && lastUsage.input >= numCtxLimit * 0.7) {
          elideReadBodies()
          elideOlderAssistantBlocks()
          if (lastUsage.input >= numCtxLimit * 0.9) {
            input = elideFileBlocks(input)
            for (const b of pendingReadBodies) {
              if (input.includes(b.text)) {
                input = input.replace(
                  b.text,
                  `READ_FILE ${b.path} result:\n(content omitted - on disk, emit READ_FILE to view)`,
                )
                agentState.elidedReads.add(b.path)
              }
            }
          }
        }
        const attempt = (n: number): Promise<string> =>
          llmService.sendMessage(input, context, historyForRequest, onDelta, controller.signal, llmPin, true, onUsage, setRunStatus)
            .catch((e) => {
              if (e instanceof OllamaEmptyResponseError && !e.thinkingOnly && n < 2 && !controller.signal.aborted) {
                return attempt(n + 1)
              }
              throw e
            })
        return attempt(0)
      }

      for (let step = 0; step < MAX_STEPS + 1; step++) {
        if (controller.signal.aborted) break

        // Inject the plan's current position ahead of whatever this
        // step sends (the user request on step 0, tool results later).
        // The digest is re-read and re-injected fresh on every step, so
        // it must NOT be baked into historyForRequest below - an older
        // digest riding along in the history just re-spends input tokens
        // (paid tokens on API providers).
        const planSection = await readPlanSection()
        const sendInput = planSection ? `${planSection}\n${currentInput}` : currentInput

        const { onDelta, getStreamed } = makeStreamHandler()
        const callStart = performance.now()
        let usage: Message['tokens']
        const response = await sendAgent(sendInput, onDelta, (u) => { usage = u; lastUsage = u })
        const latencyMs = Math.round(performance.now() - callStart)
        // Persist this step's prompt (the user message at step 0, tool
        // results afterwards) into the running history. Without this each
        // READ_FILE/RUN_COMMAND result exists in context for exactly one
        // step - a model that re-reads the file gets only "unchanged",
        // the original content having already scrolled out of reach.
        historyForRequest.push({ role: 'user', content: currentInput, timestamp: Date.now() })

        // Commit the step message BEFORE running its commands: long work
        // (approval waits, RUN_COMMAND) then shows the card growing live
        // instead of a bare "Generating response" for the whole step.
        const stepMsg: Message = {
          role: 'assistant',
          content: getStreamed() || response,
          timestamp: Date.now(),
          latencyMs,
          model: runLabel || undefined,
          tokens: usage,
          rawContent: response,
        }
        setMessages((prev) => [...prev, stepMsg])
        // Patch the trailing message: object identity fails after the
        // first patch replaces stepMsg with a copy. Nothing else appends
        // messages while this step's commands are still executing.
        const updateStep = (patch: Partial<Message>) =>
          setMessages((prev) => {
            if (prev.length === 0) return prev
            const copy = [...prev]
            copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch }
            return copy
          })

        const editsBefore = agentState.editsApplied ?? 0
        const { display, feedback, needsContinuation, checkpoint, actions, readBodies, stopAtUserBoundary, blockedInAskMode } = await parseAndExecuteFileCommands(response, requestApproval, requestCommandApproval, runCommandAndWait, userMessage.content, requestProject, requestProcessApproval, agentState, readOnly, (acts) => updateStep({ actions: [...acts] }))
        if (blockedInAskMode) askModeBlocked = true
        if (controller.signal.aborted) break
        setStreamingText(null)
        if (checkpoint && checkpoint.length > 0) {
          checkpointsRef.current.push(checkpoint)
          setCanRollback(true)
          const cpRoot = projectService.getCurrentProject()?.rootPath
          if (cpRoot) checkpointService.push(cpRoot, checkpoint)
        }
        lastStepRanCommands = feedback.length > 0
        if (readBodies?.length) pendingReadBodies.push(...readBodies)

        // done_reason 'length' / finishReason MAX_TOKENS = the output
        // cap cut the reply off mid-turn, not a deliberate stop. The
        // loop hands the model another step below; this flag also tells
        // malformed-block feedback to steer it toward smaller output.
        const truncatedByLimit = usage?.doneReason === 'length'
        agentState.lastTurnTruncated = truncatedByLimit
        // 'length' with prompt+reply already at the ceiling is context
        // exhaustion, not an output-cap cut - the next request is
        // strictly larger, so "continue" can never fit. Break the run
        // instead of churning truncated giant blocks until the step
        // budget burns out.
        const ctxExhausted = truncatedByLimit && numCtxLimit > 0
          && ((usage?.input ?? 0) + (usage?.output ?? 0)) >= numCtxLimit * 0.95

        const stepActions = actions ? [...actions] : []
        if (truncatedByLimit) {
          stepActions.push({
            kind: 'notice' as const,
            label: ctxExhausted
              ? i18nService.t('Context window exhausted - stopping the run')
              : i18nService.t('Reply cut off at the token limit - asking the model to continue'),
            target: '',
            status: ctxExhausted ? 'failed' as const : 'ok' as const,
          })
        }

        // Progress = an applied write/edit or an executed shell command
        // (reads and feedback alone are not - the observed loop is
        // "failed edit + same prose" on every step). A repeat reply with
        // no progress advances the streak.
        const replyNorm = normReply(response)
        const madeProgress = (agentState.editsApplied ?? 0) > editsBefore
          || (actions ?? []).some((a) => a.kind === 'run')
        const isRepeat = replyNorm.length >= 50 && prevReplyNorm !== ''
          && replySimilarity(replyNorm, prevReplyNorm) >= 0.8
        stagnantStreak = !madeProgress && isRepeat ? stagnantStreak + 1 : 0
        prevReplyNorm = replyNorm
        if (stagnantStreak >= 2) {
          stagnantAborted = true
          stepActions.push({ kind: 'notice', label: i18nService.t('Stopped - the model kept repeating itself with no progress'), target: '', status: 'failed' })
        } else if (stagnantStreak === 1) {
          feedback.push(
            `WARNING - you repeated your previous reply almost word-for-word and changed nothing on disk. ` +
            `Do not repeat yourself: emit a file command that differs from your last attempt, or tell the user you are stuck and why.`
          )
          stepActions.push({ kind: 'notice', label: i18nService.t('Repeated reply with no progress - warning the model'), target: '', status: 'failed' })
        }
        // A prompt already larger than num_ctx means Ollama silently
        // dropped the system prompt for this step - degraded, looping
        // output is the typical symptom. Surface it once per run.
        // At ~80% of num_ctx a normal-size reply is the last one that
        // still fits - warn once so the user sees saturation coming,
        // and tell the model to close out instead of starting more
        // large reads or writes.
        if (!ctxDangerWarned && !ctxOverflowWarned && numCtxLimit > 0
          && (usage?.input ?? 0) >= numCtxLimit * 0.8 && (usage?.input ?? 0) <= numCtxLimit) {
          ctxDangerWarned = true
          stepActions.push({
            kind: 'notice',
            label: i18nService.t('Context window nearly full'),
            target: `~${usage!.input} of ${numCtxLimit} tokens`,
            status: 'failed',
          })
          feedback.push(
            `NOTE: the prompt is already at ~${Math.round((usage!.input! / numCtxLimit) * 100)}% of the ${numCtxLimit}-token context window - ` +
            `wrap up the task now: no new large READ_FILE calls, keep replies short, emit only small file commands.`
          )
        }
        if (!ctxOverflowWarned && numCtxLimit > 0 && (usage?.input ?? 0) > numCtxLimit) {
          ctxOverflowWarned = true
          stepActions.push({ kind: 'notice', label: i18nService.t('Prompt larger than num_ctx - model output may degrade'), target: `~${usage!.input} tokens > ${numCtxLimit}`, status: 'failed' })
          feedback.push(
            `NOTE: the prompt for this step already exceeded the context window (~${usage!.input} tokens > num_ctx ${numCtxLimit}). ` +
            `Model output may degrade - prefer short replies and small file commands.`
          )
        }

        const finalText = display || getStreamed()
        updateStep({
          content: finalText || stepMsg.content,
          actions: stepActions.length > 0 ? stepActions : undefined,
          canRetryInCodeMode: readOnly && askModeBlocked ? true : undefined,
        })

        historyForRequest.push({ role: 'assistant', content: response, timestamp: Date.now() })

        // The watchdog kills the run outright - no nudge, no closing
        // summary (a looping model would just narrate a fake one).
        if (stagnantAborted) break

        // Context exhaustion likewise cannot recover inside this run -
        // the ending notice below offers the num_ctx raise button.
        if (ctxExhausted) {
          ctxExhaustedAborted = true
          break
        }

        // A permission question ending inside a user-scoped run is the
        // user's stop line, not a deferral - ending here hands the
        // question back to the user instead of answering it ourselves.
        if (stopAtUserBoundary) {
          boundaryStopped = true
          break
        }

        // No command results the AI needs -> the AI is done. Except: if it
        // declared completion while an earlier command/edit failure is still
        // unresolved, give it one chance to fix or explicitly justify it.
        if (!needsContinuation) {
          if (truncatedByLimit) {
            // The output cap cut the reply off mid-turn - the model
            // never chose to stop, so this is not a completion. Hand it
            // another step to finish the thought, in smaller pieces so
            // the same limit is not hit again.
            currentInput =
              `Your last reply was cut off by the output token limit mid-turn. ` +
              `Continue exactly where you stopped - keep this turn SHORT: minimal ` +
              `prose, and emit file content in small pieces (a few EDIT_FILE ` +
              `blocks, or a short WRITE_FILE part appended with EDIT_FILE).`
            continue
          }
          if ((agentState.unresolvedFailure || agentState.unresolvedEdit) && !failureNudged) {
            failureNudged = true
            const last = agentState.lastRunFailure
            currentInput =
              `Before you finish: earlier work in this session is unresolved.` +
              (agentState.unresolvedEdit
                ? ` A WRITE_FILE/EDIT_FILE failed and never succeeded - the file on disk may still be unmodified.`
                : '') +
              (last
                ? ` Most recently "${last.command}" (${last.timedOut ? 'timed out' : `exit code ${last.exitCode}`}) printed:\n${last.tail}\n`
                : ' ') +
              `If it has already been resolved or is unrelated to the user's request ` +
              `(e.g. a test that was already failing before your changes), ` +
              `say so briefly in your final answer - otherwise fix it now. ` +
              `Never claim edits were applied or tests pass unless they actually were/did.`
            continue
          }
          // The model declared completion again while a write/edit that
          // failed was still never retried. The nudge above already gave it
          // a chance to respond; if it now claims success, surface the
          // discrepancy to the user instead of trusting the claim.
          if (failureNudged) warnUnresolvedEdit()
          // A step that ran commands left only note lines visible - ask
          // once for a closing answer. It goes through the normal loop
          // (not a one-shot call) so a model that emits commands or
          // defers here gets results fed back like any other step
          // instead of ending the run mid-task.
          if (lastStepRanCommands && !summaryAsked) {
            summaryAsked = true
            // The lead must match the actual outcome - asking for "what
            // you did" when nothing applied invites the model to report
            // changes that do not exist on disk.
            currentInput =
              ((agentState.editsAttempted ?? 0) > 0 && (agentState.editsApplied ?? 0) === 0
                ? `The file operations FAILED - no change was applied to disk. `
                : `The file operations completed${agentState.unresolvedEdit ? ', though at least one change was never applied' : ''}. `) +
              `Reply to the user with a brief summary of what actually happened, ` +
              `in the same language as the user's request. Do not claim a change ` +
              `exists on disk unless it was actually applied. ` +
              `Do not emit any file commands.`
            continue
          }
          break
        }

        // Plan phase gate (L5): a plan phase was just checked complete
        // and the model is about to start the next one - the user
        // approves the transition (the question is about the approach,
        // not a diff). Declining ends the run at the boundary.
        if (agentState.phaseGate) {
          const gate = agentState.phaseGate
          agentState.phaseGate = null
          agentState.phaseGatesFired.add(`${gate.file}:${gate.done}`)
          const choice = await requestProcessApproval({
            title: i18nService.t('Plan phase complete'),
            body: i18nService.t('Phase "{done}" is marked complete in {file}. Proceed to "{next}"?')
              .replace('{done}', gate.done).replace('{file}', gate.file).replace('{next}', gate.next),
            options: [
              { id: 'continue', label: i18nService.t('Proceed to next phase') },
              { id: 'stop', label: i18nService.t('Stop here') },
            ],
          })
          if (controller.signal.aborted) break
          if (choice !== 'continue') {
            boundaryStopped = true
            stepActions.push({ kind: 'notice', label: i18nService.t('Stopped at phase transition'), target: gate.done, status: 'ok' })
            updateStep({ actions: stepActions })
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `⏹️ ${i18nService.t('Stopped: the user chose not to proceed to the next plan phase.')}`,
              timestamp: Date.now(),
              isError: true,
            }])
            break
          }
          feedback.push(`NOTE: the user approved proceeding to the next plan phase ("${gate.next}").`)
        }

        // Small models burn steps re-verifying finished work - tell them
        // the remaining step budget and how to close out the task. The
        // STATE line first reminds them what they have already done so
        // they neither redo it nor ask the user about it.
        currentInput =
          formatStateDigest(agentState) +
          `Command execution results:\n${feedback.join('\n\n')}\n\n` +
          // Models often abandon a failed edit and keep reading files or
          // running tests instead of retrying it. While any write/edit is
          // still outstanding, remind every step so the failure cannot be
          // silently dropped.
          (agentState.unresolvedEdit
            ? `Reminder: an earlier EDIT_FILE/WRITE_FILE failed and no file change has succeeded since - the target file is still UNCHANGED on disk. Re-emit the change now (EDIT_FILE with an exact SEARCH block, or WRITE_FILE with the full file content) before continuing.\n\n`
            : '') +
          `(Step ${Math.min(step + 1, MAX_STEPS)} of ${MAX_STEPS}) ` +
          `Continue with the user's request. If the work is already done, ` +
          `reply with the final answer only - no file commands.`
      }

      // The step budget ran out mid-work, before the in-loop summary
      // turn was reached - still give the model one wrap-up reply so the
      // user gets an answer instead of a bare trail of command notes.
      // A boundary-stopped run already closed on the model's own
      // question to the user - no summary.
      if (!controller.signal.aborted && lastStepRanCommands && !summaryAsked && !boundaryStopped && !stagnantAborted && !ctxExhaustedAborted) {
        summaryAsked = true
        try {
          const { onDelta } = makeStreamHandler()
          const summary = await sendAgent(
            ((agentState.editsAttempted ?? 0) > 0 && (agentState.editsApplied ?? 0) === 0
              ? `The file operations FAILED - no change was applied to disk. `
              : `The file operations completed${agentState.unresolvedEdit ? ', though at least one change was never applied' : ''}. `) +
            `Reply to the user with a brief summary of what actually happened, ` +
            `in the same language as the user's request. Do not claim a change ` +
            `exists on disk unless it was actually applied. ` +
            `Do not emit any file commands.`,
            onDelta, () => {})
          const text = summary.trim()
          if (text) {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: text,
              timestamp: Date.now(),
              model: runLabel || undefined,
            }])
          }
        } catch {
          // The closing summary is best-effort - the work results stand.
        }
      }
      // Whatever ended the run - budget exhaustion, cancellation, a
      // clean finish - a write/edit that failed and was never retried
      // leaves the file silently unmodified. Warn once.
      warnUnresolvedEdit()

      // Honest endings: the balloons below state disk facts the model's
      // prose cannot override. A watchdog-killed run says why it stopped;
      // a run that attempted writes but applied none gets an explicit
      // "nothing changed" notice.
      if (stagnantAborted) {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `⏹️ ${i18nService.t('Stopped: the model kept repeating the same reply without changing anything. The context window may be saturated - try a new chat or raise num_ctx in Settings.')}`,
          timestamp: Date.now(),
          isError: true,
        }])
      } else if (ctxExhaustedAborted) {
        // The window is already full - continuing the run could not
        // fit the next prompt. Offer the recommended guide value when
        // the model has one, else double the current setting.
        const recommended = recommendedNumCtxForModel(llmPin.model ?? '')
        const raise = recommended && recommended > numCtxLimit ? recommended : numCtxLimit * 2
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `⏹️ ${i18nService.t('Stopped: the context window is full and the model kept being cut off mid-reply. Start a new chat, or raise num_ctx and retry.')}`,
          timestamp: Date.now(),
          isError: true,
          canRaiseNumCtx: raise,
        }])
      } else if ((agentState.editsAttempted ?? 0) > 0
        && (agentState.editsApplied ?? 0) === 0
        && !askModeBlocked && !controller.signal.aborted) {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `⚠️ ${i18nService.t('No file change was applied in this run - completion claims above may not match the disk.')}`,
          timestamp: Date.now(),
          isError: true,
        }])
      }

      // Compact older history into the rolling summary - keeps model
      // input bounded on long chats (fire-and-forget, Settings-gated).
      if (configService.getAutoSummarize()) {
        void compactHistory(llmPin, controller.signal)
      }

    } catch (error) {
      console.error('Error sending message:', error)
      // User-cancelled: keep whatever was streamed so far, no error message
      if (!controller.signal.aborted) {
        const errorMessage: Message = {
          role: 'assistant',
          content: `${i18nService.t('Error')}: ${error instanceof Error ? error.message : i18nService.t('Failed to get response')}`,
          timestamp: Date.now(),
          isError: true,
        }
        // An empty Ollama reply with the prompt already near num_ctx is
        // a saturated context window, not a model failure - say so, and
        // offer a session-only num_ctx raise as the one-click recovery.
        if (error instanceof OllamaEmptyResponseError && lastUsage?.input != null) {
          const numCtx = configService.getOllamaNumCtx() ?? 4096
          const pct = Math.round((lastUsage.input / numCtx) * 100)
          if (pct >= 70) {
            errorMessage.content += `\n\n${i18nService.t('The request used about {pct}% of the model\'s {ctx}-token context window, so it may be saturated. Starting a new chat - or raising num_ctx - can help.').replace('{pct}', String(pct)).replace('{ctx}', String(numCtx))}`
            errorMessage.canRaiseNumCtx = numCtx * 2
          }
        }
        setMessages((prev) => [...prev, errorMessage])
      } else if (streamedRef.current) {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: streamedRef.current,
          timestamp: Date.now(),
          model: runLabel || undefined,
        }])
      }
      setStreamingText(null)
      streamedRef.current = ''
      setRunStatus(null)
    } finally {
      setIsLoading(false)
      setAbortController(null)
      setActiveModel('')
    }
  }

  const handleCancel = () => {
    // If approval dialogs are open, treat cancel as reject-all
    resolveApproval(null)
    resolveCommandApproval(null)
    resolveProject(null)
    if (abortController) {
      abortController.abort()
      setAbortController(null)
      setIsLoading(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Show remaining budget as a percentage only - never expose the
  // dollar amount, which would reveal the organization's actual cap.
  const budgetPct = managedUsage?.maxBudget != null && managedUsage.maxBudget > 0
    ? Math.max(0, (managedUsage.maxBudget - managedUsage.spend) / managedUsage.maxBudget * 100)
    : null

  // Fold consecutive assistant messages that carry agent actions into a
  // single collapsible "Agent run" card - the trace of one user request.
  // Step prose (the model's narration between commands) stays inside its
  // step; legacy messages without `actions` render as plain bubbles.
  const renderItems: ({ kind: 'msg'; m: Message; index: number } | { kind: 'run'; steps: Message[] })[] = []
  let lastRunIndex = -1
  messages.forEach((m, index) => {
    const last = renderItems[renderItems.length - 1]
    if (m.role === 'assistant' && m.actions?.length && last?.kind === 'run') {
      last.steps.push(m)
    } else if (m.role === 'assistant' && m.actions?.length) {
      renderItems.push({ kind: 'run', steps: [m] })
      lastRunIndex = renderItems.length - 1
    } else {
      renderItems.push({ kind: 'msg', m, index })
    }
  })

  return (
    <div className="chat">
      <style>{MARKDOWN_CSS}</style>
      <div className="chat-header">
        <div className="chat-title">
          <h3>{t('AI Chat')}</h3>
          {currentModel && (
            <span className="model-badge" title={`${t('Current model')}: ${currentModel}`}>
              {currentModel}
            </span>
          )}
          {budgetPct != null && (
            <span
              className={`budget-badge ${budgetPct <= 0 ? 'exhausted' : budgetPct < 20 ? 'low' : ''}`}
              title={`${t('Allotted budget remaining')}: ${budgetPct.toFixed(1)}%${managedUsage?.resetAt ? ` · ${t('Resets')}: ${managedUsage.resetAt}` : ''}`}
            >
              {t('Budget')} {budgetPct.toFixed(1)}%
            </span>
          )}
        </div>
        <div className="chat-header-actions">
          {canRollback && (
            <button
              className="rollback-button"
              onClick={handleRollback}
              title={t('Undo the last AI file changes')}
            >
              ↩ {t('Rollback')}
            </button>
          )}
          {confirmClearChat ? (
            <>
              <button className="clear-chat-button" onClick={handleClearChat}>
                {t('Confirm Clear')}
              </button>
              <button className="clear-chat-button" onClick={() => setConfirmClearChat(false)}>
                {t('Cancel')}
              </button>
            </>
          ) : (
            <button
              className="clear-chat-button"
              onClick={() => setConfirmClearChat(true)}
              disabled={messages.length === 0}
              title={t('Clear this conversation')}
            >
              {t('Clear')}
            </button>
          )}
          {onToggleFocus && (
            <button
              className={`settings-button ${chatFocus ? 'active' : ''}`}
              onClick={onToggleFocus}
              title={chatFocus ? t('Exit chat focus') : t('Chat focus')}
            >
              {chatFocus ? '◫' : '⛶'}
            </button>
          )}
          <button className="settings-button" onClick={onOpenSettings} title={t('Settings')}>
            ⚙️
          </button>
        </div>
      </div>
      <div className="chat-body">
        {chatFocus && (
          <div className="chat-list-rail">
            <div className="chat-list-header">
              <span>{t('Chats')}</span>
              <button className="chat-list-new" onClick={handleNewChat} title={t('New chat')}>
                +
              </button>
            </div>
            <div className="chat-list-items">
              {convList.length === 0 && (
                <div className="chat-list-empty">{t('No chat history yet')}</div>
              )}
              {convList.map((c) => (
                <div
                  key={c.id}
                  className={`chat-list-item${c.id === convId ? ' active' : ''}`}
                  onClick={() => void handleSelectConversation(c)}
                >
                  <div className="chat-list-item-text">
                    <div className="chat-list-item-title">{c.title || t('Untitled chat')}</div>
                    <div className="chat-list-item-meta">
                      {(c.projectPath ? c.projectPath.split(/[\\/]/).pop() : t('No project')) +
                        ' · ' +
                        formatConvTime(c.updatedAt)}
                    </div>
                  </div>
                  {convDeleteId === c.id ? (
                    <button
                      className="chat-list-delete confirm"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDeleteConversation(c.id)
                      }}
                    >
                      {t('Delete?')}
                    </button>
                  ) : (
                    <button
                      className="chat-list-delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConvDeleteId(c.id)
                      }}
                      title={t('Delete this chat')}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="chat-main">
      <div className="chat-messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
        {messages.length === 0 && (
          <div className="chat-welcome">
            <h4>{t('Welcome to AI Chat')}</h4>
            <p>
              {isConfigured 
                ? t('Ask me anything about your code')
                : t('Please configure your Gemini API key in settings to start chatting')}
            </p>
          </div>
        )}
        {renderItems.map((item, ri) => item.kind === 'run' ? (
          // Only the live run stays expanded: it folds itself when the
          // run ends (open flips false), and older runs render folded.
          // lastRunIndex - not "last item" - because trailing non-action
          // messages (unresolved-edit warning, closing summary) must not
          // collapse the still-running card mid-flight. A manual toggle
          // mid-run wins because React only re-applies the attribute
          // when this expression changes.
          <React.Fragment key={`run-${ri}`}>
          <details className="agent-run" open={isLoading && ri === lastRunIndex}>
            <summary>
              <span className="agent-run-title">⚙️ {t('Agent run')}</span>
              <span className="agent-run-meta">
                {item.steps.reduce((n, s) => n + (s.actions?.length ?? 0), 0)} {t('actions')}
                {(() => {
                  const ms = item.steps.reduce((n, s) => n + (s.latencyMs ?? 0), 0)
                  return ms > 0 ? ` · ${formatLatency(ms)}` : ''
                })()}
              </span>
            </summary>
            {item.steps.map((m, si) => {
              const prose = stripNoteLines(m.content).trim()
              return (
                <div className="agent-run-step" key={si}>
                  <div className="agent-run-step-head">
                    <span>{t('Step')} {si + 1}</span>
                    {(m.latencyMs != null || m.tokens) && (
                      <span className="agent-run-step-meta">
                        {[
                          m.latencyMs != null ? formatLatency(m.latencyMs) : null,
                          m.tokens
                            ? `in ${m.tokens.input?.toLocaleString() ?? '?'} / out ${m.tokens.output?.toLocaleString() ?? '?'} ${t('tokens')}`
                            : null,
                          m.tokens?.cached ? `cached ${m.tokens.cached.toLocaleString()}` : null,
                        ].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </div>
                  {m.actions!.map((a, ai) => (
                    <div className={`agent-action ${a.status}`} key={ai}>
                      <span className="agent-action-icon">{actionIcon(a)}</span>
                      <span className="agent-action-text">
                        {a.label}{a.target ? ': ' : ''}
                        {a.target && <code className="agent-action-target">{a.target}</code>}
                        {a.detail && <span className="agent-action-detail"> ({a.detail})</span>}
                      </span>
                    </div>
                  ))}
                  {prose && <div className="agent-run-prose markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(prose) }} />}
                </div>
              )
            })}
          </details>
          {ri === renderItems.length - 1
            && item.steps[item.steps.length - 1]?.canRetryInCodeMode && (
            <button
              className="retry-code-mode-button"
              onClick={handleRetryInCodeMode}
              disabled={isLoading}
            >
              {t('Retry in code mode')}
            </button>
          )}
          </React.Fragment>
        ) : (
          <div
            key={item.index}
            className={`chat-message ${item.m.role}`}
          >
            <div className="message-content">
              <div className="message-role">
                {t(item.m.role)}
                {item.m.role === 'assistant' && item.m.model && ` (${item.m.model})`}
                {item.m.role === 'assistant' && item.index === messages.length - 1 && !isLoading && (
                  <button
                    className="retry-button"
                    onClick={handleRetry}
                    title={t('Regenerate response')}
                  >
                    ↻
                  </button>
                )}
                {item.m.canRaiseNumCtx != null && !isLoading && (
                  <button
                    className="retry-button"
                    onClick={() => void handleRaiseNumCtx(item.m.canRaiseNumCtx!)}
                    title={t('Raise num_ctx for this session and retry')}
                  >
                    {t('num_ctx {n}').replace('{n}', String(item.m.canRaiseNumCtx))} ↻
                  </button>
                )}
              </div>
              <div className="message-text">
                {item.m.role === 'assistant'
                  ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.m.content) }} />
                  : item.m.content}
              </div>
              {(item.m.latencyMs != null || item.m.tokens) && (
                <div className="message-latency">
                  ({[
                    item.m.latencyMs != null ? formatLatency(item.m.latencyMs) : null,
                    item.m.tokens
                      ? `in ${item.m.tokens.input?.toLocaleString() ?? '?'} / out ${item.m.tokens.output?.toLocaleString() ?? '?'} ${t('tokens')}`
                      : null,
                    item.m.tokens?.cached ? `cached ${item.m.tokens.cached.toLocaleString()}` : null,
                  ].filter(Boolean).join(' · ')})
                </div>
              )}
              {item.m.role === 'assistant' && item.m.canRetryInCodeMode && item.index === messages.length - 1 && (
                <button
                  className="retry-code-mode-button"
                  onClick={handleRetryInCodeMode}
                  disabled={isLoading}
                >
                  {t('Retry in code mode')}
                </button>
              )}
            </div>
          </div>
        ))}
        {streamingText && (
          <div className="chat-message assistant">
            <div className="message-content">
              <div className="message-role">{t('assistant')}{(activeModel || currentModel) && ` (${activeModel || currentModel})`}</div>
              <div className="message-text">{streamingText}</div>
            </div>
          </div>
        )}
        {isLoading && (
          <div className="chat-message assistant">
            <div className="message-content">
              <div className="message-role">{t('assistant')}{(activeModel || currentModel) && ` (${activeModel || currentModel})`}</div>
              <div className="message-text loading">
                <span className="loading-dots">{runStatus || t('Generating response')}</span>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={isConfigured ? t('Type your message...') : t('Configure API key in settings to start chatting')}
          rows={3}
          disabled={isLoading || !isConfigured}
        />
        <div className="chat-input-bar">
          <div
            className="chat-mode-switch"
            title={chatMode === 'ask'
              ? t('Ask mode: read-only - the AI can inspect files but cannot change them.')
              : t('Agent mode: the AI can edit files and run commands (with approval).')}
          >
            <button
              className={`chat-mode-btn mode-agent${chatMode === 'agent' ? ' active' : ''}`}
              onClick={() => {
                if (chatMode !== 'agent') {
                  configService.setChatMode('agent')
                  setChatMode('agent')
                }
              }}
            >
              {t('Agent mode')}
            </button>
            <button
              className={`chat-mode-btn mode-ask${chatMode === 'ask' ? ' active' : ''}`}
              onClick={() => {
                if (chatMode !== 'ask') {
                  configService.setChatMode('ask')
                  setChatMode('ask')
                }
              }}
            >
              {t('Ask mode')}
            </button>
          </div>
          <button
            onClick={isLoading ? handleCancel : handleSend}
            disabled={!isLoading && (!input.trim() || !isConfigured)}
            className={isLoading ? 'send-button stop-button' : 'send-button'}
            title={isLoading ? t('Cancel request') : undefined}
          >
            {isLoading ? `■ ${t('Stop')}` : isConfigured ? t('Send') : t('Configure API Key')}
          </button>
        </div>
      </div>
        </div>
      </div>
      {pendingEdits && pendingEdits.length > 0 && (
        <FileEditApproval
          edits={pendingEdits}
          note={approvalNote}
          onApprove={resolveApproval}
          onReject={() => resolveApproval(null)}
          onRejectOne={handleRejectOneEdit}
          onCancel={handleCancel}
        />
      )}
      {pendingCommands && pendingCommands.length > 0 && (
        <CommandApproval
          commands={pendingCommands}
          note={approvalNote}
          onApprove={resolveCommandApproval}
          onReject={() => resolveCommandApproval(null)}
          onRejectOne={handleRejectOneCommand}
          onCancel={handleCancel}
        />
      )}
      {processPrompt && (
        <ProcessApproval
          prompt={processPrompt}
          onChoose={resolveProcess}
          onCancel={handleCancel}
        />
      )}
      {showProjectModal && (
        <CreateProjectModal
          onCreated={resolveProject}
          onCancel={() => resolveProject(null)}
        />
      )}
    </div>
  )
}

export default Chat
