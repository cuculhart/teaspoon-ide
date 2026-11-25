import React from 'react'
import { useT } from '../services/i18nService'
import './FileEditApproval.css'
import './ProcessApproval.css'

// A "process approval" prompt (v1.3.0, backlog L5): unlike the file-edit
// and command dialogs, which gate a concrete diff or shell command, this
// one gates HOW the work proceeds - a plan phase transition, or what to
// do after the same change keeps failing. The user answers an
// intent-level question, not a code review.
export interface ProcessPrompt {
  title: string
  body: string
  options: { id: string; label: string; hint?: string }[]
  // The model's prose from the turn that produced this prompt.
  note?: string | null
}

interface ProcessApprovalProps {
  prompt: ProcessPrompt
  onChoose: (optionId: string) => void
  // Abort the whole agent run - the chat's Stop button is unreachable
  // under this modal's fullscreen overlay.
  onCancel?: () => void
}

const ProcessApproval: React.FC<ProcessApprovalProps> = ({ prompt, onChoose, onCancel }) => {
  const t = useT()
  return (
    <div className="process-approval">
      <div className="approval-content">
        <div className="approval-header">
          <h3>{prompt.title}</h3>
        </div>

        {prompt.note && (
          <div className="approval-model-note">
            <div className="note-label">{t("The model's explanation for this turn")}</div>
            <div className="note-text">{prompt.note}</div>
          </div>
        )}

        <div className="process-body">
          <p className="process-question">{prompt.body}</p>
        </div>

        <div className="approval-actions">
          {onCancel && (
            <button className="stop-run-button" onClick={onCancel} title={t('Cancel request')}>
              ■ {t('Stop')}
            </button>
          )}
          {prompt.options.map((o, i) => (
            <button
              key={o.id}
              className={i === 0 ? 'approve-button' : 'reject-all-button'}
              onClick={() => onChoose(o.id)}
              title={o.hint}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default ProcessApproval
