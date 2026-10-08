import React, { useState, useRef, useEffect } from 'react'
import { llmService } from '../services/llmService'
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
  // The model's raw output, before command blocks were replaced with
  // readable notes. Sent back as history so the model never sees the
  // "Ran: ..." note format (small models imitate it and emit fake notes).
  rawContent?: string
}

const formatLatency = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

// Drop execution-note lines (▶️ Ran:, ⚠️ ..., 📖 ..., etc.) from display text.
// Used when sending legacy assistant messages back as model history.
const stripNoteLines = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*(▶️|⚠️|📖|🔍|⏭️|↩️|✅)/u.test(l))
    .join('\n')

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
  // Snapshot of files before AI writes - enables rollback
  checkpoint?: { path: string; prevContent: string; existed: boolean }[]
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
): { content?: string; error?: string } {
  if (blocks.length === 0) {
    return { error: 'no SEARCH/REPLACE blocks found' }
  }
  const fileEol = content.includes('\r\n') ? '\r\n' : '\n'
  let out = content
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
      return { error: `SEARCH block #${i + 1} not found in the file (re-read the file and retry)` }
    }
    if (out.indexOf(search, idx + 1) !== -1) {
      return { error: `SEARCH block #${i + 1} matches multiple locations - include more surrounding context` }
    }
    out = out.slice(0, idx) + replace + out.slice(idx + search.length)
  }
  return { content: out }
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
  }
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
    /\b(?:in the next (?:response|message|turn)|next response|say (?:the word )?["']?continue["']?|shall I (?:continue|proceed)|to (?:continue|proceed)[,.]? (?:just )?(?:let me know|say)|let me know.{0,40}(?:continue|proceed|go ahead))/i
  const deferred = JA_DEFERRAL.test(scanText) || EN_DEFERRAL.test(scanText)
  const creationIntent = /(作成|作って|作る|生成|実装|create|write|generate|make|build)/i.test(userText)

  if (commands.length === 0 && malformedBlocks.length === 0 && inventedCmds.length === 0
    && !echoingResults && !deferred && !(creationIntent && hasFence)) {
    return { display: response, feedback: [], needsContinuation: false }
  }
  if (!window.electronAPI) {
    return { display: response + '\n\n(Error: Electron API not available)', feedback: [], needsContinuation: false }
  }

  const notes: (string | null)[] = new Array(commands.length).fill(null)
  const feedback: string[] = []
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

  if (malformedBlocks.length > 0) {
    feedback.push(
      `Malformed command block(s): ${[...new Set(malformedBlocks)].join(', ')}. ` +
      'A WRITE_FILE block must end with "// END_WRITE_FILE" and an EDIT_FILE block with "// END_EDIT_FILE". ' +
      'Emit the complete block again with the correct terminator - do not omit any part of the file.' +
      (malformedDetails.length ? `\n${malformedDetails.join('\n')}` : '')
    )
    needsContinuation = true
  }
  if (inventedCmds.length > 0) {
    feedback.push(
      `Unknown command(s): ${inventedCmds.map(c => `// ${c}`).join(', ')}. ` +
      'Valid commands are "// WRITE_FILE:", "// EDIT_FILE:", "// READ_FILE:", "// LIST_FILES:", "// GREP:", "// FIND_FILES:", "// RUN_COMMAND:", "// CLOSE_PROJECT" ' +
      '(WRITE_FILE/EDIT_FILE blocks close with "// END_WRITE_FILE" / "// END_EDIT_FILE"). ' +
      'To create a file, emit "// WRITE_FILE: <file_path>", the content, then "// END_WRITE_FILE".'
    )
    needsContinuation = true
  }
  if (echoingResults) {
    feedback.push(
      'The "Command execution results:" block is generated by the app, not by you - do not repeat it. ' +
      'Respond as the assistant: emit the corrected file command or answer the user.'
    )
    needsContinuation = true
  }
  if (deferred) {
    feedback.push(
      'You ended your turn asking the user to say "continue" (or similar) before emitting the rest of the work. ' +
      'Do not wait for the user - continue NOW in this response and emit the remaining file commands or output you listed.'
    )
    needsContinuation = true
  }
  if (commands.length === 0 && creationIntent && hasFence) {
    feedback.push(
      'You showed code inside a markdown code fence - fenced lines are shown to the user as text and never executed, so nothing was written to disk. ' +
      'Emit the command OUTSIDE any code fence: "// WRITE_FILE: <file_path>", the content, then "// END_WRITE_FILE".'
    )
    needsContinuation = true
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
        feedback.push(`WRITE_FILE ${cmd.arg}: rejected - ${resolved.error}`)
        needsContinuation = true
      } else {
        const rel = pathRelativeToRoot(resolved.path)
        const strayDir = findUnrequestedSubdir(userText, rel)
        if (strayDir) {
          const base = rel.split('/').pop() ?? cmd.arg
          notes[i] = `⚠️ ${i18nService.t('Rejected write to')} ${cmd.arg}: ${i18nService.t('subdirectory was not requested')}`
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
        feedback.push(`EDIT_FILE ${cmd.arg}: rejected - ${resolved.error}`)
        needsContinuation = true
      } else {
        pendingEdits.push({ index: i, path: resolved.path, arg: cmd.arg, body: cmd.body ?? '' })
      }
    } else if (cmd.type === 'run') {
      const project = projectService.getCurrentProject()
      if (!project?.isOpen) {
        notes[i] = `⚠️ ${i18nService.t('No project is open; cannot run commands.')}`
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
        feedback.push('CLOSE_PROJECT: the project is now closed. Any further file commands will fail - finish your answer.')
      }
    } else if (cmd.type === 'grep' || cmd.type === 'find') {
      // Content/path search across the whole project - no path resolution needed
      needsContinuation = true
      const project = projectService.getCurrentProject()
      if (!project?.isOpen) {
        notes[i] = `⚠️ ${i18nService.t('No project is open; cannot search.')}`
        feedback.push(`${cmd.type === 'grep' ? 'GREP' : 'FIND_FILES'} ${cmd.arg}: failed - no project open`)
        continue
      }
      try {
        if (cmd.type === 'grep') {
          const result = await window.electronAPI.searchFiles(project.rootPath, cmd.arg)
          if (result.success && result.matches) {
            notes[i] = `🔍 ${i18nService.t('Searched')} "${cmd.arg}": ${result.matches.length} ${i18nService.t('match(es)')}`
            const body = result.matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n')
            feedback.push(`GREP ${cmd.arg} result (${result.matches.length} matches${result.truncated ? ', truncated' : ''}):\n${body || '(no matches)'}`)
          } else {
            notes[i] = `⚠️ ${i18nService.t('Search failed for')} "${cmd.arg}": ${result.error}`
            feedback.push(`GREP ${cmd.arg}: failed - ${result.error}`)
          }
        } else {
          const result = await window.electronAPI.findFiles(project.rootPath, cmd.arg)
          if (result.success && result.files) {
            notes[i] = `🔍 ${i18nService.t('Found')} ${result.files.length} ${i18nService.t('file(s) matching')} "${cmd.arg}"`
            feedback.push(`FIND_FILES ${cmd.arg} result (${result.files.length} files${result.truncated ? ', truncated' : ''}):\n${result.files.join('\n') || '(no matches)'}`)
          } else {
            notes[i] = `⚠️ ${i18nService.t('Find failed for')} "${cmd.arg}": ${result.error}`
            feedback.push(`FIND_FILES ${cmd.arg}: failed - ${result.error}`)
          }
        }
      } catch (error) {
        notes[i] = `⚠️ ${i18nService.t('Search error')}: ${error}`
        feedback.push(`${cmd.type.toUpperCase()} ${cmd.arg}: failed - ${error}`)
      }
    } else if (cmd.type === 'read') {
      needsContinuation = true
      // Never fall back to cmd.arg on resolution failure - that would
      // read relative to the app's cwd (or anywhere via ../) instead
      // of rejecting the read.
      if (resolved.error || !resolved.path) {
        notes[i] = `⚠️ ${i18nService.t('Error reading file')} ${cmd.arg}: ${resolved.error}`
        feedback.push(`READ_FILE ${cmd.arg}: failed - ${resolved.error}`)
        continue
      }
      const filePath = resolved.path
      try {
        const result = await window.electronAPI.readFile(filePath)
        if (result.success) {
          console.log(`File read: ${filePath}`)
          notes[i] = `📖 ${i18nService.t('Read file')}: ${pathRelativeToRoot(filePath)}`
          feedback.push(`READ_FILE ${pathRelativeToRoot(filePath)} result:\n${result.content}`)
        } else {
          console.error(`Failed to read file: ${filePath}`, result.error)
          notes[i] = `⚠️ ${i18nService.t('Error reading file')} ${pathRelativeToRoot(filePath)}: ${result.error}`
          feedback.push(`READ_FILE ${pathRelativeToRoot(filePath)}: failed - ${result.error}`)
        }
      } catch (error) {
        console.error(`Error reading file: ${filePath}`, error)
        notes[i] = `⚠️ ${i18nService.t('Error reading file')} ${pathRelativeToRoot(filePath)}: ${error}`
        feedback.push(`READ_FILE ${pathRelativeToRoot(filePath)}: failed - ${error}`)
      }
    } else {
      needsContinuation = true
      if (resolved.error || !resolved.path) {
        notes[i] = `⚠️ ${i18nService.t('Error listing files')} ${cmd.arg}: ${resolved.error}`
        feedback.push(`LIST_FILES ${cmd.arg}: failed - ${resolved.error}`)
        continue
      }
      const directoryPath = resolved.path
      try {
        const result = await window.electronAPI.readDirectory(directoryPath)
        if (result.success && result.items) {
          console.log(`Files listed: ${directoryPath}`)
          notes[i] = `📁 ${i18nService.t('Listed files in')}: ${pathRelativeToRoot(directoryPath)}`
          const fileList = result.items.map((item: any) =>
            `${item.isDirectory ? 'DIR' : 'FILE'}: ${item.name}`
          ).join('\n')
          feedback.push(`LIST_FILES ${pathRelativeToRoot(directoryPath)} result:\n${fileList}`)
        } else {
          console.error(`Failed to list files: ${directoryPath}`, result.error)
          notes[i] = `⚠️ ${i18nService.t('Error listing files')} ${pathRelativeToRoot(directoryPath)}: ${result.error}`
          feedback.push(`LIST_FILES ${pathRelativeToRoot(directoryPath)}: failed - ${result.error}`)
        }
      } catch (error) {
        console.error(`Error listing files: ${directoryPath}`, error)
        notes[i] = `⚠️ ${i18nService.t('Error listing files')} ${pathRelativeToRoot(directoryPath)}: ${error}`
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
          feedback.push(
            `WRITE_FILE ${item.arg}: rejected - the content contains SEARCH/REPLACE diff markers ` +
            `(<<<<<<< / ======= / >>>>>>>). WRITE_FILE takes the raw file content only; ` +
            `re-emit it with just the file content, no diff syntax.`
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
          feedback.push(`${label} ${item.arg}: failed - file not found or unreadable. If you intended to create it, use // WRITE_FILE: with the full content instead.`)
          needsContinuation = true
          continue
        }
        const applied = applyEditBlocks(oldContent, parseEditBlocks(item.body))
        if (applied.error) {
          batchEditFailed = true
          if (state) state.editFailCount++
          notes[item.index] = `⚠️ ${i18nService.t('Edit failed for')} ${item.arg}: ${applied.error}`
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
        if (state) state.editFailCount = 0
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
        feedback.push(`${label} ${pathRelativeToRoot(item.path)}: success`)
        batchEditSucceeded = true
        if (state) state.editsApplied = (state.editsApplied ?? 0) + 1

        // Emit event to refresh explorer (and editor if the file is open)
        window.dispatchEvent(new CustomEvent('file-created', {
          detail: { filePath: item.path }
        }))
      } catch (error) {
        console.error(`Error writing file: ${item.path}`, error)
        notes[item.index] = `⚠️ ${i18nService.t('Error writing file')} ${pathRelativeToRoot(item.path)}: ${error}`
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
        feedback.push(`RUN_COMMAND ${r.command}: rejected by user`)
        needsContinuation = true
        continue
      }
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
              const isTestCmd = /pytest|unittest|npm test|yarn test|pnpm test|cargo test|go test|jest|vitest|mocha/i.test(r.command)
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
          feedback.push(
            `RUN_COMMAND ${r.command} result - ${statusText}:\n${tail || '(no output)'}${hint}`
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
  if (commands.length === 0 && creationIntent && hasFence) {
    display += `\n\n⚠️ ${i18nService.t('Code shown but not written - asking the model to retry')}`
  }
  if (deferred) {
    display += `\n\n⚠️ ${i18nService.t('Deferred to a later response - asking the model to continue now')}`
  }

  return { display: display.trim(), feedback, needsContinuation, checkpoint }
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

  // Persist conversation whenever it changes
  useEffect(() => {
    messagesRef.current = messages
    if (messages.length === 0) return
    void persistConversation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

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
      const summary = await llmService.sendMessage(prompt, undefined, [], () => {}, signal, llmPin)
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

      if (configService.getLlmProvider() === 'ollama') {
        setCurrentModel(`ollama:${configService.getOllamaModel()}`)
        return
      }
      const managedModel = configService.getManagedCredentials()?.model
      if (managedModel) {
        setCurrentModel(managedModel)
        return
      }
      const savedModel = configService.getGeminiModel()
      if (savedModel === 'custom') {
        setCurrentModel(configService.getGeminiCustomModel() || 'Custom')
      } else {
        setCurrentModel(savedModel || 'gemini-3.8-flash')
      }
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

  const sendToAI = async (userMessage: Message, historyBase: Message[]) => {
    setIsLoading(true)

    // Pin provider+model for this whole run: changing Settings while a
    // response is generating must not retarget later agent-loop steps or
    // relabel the in-flight reply.
    const runProvider = configService.getLlmProvider()
    const runModelName = runProvider === 'ollama'
      ? configService.getOllamaModel()
      : configService.getGeminiModel() === 'custom'
        ? configService.getGeminiCustomModel()
        : configService.getGeminiModel()
    const runLabel = currentModel
    const llmPin = { provider: runProvider, model: runModelName || undefined }
    setActiveModel(runLabel)

    // Create abort controller for this request
    const controller = new AbortController()
    setAbortController(controller)

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

      // When the window drops earlier turns, say so - otherwise the model
      // treats the first visible message as the conversation start and
      // confidently answers questions about history it cannot see.
      if (historyBase.length > HISTORY_WINDOW) {
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
        historyBase.slice(-HISTORY_WINDOW).map((m) => ({
          ...m,
          content: m.rawContent ?? (m.role === 'assistant' ? stripNoteLines(m.content) : m.content),
        }))
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
      }
      // One-shot guard: nudge the model at most once when it declares
      // completion while a failure is still unresolved.
      let failureNudged = false
      // The create-project prompt is offered at most once per user turn
      projectPromptShownRef.current = false

      // Streaming (Ollama path): deltas accumulate into a live bubble
      // rendered below the message list. On completion the parsed display
      // becomes a normal committed message.
      const makeStreamHandler = () => {
        streamedRef.current = ''
        const onDelta = (delta: string) => {
          streamedRef.current += delta
          setStreamingText(streamedRef.current)
        }
        return { onDelta, getStreamed: () => streamedRef.current }
      }

      for (let step = 0; step < MAX_STEPS; step++) {
        if (controller.signal.aborted) break

        const { onDelta, getStreamed } = makeStreamHandler()
        const callStart = performance.now()
        const response = await llmService.sendMessage(currentInput, context, historyForRequest, onDelta, controller.signal, llmPin)
        const latencyMs = Math.round(performance.now() - callStart)
        // The original user turn went out as this request's prompt; add
        // it to the running history now so later agent-loop steps see it.
        if (step === 0) historyForRequest.push(userMessage)
        const { display, feedback, needsContinuation, checkpoint } = await parseAndExecuteFileCommands(response, requestApproval, requestCommandApproval, runCommandAndWait, userMessage.content, requestProject, agentState)
        if (controller.signal.aborted) break
        setStreamingText(null)
        if (checkpoint && checkpoint.length > 0) {
          checkpointsRef.current.push(checkpoint)
          setCanRollback(true)
        }
        lastStepRanCommands = feedback.length > 0

        const finalText = display || getStreamed()
        if (finalText) {
          const assistantMessage: Message = {
            role: 'assistant',
            content: finalText,
            timestamp: Date.now(),
            latencyMs,
            model: runLabel || undefined,
            rawContent: response,
          }
          setMessages((prev) => [...prev, assistantMessage])
        }

        historyForRequest.push({ role: 'assistant', content: response, timestamp: Date.now() })

        // No command results the AI needs -> the AI is done. Except: if it
        // declared completion while an earlier command/edit failure is still
        // unresolved, give it one chance to fix or explicitly justify it.
        if (!needsContinuation) {
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
          if (failureNudged && agentState.unresolvedEdit) {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `⚠️ ${i18nService.t('A file edit failed and was never retried - the reported changes may not exist on disk. Please verify the file.')}`,
              timestamp: Date.now(),
            }])
          }
          break
        }

        // Small models burn steps re-verifying finished work - tell them
        // the remaining step budget and how to close out the task.
        currentInput =
          `Command execution results:\n${feedback.join('\n\n')}\n\n` +
          // Models often abandon a failed edit and keep reading files or
          // running tests instead of retrying it. While any write/edit is
          // still outstanding, remind every step so the failure cannot be
          // silently dropped.
          (agentState.unresolvedEdit
            ? `Reminder: an earlier EDIT_FILE/WRITE_FILE failed and no file change has succeeded since - the target file is still UNCHANGED on disk. Re-emit the change now (EDIT_FILE with an exact SEARCH block, or WRITE_FILE with the full file content) before continuing.\n\n`
            : '') +
          `(Step ${step + 1} of ${MAX_STEPS}) ` +
          `Continue with the user's request. If the work is already done, ` +
          `reply with the final answer only - no file commands.`
      }

      // If the last step executed commands (e.g. writes), the visible reply is
      // only command notes like "Wrote file: ..." - ask the model for a
      // closing answer addressed to the user.
      if (lastStepRanCommands && !controller.signal.aborted) {
        const summaryInput =
          `The file operations completed. Reply to the user with a brief summary ` +
          `of what you did, in the same language as the user's request. ` +
          `Do not emit any file commands.`
        historyForRequest.push({ role: 'user', content: summaryInput, timestamp: Date.now() })
        const { onDelta: onSummaryDelta, getStreamed: getSummaryStreamed } = makeStreamHandler()
        const summaryStart = performance.now()
        const summary = await llmService.sendMessage(summaryInput, context, historyForRequest, onSummaryDelta, controller.signal, llmPin)
        const summaryLatencyMs = Math.round(performance.now() - summaryStart)
        const { display: summaryDisplay } = await parseAndExecuteFileCommands(summary, requestApproval, requestCommandApproval, runCommandAndWait, userMessage.content, requestProject)
        if (controller.signal.aborted) return
        setStreamingText(null)
        const summaryText = summaryDisplay || getSummaryStreamed()
        if (summaryText) {
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: summaryText,
            timestamp: Date.now(),
            latencyMs: summaryLatencyMs,
            model: runLabel || undefined,
            rawContent: summary,
          }])
        }
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
        {messages.map((message, index) => (
          <div
            key={index}
            className={`chat-message ${message.role}`}
          >
            <div className="message-content">
              <div className="message-role">
                {t(message.role)}
                {message.role === 'assistant' && message.model && ` (${message.model})`}
                {message.role === 'assistant' && index === messages.length - 1 && !isLoading && (
                  <button
                    className="retry-button"
                    onClick={handleRetry}
                    title={t('Regenerate response')}
                  >
                    ↻
                  </button>
                )}
              </div>
              <div className="message-text">
                {message.role === 'assistant'
                  ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
                  : message.content}
              </div>
              {message.latencyMs != null && (
                <div className="message-latency">({formatLatency(message.latencyMs)})</div>
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
                <span className="loading-dots">{t('Generating response')}</span>
                <button 
                  className="cancel-button" 
                  onClick={handleCancel}
                  title={t('Cancel request')}
                >
                  ✕
                </button>
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
          onClick={handleSend}
          disabled={isLoading || !input.trim() || !isConfigured}
          className="send-button"
        >
          {isConfigured ? t('Send') : t('Configure API Key')}
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
        />
      )}
      {pendingCommands && pendingCommands.length > 0 && (
        <CommandApproval
          commands={pendingCommands}
          onApprove={resolveCommandApproval}
          onReject={() => resolveCommandApproval(null)}
          onRejectOne={handleRejectOneCommand}
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
