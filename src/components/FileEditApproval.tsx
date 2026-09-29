import React, { useState, useEffect } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { themeService, ResolvedTheme } from '../services/themeService'
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
}

const FileEditApproval: React.FC<FileEditApprovalProps> = ({ edits, onApprove, onReject, onRejectOne }) => {
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
                    theme={monacoTheme === 'dark' ? 'vs-dark' : monacoTheme === 'quiet' ? 'teaspoon-quiet' : 'vs'}
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
