// Post-write syntax validation for agent file writes (v1.2.0, backlog L4).
// A "successful" WRITE_FILE/EDIT_FILE can still carry a truncated or
// fragmentary body that is broken at the language level - the shrink
// guard only counts lines, so this is the last line of defense before
// broken content stays on disk.
//
// Checker map:
//   .json                -> JSON.parse (renderer-side, synchronous)
//   .js/.jsx/.mjs/.cjs   -> the bundled Monaco TypeScript worker's
//   .ts/.tsx               syntactic diagnostics (same parser the editor
//                           squiggles use; handles JSX/TSX natively)
//   everything else      -> skipped. A file type we cannot check must
//                           never block a write, and an unavailable
//                           checker fails open for the same reason.
import * as monaco from 'monaco-editor'

const MONACO_LANG_BY_EXT: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
}

let scratchSeq = 0

const extOf = (filePath: string): string => {
  const m = /\.([A-Za-z0-9]+)$/.exec(filePath)
  return m ? `.${m[1].toLowerCase()}` : ''
}

export type SyntaxCheckResult = { ok: true } | { ok: false; error: string }

// Validate content that was just written. `error` is a short
// "line N: message" description suitable for model feedback.
export async function validateFileSyntax(filePath: string, content: string): Promise<SyntaxCheckResult> {
  const ext = extOf(filePath)
  if (ext === '.json') {
    try {
      JSON.parse(content)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `JSON: ${e instanceof Error ? e.message : e}` }
    }
  }

  const lang = MONACO_LANG_BY_EXT[ext]
  if (!lang) return { ok: true }

  // monaco-editor >=0.52 exposes the TS language service as a top-level
  // `typescript` export; older versions hang it off `monaco.languages`.
  const tsLang = (monaco as any).typescript ?? (monaco as any).languages?.typescript
  const getWorker = lang === 'javascript' && tsLang?.getJavaScriptWorker
    ? tsLang.getJavaScriptWorker
    : tsLang?.getTypeScriptWorker
  if (!getWorker) return { ok: true } // checker missing - do not block

  let model: ReturnType<typeof monaco.editor.createModel> | undefined
  try {
    const uri = monaco.Uri.parse(`file:///syntax-check-${++scratchSeq}${ext}`)
    model = monaco.editor.createModel(content, lang, uri)
    const worker = await getWorker()
    const client = await worker(uri)
    const diags: any[] = await client.getSyntacticDiagnostics(uri.toString())
    // The worker returns raw ts.Diagnostics ({category, start,
    // messageText}), not IMarkerData ({severity, startLineNumber}).
    // DiagnosticCategory.Error === 1; tolerate the marker shape too in
    // case a Monaco version changes the payload.
    const errors = diags.filter(d =>
      d.severity !== undefined ? d.severity === monaco.MarkerSeverity.Error : d.category === 1)
    if (errors.length === 0) return { ok: true }
    const first = errors[0]
    const flatten = (m: any): string =>
      typeof m === 'string' ? m
        : Array.isArray(m?.next) ? [m.messageText, ...m.next.map(flatten)].join(' ')
        : (m?.messageText ?? String(m))
    const line = typeof first.startLineNumber === 'number'
      ? first.startLineNumber
      : model.getPositionAt(first.start ?? 0).lineNumber
    return { ok: false, error: `line ${line}: ${flatten(first.messageText ?? first.message)}` }
  } catch (e) {
    // A failure inside the checker itself must not block writes either.
    console.warn('syntaxValidator: checker failed, skipping', e)
    return { ok: true }
  } finally {
    model?.dispose()
  }
}
