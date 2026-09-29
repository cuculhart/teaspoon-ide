import React, { useState, useEffect, useRef } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { themeService, ResolvedTheme } from '../services/themeService'
import { configService } from '../services/configService'
import { getLanguage } from '../utils/language'
import { renderMarkdown, MARKDOWN_CSS } from '../utils/markdown'
import { useT } from '../services/i18nService'
import './Editor.css'

interface EditorProps {
  file: string | null
  content: string
  onChange: (content: string) => void
  diff?: { filePath: string; original: string; modified: string } | null
  onCloseDiff?: () => void
  // When set, reveal this line (n makes repeated jumps to the same line re-fire)
  gotoLine?: { line: number; n: number } | null
  onExportPdf?: () => void
  onExportHtml?: () => void
}

const CodeEditor: React.FC<EditorProps> = ({ file, content, onChange, diff, onCloseDiff, gotoLine, onExportPdf, onExportHtml }) => {
  const t = useT()
  const [monacoTheme, setMonacoTheme] = useState<ResolvedTheme>(themeService.getResolvedTheme())
  const [fontSize, setFontSize] = useState<number>(configService.getUIFontSize() || 14)
  const [fontFamily, setFontFamily] = useState<string | undefined>(configService.getUIFontFamily())
  const editorRef = useRef<any>(null)
  const pendingGotoRef = useRef<number | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const isMarkdown = file?.toLowerCase().endsWith('.md') ?? false

  // Reset preview mode when switching files
  useEffect(() => {
    setShowPreview(false)
  }, [file])

  const gotoLineNow = (line: number) => {
    const ed = editorRef.current
    if (!ed) return
    ed.revealLineInCenter(line)
    ed.setPosition({ lineNumber: line, column: 1 })
    ed.focus()
  }

  useEffect(() => {
    if (!gotoLine) return
    pendingGotoRef.current = gotoLine.line
    gotoLineNow(gotoLine.line)
  }, [gotoLine])

  // Route Edit-menu undo/redo to Monaco's model. The menu accelerator consumed
  // the native Ctrl+Z, so Monaco never sees it. hasTextFocus() is unreliable
  // here because opening the native menu blurs the editor - decide from
  // document.activeElement instead and call model.undo()/redo() directly.
  useEffect(() => {
    const handleMenu = (event: Event) => {
      const action = (event as CustomEvent).detail
      if (action !== 'undo' && action !== 'redo') return

      const editor = editorRef.current
      const model = editor?.getModel?.() ?? null
      const active = document.activeElement as HTMLElement | null
      const inEditor = !!(editor && active && editor.getDomNode()?.contains(active))
      const editableOutside = !inEditor && !!active && (
        active.tagName === 'TEXTAREA' ||
        (active.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color|file)$/i.test((active as HTMLInputElement).type)) ||
        active.isContentEditable
      )

      if (model && !editableOutside) {
        if (action === 'undo') model.undo()
        else model.redo()
      } else if (action === 'undo') {
        window.electronAPI?.editUndo()
      } else {
        window.electronAPI?.editRedo()
      }
    }
    window.addEventListener('app-menu', handleMenu)
    return () => window.removeEventListener('app-menu', handleMenu)
  }, [])

  useEffect(() => {
    const relayout = () => editorRef.current?.layout()
    window.addEventListener('teaspoon:layout-changed', relayout)
    return () => window.removeEventListener('teaspoon:layout-changed', relayout)
  }, [])

  useEffect(() => {
    const handleThemeChanged = (event: Event) => {
      setMonacoTheme((event as CustomEvent<ResolvedTheme>).detail)
    }
    const handleFontChanged = () => {
      setFontSize(configService.getUIFontSize() || 14)
      setFontFamily(configService.getUIFontFamily())
    }
    window.addEventListener('theme-changed', handleThemeChanged)
    window.addEventListener('font-changed', handleFontChanged)
    return () => {
      window.removeEventListener('theme-changed', handleThemeChanged)
      window.removeEventListener('font-changed', handleFontChanged)
    }
  }, [])

  const monacoThemeName = monacoTheme === 'dark' ? 'vs-dark' : monacoTheme === 'quiet' ? 'teaspoon-quiet' : 'vs'
  const editorOptions = {
    minimap: { enabled: true },
    fontSize,
    fontFamily,
    lineNumbers: 'on' as const,
    roundedSelection: false,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
  }

  if (diff) {
    return (
      <div className="editor-container">
        <div className="editor-wrapper">
          <div className="editor-header">
            <span className="file-name">{diff.filePath}</span>
            <span className="diff-badge">diff</span>
            <button className="diff-close" onClick={onCloseDiff} title={t('Close diff')}>✕</button>
          </div>
          <DiffEditor
            height="100%"
            language={getLanguage(diff.filePath)}
            original={diff.original}
            modified={diff.modified}
            onMount={(editor) => { editorRef.current = editor }}
            theme={monacoThemeName}
            options={{ ...editorOptions, renderSideBySide: true, readOnly: true }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="editor-container">
      {file ? (
        <div className="editor-wrapper">
          <div className="editor-header">
            <span className="file-name">{file}</span>
            {isMarkdown && (
              <>
                <button
                  className="preview-toggle"
                  onClick={() => setShowPreview(p => !p)}
                  title={showPreview ? t('Back to editor') : t('Preview Markdown')}
                >
                  {showPreview ? t('Edit') : t('Preview')}
                </button>
                {onExportHtml && (
                  <button
                    className="preview-toggle"
                    onClick={onExportHtml}
                    title={t('Export Markdown to HTML')}
                  >
                    {t('Export HTML')}
                  </button>
                )}
                {onExportPdf && (
                  <button
                    className="preview-toggle"
                    onClick={onExportPdf}
                    title={t('Export Markdown to PDF')}
                  >
                    {t('Export PDF')}
                  </button>
                )}
              </>
            )}
          </div>
          {showPreview && isMarkdown ? (
            <div className="md-preview">
              <style>{MARKDOWN_CSS}</style>
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
              />
            </div>
          ) : (
          <Editor
            height="100%"
            path={file}
            keepCurrentModel
            defaultLanguage={getLanguage(file)}
            language={getLanguage(file)}
            value={content}
            onChange={(value) => onChange(value || '')}
            onMount={(editor, monaco) => {
              editorRef.current = editor
              // Monaco's bundled TS worker only sees currently-open models and
              // cannot resolve modules on disk, so cross-file checks produce
              // false "cannot find module" squiggles. Keep syntax validation
              // (unterminated strings etc.) but disable semantic checks.
              const tsLang = (monaco as any).languages?.typescript
              if (tsLang) {
                tsLang.typescriptDefaults.setDiagnosticsOptions({
                  noSemanticValidation: true, // no module-resolution/type squiggles
                  noSyntaxValidation: false,  // keep real syntax errors
                })
                tsLang.javascriptDefaults.setDiagnosticsOptions({
                  noSemanticValidation: true,
                  noSyntaxValidation: false,
                })
              }
              // A line jump may have arrived before the editor mounted
              if (pendingGotoRef.current) {
                gotoLineNow(pendingGotoRef.current)
                pendingGotoRef.current = null
              }
            }}
            theme={monacoThemeName}
            options={editorOptions}
          />
          )}
        </div>
      ) : (
        <div className="editor-placeholder">
          <div className="placeholder-content">
            <h2>{t('No file selected')}</h2>
            <p>{t('Select a file from the Explorer to start editing')}</p>
          </div>
        </div>
      )}
    </div>
  )
}

export default CodeEditor
