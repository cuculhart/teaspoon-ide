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
import CreateProjectModal from './CreateProjectModal'
import { i18nService, useT } from '../services/i18nService'
import { findFileCommands } from '../services/commandParser'
import { OllamaEmptyResponseError } from '../services/ollamaService'
import type { AgentAction } from '../types/agent'
import { commandResultVerdict, formatStateDigest, TEST_COMMAND_RE } from '../services/toolFeedback'
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

// Parse and execute file commands from AI response.
// Reads/lists run immediately; writes are collected and held until the
// user approves them via the approval callback.
// Returns display text (commands replaced by readable notes) and
// results to send back to the model so it can continue its work.
async function parseAndExecuteFileCommands(
  response: string,
  requestApproval: (edits: FileEdit[]) => Promise<FileEdit[] | null>,
  requestCommandApproval: (commands: string[]) => Promise<string[] | null>,
  runCommandAndWait: (command: string) => Promise<RunResult>,
  userText: string,
  requestProject?: () => Promise<string | null>,
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
  },
  // Called each time an action lands so the step card grows live instead
  // of appearing only after every command in the step has finished.
  onAction?: (actions: AgentAction[]) => void
): Promise<CommandExecutionResult> {
  const { commands, docSpans } = findFileCommands(response)

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
  // "how is X created" / "where is X written" are questions, not
  // file-creation requests - a fenced snippet there is an explanation.
  // Missing a real nudge is cheap; a false one burns a paid turn.
  const creationIntent = /(作成|作って|作る|生成|実装|create|write|generate|make|build)/i.test(userText)
    && !/(方法|作り方|作りかた|やり方|手順|書き方|教えて|書かれ|記載さ|記述さ|どうやって|どうすれば|how to|how do|how can|what is|where is)/i.test(userText)
  // A model that still shows a fence after being told is displaying it on
  // purpose (e.g. a shell example) - re-nudging wastes a step.
  const codeShownNudge = commands.length === 0 && creationIntent && hasFence && !state?.codeShownNudged

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

  // No project open but the model wants to write files: offer to create
  // a project folder instead of rejecting every command. When the user
  // creates one, path resolution below picks it up via projectService.
  if (requestProject && !projectService.getCurrentProject()?.isOpen
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
  if (deferred) {
    feedback.push(
      'You ended your turn asking the user to say "continue" (or similar) before emitting the rest of the work. ' +
      'Do not wait for the user - continue NOW in this response and emit the remaining file commands or output you listed.'
    )
    pushAction({ kind: 'notice', label: i18nService.t('Deferred to a later response - asking the model to continue now'), target: '', status: 'failed' })
    needsContinuation = true
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

  // First pass: run reads/lists, collect writes for approval
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]
    const resolved = resolveFilePath(cmd.arg)

    if (cmd.type === 'write') {
      if (resolved.error || !resolved.path) {
        notes[i] = `⚠️ ${i18nService.t('Rejected write to')} ${cmd.arg}: ${resolved.error}`
        pushAction({ kind: 'write', label: i18nService.t('Rejected write to'), target: cmd.arg, status: 'failed', detail: resolved.error })
        feedback.push(`WRITE_FILE ${cmd.arg}: rejected - ${resolved.error}`)
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
          continue
        }
        const applied = applyEditBlocks(oldContent, parseEditBlocks(item.body))
        if (applied.error) {
          batchEditFailed = true
          if (state) state.editFailCount++
          notes[item.index] = `⚠️ ${i18nService.t('Edit failed for')} ${item.arg}: ${applied.error}`
          pushAction({ kind: 'edit', label: i18nService.t('Edit failed for'), target: item.arg, status: 'failed', detail: applied.error })
          // Weak models recover better from a tiny complete example than
          // from prose rules. After repeated failures, steer to WRITE_FILE
          // (a full-file rewrite is easier for them than diff syntax).
          let hint = ` A complete EDIT_FILE looks like this:\n` +
            `// EDIT_FILE: ${item.arg}\n<<<<<<< SEARCH\n<exact lines to replace>\n=======\n<new lines>\n>>>>>>> REPLACE\n// END_EDIT_FILE`
          if (state && state.editFailCount >= 2) {
            hint += `\nEDIT_FILE has failed ${state.editFailCount} times in a row - stop using it and emit "// WRITE_FILE: ${item.arg}" with the FULL corrected file content instead.`
          }
          feedback.push(`${label} ${item.arg}: failed - ${applied.error}.${hint}`)
          needsContinuation = true
          continue
        }
        if (applied.alreadyApplied) {
          // The desired end-state is already on disk (e.g. the model
          // re-sent a diff that succeeded earlier). No write, no approval
          // dialog - report it as done so the model moves on and the
          // unresolved-edit tracker is cleared.
          if (state) state.editFailCount = 0
          notes[item.index] = `✅ ${i18nService.t('Already applied')}: ${pathRelativeToRoot(item.path)}`
          pushAction({ kind: 'edit', label: i18nService.t('Already applied'), target: pathRelativeToRoot(item.path), status: 'ok' })
          feedback.push(`${label} ${item.arg}: already applied - the replacement text is already in the file; no change needed`)
          batchEditSucceeded = true
          continue
        }
        if (state) state.editFailCount = 0
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
          continue
        }
        const edit: FileEdit = { filePath: item.path, oldContent, newContent: applied.content! }
        edits.push(edit)
        planByEdit.set(edit, item)
      }
    }

    // All edits may have failed to apply - don't open an empty modal
    const approved = edits.length > 0 ? await requestApproval(edits) : []
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
          // The model already knows the new content - it wrote it - so a
          // follow-up READ_FILE can be answered "unchanged" as well.
          state.readCache?.set(item.path, edit.newContent)
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
      }
    }

    if (state) {
      if (batchEditFailed) state.unresolvedEdit = true
      else if (batchEditSucceeded) state.unresolvedEdit = false
    }
  }

  // Ask the user to approve shell commands before running them
  if (pendingRuns.length > 0) {
    const approvedCommands = await requestCommandApproval(pendingRuns.map(r => r.command))
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
  if (deferred) {
    display += `\n\n⚠️ ${i18nService.t('Deferred to a later response - asking the model to continue now')}`
  }

  return { display: display.trim(), feedback, needsContinuation, checkpoint, actions, readBodies }
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
  const approvalResolverRef = useRef<((edits: FileEdit[] | null) => void) | null>(null)
  const [pendingCommands, setPendingCommands] = useState<string[] | null>(null)
  const commandResolverRef = useRef<((commands: string[] | null) => void) | null>(null)
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
  const requestApproval = (edits: FileEdit[]): Promise<FileEdit[] | null> => {
    return new Promise((resolve) => {
      approvalResolverRef.current = resolve
      setPendingEdits(edits)
    })
  }

  const resolveApproval = (edits: FileEdit[] | null) => {
    approvalResolverRef.current?.(edits)
    approvalResolverRef.current = null
    setPendingEdits(null)
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
  const requestCommandApproval = (commands: string[]): Promise<string[] | null> => {
    return new Promise((resolve) => {
      commandResolverRef.current = resolve
      setPendingCommands(commands)
    })
  }

  const resolveCommandApproval = (commands: string[] | null) => {
    commandResolverRef.current?.(commands)
    commandResolverRef.current = null
    setPendingCommands(null)
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
      if (conv) {
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

  const sendToAI = async (userMessage: Message, historyBase: Message[]) => {
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
        lastRunFailure: null as { command: string; exitCode: number | null; timedOut: boolean; tail: string } | null,
        preEditTestFailure: null as { command: string; tail: string } | null,
        readCache: new Map<string, string>(),
        readFiles: new Set<string>(),
        modifiedFiles: new Set<string>(),
        lastTurnTruncated: false,
        elidedReads: new Set<string>(),
        shrinkWarned: new Set<string>(),
      }
      // READ_FILE result bodies fed back so far this run - their copies
      // in historyForRequest get swapped for placeholders when the
      // context approaches saturation.
      let pendingReadBodies: { path: string; text: string }[] = []
      const numCtxLimit = llmPin.provider === 'ollama'
        ? (configService.getOllamaNumCtx() ?? 4096)
        : 0
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

        const { onDelta, getStreamed } = makeStreamHandler()
        const callStart = performance.now()
        let usage: Message['tokens']
        const response = await sendAgent(currentInput, onDelta, (u) => { usage = u; lastUsage = u })
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

        const { display, feedback, needsContinuation, checkpoint, actions, readBodies } = await parseAndExecuteFileCommands(response, requestApproval, requestCommandApproval, runCommandAndWait, userMessage.content, requestProject, agentState, (acts) => updateStep({ actions: [...acts] }))
        if (controller.signal.aborted) break
        setStreamingText(null)
        if (checkpoint && checkpoint.length > 0) {
          checkpointsRef.current.push(checkpoint)
          setCanRollback(true)
        }
        lastStepRanCommands = feedback.length > 0
        if (readBodies?.length) pendingReadBodies.push(...readBodies)

        // done_reason 'length' / finishReason MAX_TOKENS = the output
        // cap cut the reply off mid-turn, not a deliberate stop. The
        // loop hands the model another step below; this flag also tells
        // malformed-block feedback to steer it toward smaller output.
        const truncatedByLimit = usage?.doneReason === 'length'
        agentState.lastTurnTruncated = truncatedByLimit

        const finalText = display || getStreamed()
        const stepActions = truncatedByLimit
          ? [...(actions ?? []), {
              kind: 'notice' as const,
              label: i18nService.t('Reply cut off at the token limit - asking the model to continue'),
              target: '',
              status: 'ok' as const,
            }]
          : actions
        updateStep({
          content: finalText || stepMsg.content,
          actions: stepActions && stepActions.length > 0 ? stepActions : undefined,
        })

        historyForRequest.push({ role: 'assistant', content: response, timestamp: Date.now() })

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
            currentInput =
              `The file operations completed. Reply to the user with a brief summary ` +
              `of what you did, in the same language as the user's request. ` +
              `Do not emit any file commands.`
            continue
          }
          break
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
      if (!controller.signal.aborted && lastStepRanCommands && !summaryAsked) {
        summaryAsked = true
        try {
          const { onDelta } = makeStreamHandler()
          const summary = await sendAgent(
            `The file operations completed. Reply to the user with a brief summary ` +
            `of what you did, in the same language as the user's request. ` +
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
          <details className="agent-run" open={isLoading && ri === lastRunIndex} key={`run-${ri}`}>
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
      {pendingEdits && pendingEdits.length > 0 && (
        <FileEditApproval
          edits={pendingEdits}
          onApprove={resolveApproval}
          onReject={() => resolveApproval(null)}
          onRejectOne={handleRejectOneEdit}
          onCancel={handleCancel}
        />
      )}
      {pendingCommands && pendingCommands.length > 0 && (
        <CommandApproval
          commands={pendingCommands}
          onApprove={resolveCommandApproval}
          onReject={() => resolveCommandApproval(null)}
          onRejectOne={handleRejectOneCommand}
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
