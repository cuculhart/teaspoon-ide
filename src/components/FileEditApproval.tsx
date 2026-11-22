import React, { useState, useEffect } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { themeService, ResolvedTheme } from '../services/themeService'
import { MONACO_THEME } from '../monacoSetup'
import { configService } from '../services/configService'
import { getLanguage } from '../utils/language'
import { useT } from '../services/i18nService'
import './FileEditApproval.css'

export interface FileEdit {
  filePath: string
  oldContent: string
  newContent: string
}

interface FileEditApprovalProps {
  edits: FileEdit[]
  onApprove: (edits: FileEdit[]) => void
  onReject: () => void
  onRejectOne: (edit: FileEdit) => void
  // Abort the whole agent run (reject + cancel) - the chat's Stop button
  // is unreachable under this modal's fullscreen overlay.
  onCancel?: () => void
}

const FileEditApproval: React.FC<FileEditApprovalProps> = ({ edits, onApprove, onReject, onRejectOne, onCancel }) => {
  const t = useT()
  const [expandedEdits, setExpandedEdits] = useState<Set<number>>(new Set([0]))
  const [monacoTheme, setMonacoTheme] = useState<ResolvedTheme>(themeService.getResolvedTheme())

  useEffect(() => {
    const handleThemeChanged = (event: Event) => {
      setMonacoTheme((event as CustomEvent<ResolvedTheme>).detail)
    }
    window.addEventListener('theme-changed', handleThemeChanged)
    return () => window.removeEventListener('theme-changed', handleThemeChanged)
  }, [])

  const toggleExpand = (index: number) => {
    const newExpanded = new Set(expandedEdits)
    if (newExpanded.has(index)) {
      newExpanded.delete(index)
    } else {
      newExpanded.add(index)
    }
    setExpandedEdits(newExpanded)
  }

  const diffHeight = (edit: FileEdit): number => {
    const lines = Math.max(
      edit.oldContent.split('\n').length,
      edit.newContent.split('\n').length
    )
    return Math.min(Math.max(lines * 19 + 20, 120), 480)
  }

  // Mirrors looksLikeFragment in Chat.tsx: a write/edit that shrinks a
  // non-trivial file to under half its size is usually a truncated
  // fragment. The agent loop blocks the first emission; reaching the
  // dialog means the model re-sent it intentionally - warn the user
  // before they approve the data loss.
  const shrinksFile = (edit: FileEdit): boolean => {
    if (edit.oldContent.trim() === '') return false
    if (edit.newContent.trim() === '') return true
    const oldLines = edit.oldContent.split('\n').length
    return oldLines >= 20 && edit.newContent.split('\n').length * 2 < oldLines
  }

  return (
    <div className="file-edit-approval">
      <div className="approval-content">
        <div className="approval-header">
          <h3>{t('File Edit Approval')}</h3>
          <p className="edit-count">{edits.length} {t('file(s) to edit')}</p>
        </div>

        <div className="edits-list">
          {edits.map((edit, index) => (
            <div key={edit.filePath} className="edit-item">
              <div className="edit-header">
                <span className="file-path">{edit.filePath}</span>
                {shrinksFile(edit) && (
                  <span className="shrink-badge">{t('This edit drastically shrinks the file')}</span>
                )}
                <div className="edit-actions">
                  <button
                    className="expand-button"
                    onClick={() => toggleExpand(index)}
                    title={expandedEdits.has(index) ? t('Collapse') : t('Expand')}
                  >
                    {expandedEdits.has(index) ? '▼' : '▶'}
                  </button>
                  <button
                    className="reject-one-button"
                    onClick={() => onRejectOne(edit)}
                    title={t('Reject this edit')}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {expandedEdits.has(index) && (
                <div className="edit-diff">
                  <DiffEditor
                    height={diffHeight(edit)}
                    language={getLanguage(edit.filePath)}
                    original={edit.oldContent}
                    modified={edit.newContent}
                    theme={MONACO_THEME[monacoTheme] ?? 'vs'}
                    options={{
                      renderSideBySide: false,
                      readOnly: true,
                      originalEditable: false,
                      minimap: { enabled: false },
                      fontSize: configService.getUIFontSize() || 13,
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      lineNumbers: 'on',
                      folding: false,
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="approval-actions">
          {onCancel && (
            <button className="stop-run-button" onClick={onCancel} title={t('Cancel request')}>
              ■ {t('Stop')}
            </button>
          )}
          <button className="reject-all-button" onClick={onReject}>
            {t('Reject All')}
          </button>
          <button className="approve-button" onClick={() => onApprove(edits)}>
            {t('Apply')} {edits.length} {t('Edit(s)')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default FileEditApproval
