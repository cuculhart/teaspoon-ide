// Plain-text command protocol parser, extracted from Chat.tsx so it can be
// unit-tested in node (see e2e/parser.test.mjs). Keep it dependency-light:
// hostOpenCommand reads window.electronAPI at call time, never at import.
import { hostOpenCommand } from './agentPrompt'

export interface FileCommand {
  type: 'write' | 'read' | 'list' | 'run' | 'grep' | 'find' | 'edit' | 'close'
  arg: string
  body?: string
  start: number
  end: number
}

// Small models sometimes wrap the whole file body in a markdown code fence
// ("```md\n...\n```"), which would be written to disk literally and render
// the file as one giant code block. If the body starts with a fence line,
// everything up to the last bare "```" line is unwrapped - trailing prose
// after it is dropped. Inner fences must pair up, otherwise the fence is
// real content and the body is kept as-is.
function unwrapFenceBody(body: string): { content: string; end: number } | null {
  const open = body.match(/^(?:[ \t]*\r?\n)*[ \t]*```[\w+-]*[ \t]*\r?\n/)
  if (!open) return null
  const closes = [...body.matchAll(/^[ \t]*```[ \t]*\r?$/gm)]
  const lastClose = closes[closes.length - 1]
  if (!lastClose || lastClose.index! <= open[0].length) return null
  const content = body.slice(open[0].length, lastClose.index)
  if (((content.match(/^[ \t]*```[^\n]*$/gm) ?? []).length) % 2 !== 0) return null
  let end = lastClose.index! + lastClose[0].length
  if (body[end] === '\n') end++
  return { content, end }
}

// Drop trailing "(...)" prose small models append to file paths
// ("README.md (assuming you meant...)"). Keeps parens that look like part
// of the name itself ("report (final)" stays - fewer than 3 words and no
// filler phrasing).
function cleanPathArg(arg: string): string {
  return arg
    .replace(/[ \t]+\(([^()]*)\)[ \t]*$/, (m, inner) =>
      inner.trim().split(/\s+/).length >= 3 ||
      /\b(or|assuming|note|e\.g|i\.e|if|you|this|that|instead|since|because)\b/i.test(inner)
        ? '' : m
    )
    // Models also glue the following sentence onto the path with no
    // separator ("...Spec.mdプロジェクト `x` は..." or "...Spec.md は...").
    // Cut at an ASCII ".ext" boundary followed by non-ASCII prose, but
    // only when no path separator remains afterwards so real CJK
    // directory names ("dir.日本語/file.txt") survive.
    .replace(
      /(\.[A-Za-z0-9]{1,10})(?:[^\x00-\x7F/\\]+|[ \t]+[^\x00-\x7F/\\])[^/\\]*$/u,
      '$1'
    )
}

function cleanRunCommandArg(command: string): string {
  const openerMatch = command.match(/^\s*(?:cmd(?:\.exe)?\s+\/c\s+)?(start|xdg-open|open)\s+(.*)$/i)
  if (!openerMatch) return command

  let rest = openerMatch[2].trim()
  rest = rest.replace(/^(?:(?:cmd(?:\.exe)?\s+\/c\s+)?(?:start|xdg-open|open)\s+)+/i, '')
  rest = rest.replace(/^""\s*/, '')
  // Models sometimes hand over a markdown link ("[label](url)", or even
  // "https://[label](url)") - the real target lives inside the parens.
  const mdLink = rest.match(/\((https?:\/\/[^)\s]+)\)/i)
  if (mdLink) rest = mdLink[1]

  const targetMatch = rest.match(/^(?:"[^"\n]+"|'[^'\n]+'|(?:https?|file):\/\/[^\s"'<>\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[^\s"'<>\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+\.[A-Za-z0-9]{1,10})/iu)
  if (!targetMatch) return command

  return `${hostOpenCommand()} ${targetMatch[0]}`
}

// Ranges inside markdown ``` code fences. Command-looking lines in a
// fence are documentation/examples ("teach me the commands") and must
// never execute.
function fencedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  const fenceRe = /^[ \t]*(`{3,})[^\n]*$/gm
  let openStart = -1
  let openTicks = 0
  let m
  while ((m = fenceRe.exec(text)) !== null) {
    if (openStart < 0) {
      openStart = m.index
      openTicks = m[1].length
    } else if (m[1].length >= openTicks && /^[ \t]*`{3,}[ \t]*$/.test(m[0])) {
      ranges.push([openStart, m.index + m[0].length])
      openStart = -1
    }
  }
  // An unclosed fence swallows the rest of the reply.
  if (openStart >= 0) ranges.push([openStart, text.length])
  return ranges
}

// Find file commands embedded in the AI response
export function findFileCommands(response: string): { commands: FileCommand[]; docSpans: [number, number][] } {
  const commands: FileCommand[] = []
  let match

  // Fenced-div style: some models emit the command grammar with markdown
  // ":::" fences (:::WRITE_FILE: path ... :::) instead of // comment markers.
  const colonWriteRegex = /^[ \t]*:::[ \t]*WRITE_FILE[ \t]*:?[ \t]*([^\n]+?)\r?\n([\s\S]*?)^[ \t]*:::[ \t]*$/gm
  while ((match = colonWriteRegex.exec(response)) !== null) {
    const unwrapped = unwrapFenceBody(match[2])
    commands.push({ type: 'write', arg: cleanPathArg(match[1].trim()), body: unwrapped?.content ?? match[2], start: match.index, end: match.index + match[0].length })
  }

  const colonEditRegex = /^[ \t]*:::[ \t]*EDIT_FILE[ \t]*:?[ \t]*([^\n]+?)\r?\n([\s\S]*?)^[ \t]*:::[ \t]*$/gm
  while ((match = colonEditRegex.exec(response)) !== null) {
    commands.push({ type: 'edit', arg: cleanPathArg(match[1].trim()), body: match[2], start: match.index, end: match.index + match[0].length })
  }

  const COLON_LINE_TYPES: Record<string, FileCommand['type']> = {
    READ_FILE: 'read', LIST_FILES: 'list', RUN_COMMAND: 'run', GREP: 'grep', FIND_FILES: 'find',
    CLOSE_PROJECT: 'close',
  }
  const colonLineRegex = /^[ \t]*:::[ \t]*(READ_FILE|LIST_FILES|RUN_COMMAND|GREP|FIND_FILES|CLOSE_PROJECT)[ \t]*:?[ \t]*([^\n]*?)[ \t]*$/gm
  while ((match = colonLineRegex.exec(response)) !== null) {
    const type = COLON_LINE_TYPES[match[1]]
    const raw = match[2].trim()
    commands.push({
      type,
      arg: type === 'run' ? cleanRunCommandArg(raw) : type === 'grep' ? raw : cleanPathArg(raw),
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  // Small models sometimes drop the colon ("// READ_FILE x") or close blocks
  // with another language's comment marker ("# END_WRITE_FILE") - tolerate both.
  const writeFileRegex = /\/\/ WRITE_FILE[ \t]*:?[ \t]*([^\n]+?)\n([\s\S]*?)(?:\/\/|#|--)[ \t]*END_WRITE_FILE/g
  while ((match = writeFileRegex.exec(response)) !== null) {
    const unwrapped = unwrapFenceBody(match[2])
    commands.push({ type: 'write', arg: cleanPathArg(match[1].trim()), body: unwrapped?.content ?? match[2], start: match.index, end: match.index + match[0].length })
  }

  // Salvage: a WRITE_FILE opener whose body is a code fence but that never
  // got "// END_WRITE_FILE" - small models treat the closing ``` as the
  // terminator. Only openers not already inside a parsed command are tried.
  const writeOpenRegex = /(?:(?:\/\/)|:::)[ \t]*WRITE_FILE[ \t]*:?[ \t]*([^\n]+?)\r?\n/g
  while ((match = writeOpenRegex.exec(response)) !== null) {
    const start = match.index
    if (commands.some(c => start >= c.start && start < c.end)) continue
    const unwrapped = unwrapFenceBody(response.slice(start + match[0].length))
    if (!unwrapped) continue
    commands.push({ type: 'write', arg: cleanPathArg(match[1].trim()), body: unwrapped.content, start, end: start + match[0].length + unwrapped.end })
  }

  const editFileRegex = /\/\/ EDIT_FILE[ \t]*:?[ \t]*([^\n]+?)\n([\s\S]*?)(?:\/\/|#|--)[ \t]*END_EDIT_FILE/g
  while ((match = editFileRegex.exec(response)) !== null) {
    commands.push({ type: 'edit', arg: cleanPathArg(match[1].trim()), body: match[2], start: match.index, end: match.index + match[0].length })
  }

  // Salvage: an EDIT_FILE opener never closed with "// END_EDIT_FILE", but
  // the body ends with a complete >>>>>>> REPLACE delimiter - the model
  // forgot the terminator. Take the body up to the last delimiter line.
  const editOpenRegex = /(?:(?:\/\/)|:::)[ \t]*EDIT_FILE[ \t]*:?[ \t]*([^\n]+?)\r?\n/g
  while ((match = editOpenRegex.exec(response)) !== null) {
    const start = match.index
    if (commands.some(c => start >= c.start && start < c.end)) continue
    const rest = response.slice(start + match[0].length)
    const delimiters = [...rest.matchAll(/^>{3,}[^\n]*$/gm)]
    if (delimiters.length === 0) continue
    const last = delimiters[delimiters.length - 1]
    const bodyEnd = last.index! + last[0].length
    commands.push({ type: 'edit', arg: cleanPathArg(match[1].trim()), body: rest.slice(0, bodyEnd), start, end: start + match[0].length + bodyEnd })
  }

  // The AI sometimes puts several commands on one line ("// READ_FILE: a// LIST_FILES: b"),
  // so the argument ends before a following "//" command keyword, before a
  // "//" comment separated by whitespace, or at the end of the line. A bare
  // "//" inside the argument is kept - URLs ("https://...") and UNC paths
  // ("//server/share") would otherwise be truncated mid-argument.
  const lineCommandTypes: Record<string, FileCommand['type']> = {
    READ_FILE: 'read', LIST_FILES: 'list', RUN_COMMAND: 'run',
    GREP: 'grep', FIND_FILES: 'find', CLOSE_PROJECT: 'close',
  }
  const lineCommandRegex = /\/\/[ \t]*(READ_FILE|LIST_FILES|RUN_COMMAND|GREP|FIND_FILES|CLOSE_PROJECT)[ \t]*:?[ \t]*([^\n]*?)(?=[ \t]+\/\/|\/\/[ \t]*(?:READ_FILE|LIST_FILES|RUN_COMMAND|GREP|FIND_FILES|WRITE_FILE|EDIT_FILE|CLOSE_PROJECT|END_\w+)[ \t]*:?|\n|$)/g
  while ((match = lineCommandRegex.exec(response)) !== null) {
    const type = lineCommandTypes[match[1]]
    const raw = match[2].trim()
    commands.push({
      type,
      arg: type === 'run' ? cleanRunCommandArg(raw) : type === 'grep' || type === 'close' ? raw : cleanPathArg(raw),
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  // Weak models sometimes emit JSON command blobs
  // ([{"command": "WRITE_FILE", "path": "x", "content": "..."}]) instead of
  // the // syntax. Objects that JSON.parse cleanly are executed like real
  // commands (field names vary, so several common ones are tried); anything
  // that fails to parse is left as visible text. Fenced blobs stay inert via
  // the docSpans filter below, so JSON examples in documentation never run.
  const jsonCmdRegex = /\{[^{}\n]*"command"[\s\S]*?\}/gi
  while ((match = jsonCmdRegex.exec(response)) !== null) {
    let obj: Record<string, unknown>
    try { obj = JSON.parse(match[0]) } catch { continue }
    const name = String(obj.command ?? obj.type ?? '').trim().toUpperCase()
    const type: FileCommand['type'] | undefined = name === 'WRITE_FILE' ? 'write' : name === 'EDIT_FILE' ? 'edit' : lineCommandTypes[name]
    if (!type || commands.some(c => match!.index >= c.start && match!.index < c.end)) continue
    const arg = String(obj.path ?? obj.file ?? obj.filename ?? obj.cmd ?? obj.pattern ?? obj.target ?? obj.arg ?? '')
    const body = String(obj.content ?? obj.body ?? '')
    commands.push({
      type: type === 'edit' && !body.includes('<<<<<<<') ? 'write' : type,
      arg: type === 'run' ? cleanRunCommandArg(arg) : type === 'grep' || type === 'close' ? arg : cleanPathArg(arg),
      body: type === 'write' || type === 'edit' ? body : undefined,
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  // Salvage: small models sometimes drop the "//" marker entirely and emit a
  // bare "WRITE_FILE: path" / "EDIT_FILE: path" heading line. The body runs to
  // an (optionally marked) END terminator, or to the end of the reply when the
  // model forgot that too. Fenced examples stay inert via the filter below.
  const bareBlockRegex = /^[ \t]*(WRITE_FILE|EDIT_FILE)[ \t]*:[ \t]*([^\n]+?)\r?\n/gm
  while ((match = bareBlockRegex.exec(response)) !== null) {
    const start = match.index
    if (commands.some(c => start >= c.start && start < c.end)) continue
    const rest = response.slice(start + match[0].length)
    const endName = match[1] === 'WRITE_FILE' ? 'END_WRITE_FILE' : 'END_EDIT_FILE'
    const endRe = new RegExp(`(?:\\/\\/|#|--|:::)?[ \\t]*${endName}`)
    const endMatch = endRe.exec(rest)
    const isEdit = match[1] === 'EDIT_FILE'
    commands.push({
      type: isEdit ? 'edit' : 'write',
      arg: cleanPathArg(match[2].trim()),
      body: endMatch ? rest.slice(0, endMatch.index) : rest,
      start,
      end: endMatch ? start + match[0].length + endMatch.index + endMatch[0].length : response.length,
    })
  }

  // Same for single-line commands left bare at the start of a line
  // ("RUN_COMMAND: npm test"). The colon is required so prose like
  // "WRITE_FILE creates files" doesn't match.
  const bareLineRegex = /^[ \t]*(READ_FILE|LIST_FILES|RUN_COMMAND|GREP|FIND_FILES|CLOSE_PROJECT)[ \t]*:[ \t]*([^\n]*)$/gm
  while ((match = bareLineRegex.exec(response)) !== null) {
    const start = match.index
    if (commands.some(c => start >= c.start && start < c.end)) continue
    const type = lineCommandTypes[match[1]]
    const raw = match[2].trim()
    commands.push({
      type,
      arg: type === 'run' ? cleanRunCommandArg(raw) : type === 'grep' || type === 'close' ? raw : cleanPathArg(raw),
      start,
      end: match.index + match[0].length,
    })
  }

  // A command-like line inside a WRITE_FILE/EDIT_FILE body is file content,
  // not a command (e.g. "// RUN_COMMAND:" examples inside a README's code
  // block must not execute). The same applies to commands inside markdown
  // code fences - documented syntax stays visible but never runs.
  // ("<placeholder>" args are NOT skipped here: a weak model copying the
  // "<file_path>" template is a real attempt that must fail loudly or
  // trigger the create-project prompt, not vanish silently.)
  const fences = fencedRanges(response)
  const inFence = (pos: number) => fences.some(([s, e]) => pos >= s && pos < e)
  const blocks = commands.filter(c => c.type === 'write' || c.type === 'edit')
  const executable = commands
    .filter(c => !inFence(c.start) && !blocks.some(b => c !== b && c.start >= b.start && c.start < b.end))
    .sort((a, b) => a.start - b.start)
  // Fence spans are masked from the caller's malformed/invented-command
  // scans so documented syntax can't trigger retry feedback.
  return { commands: executable, docSpans: fences }
}
