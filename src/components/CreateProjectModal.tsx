import React, { useEffect, useState } from 'react'
import { projectService } from '../services/projectService'
import { configService } from '../services/configService'
import { useT } from '../services/i18nService'
import './CreateProjectModal.css'

// Shown when the AI wants to create files but no project is open.
// The user picks a name + parent folder (default: Documents); the new
// folder becomes the open project and the pending file commands then
// resolve against it.
const CreateProjectModal: React.FC<{
  onCreated: (rootPath: string) => void
  onCancel: () => void
}> = ({ onCreated, onCancel }) => {
  const t = useT()
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.electronAPI?.getDocumentsPath?.()
      .then((r) => { if (r.success && r.path) setParent(r.path) })
      .catch(() => {})
  }, [])

  const handleBrowse = async () => {
    const result = await window.electronAPI?.selectFolder()
    if (result?.success && result.folderPath && !result.canceled) {
      setParent(result.folderPath)
      setError('')
    }
  }

  const handleCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed || !parent || !window.electronAPI || busy) return
    if (/[\\/:*?"<>|]/.test(trimmed)) {
      setError(t('Project name contains invalid characters') + ': \\ / : * ? " < > |')
      return
    }
    const projectPath = `${parent.replace(/[\\/]+$/, '')}/${trimmed}`
    setBusy(true)
    setError('')
    const result = await window.electronAPI.createDirectory(projectPath)
    if (!result.success) {
      setError(result.error || t('Failed to create project folder'))
      setBusy(false)
      return
    }
    try {
      const project = await projectService.openProject(projectPath)
      configService.addRecentProject(project.name, project.rootPath)
      configService.setLastProjectPath(project.rootPath)
      // Notify the sidebar panels directly instead of going through
      // App.onProjectChange - remounting Chat here would orphan the
      // in-flight agent loop waiting on this modal's answer.
      window.dispatchEvent(new CustomEvent('teaspoon:project-opened', {
        detail: { rootPath: project.rootPath },
      }))
      onCreated(project.rootPath)
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  return (
    <div className="create-project-modal">
      <div className="create-project-modal-content">
        <h4>{t('Create Project Folder')}</h4>
        <p>{t('The AI wants to create files but no project is open. Create a folder to save them in.')}</p>
        <input
          autoFocus
          className="dialog-input"
          placeholder={t('Project name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate()
            if (e.key === 'Escape') onCancel()
          }}
          disabled={busy}
        />
        <button className="parent-folder-button" onClick={handleBrowse} disabled={busy}>
          {parent ? `📁 ${parent}` : `📁 ${t('Choose parent folder...')}`}
        </button>
        {error && <p className="open-error">{error}</p>}
        <div className="dialog-actions">
          <button onClick={handleCreate} disabled={!name.trim() || !parent || busy}>
            {busy ? t('Creating...') : t('Create & Open')}
          </button>
          <button onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
        </div>
      </div>
    </div>
  )
}

export default CreateProjectModal
