import React, { useState, useEffect, useCallback, useRef } from 'react'
import { projectService } from '../services/projectService'
import { useT } from '../services/i18nService'
import './GitPanel.css'

interface GitFileEntry {
  path: string
  index: string
  working_dir: string
}

interface GitPanelProps {
  onOpenDiff: (filePath: string) => void
}

type GitDialogMode = 'clone' | 'remote' | 'config' | null
type GitConfigScope = 'local' | 'global'

interface GitRemoteInfo {
  name: string
  refs?: {
    fetch?: string
    push?: string
  }
}

const STATUS_LABELS: Record<string, string> = {
  'M': 'M',
  'A': 'A',
  'D': 'D',
  '?': 'U',
  'R': 'R',
  'C': 'C',
  'U': '!',
}

const STATUS_TITLES: Record<string, string> = {
  'M': 'Modified',
  'A': 'Added',
  'D': 'Deleted',
  '?': 'Untracked',
  'R': 'Renamed',
  'C': 'Copied',
  'U': 'Conflicted',
}

const GitPanel: React.FC<GitPanelProps> = ({ onOpenDiff }) => {
  const t = useT()
  const [status, setStatus] = useState<any>(null)
  const [hasCommits, setHasCommits] = useState(false)
  const [isRepo, setIsRepo] = useState<boolean | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [configLoading, setConfigLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [dialogMode, setDialogMode] = useState<GitDialogMode>(null)
  const [dialogMessage, setDialogMessage] = useState<string | null>(null)
  const [cloneUrl, setCloneUrl] = useState('')
  const [remotes, setRemotes] = useState<GitRemoteInfo[]>([])
  const [remoteName, setRemoteName] = useState('origin')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteBranch, setRemoteBranch] = useState('')
  const [configScope, setConfigScope] = useState<GitConfigScope>('local')
  const [configName, setConfigName] = useState('')
  const [configEmail, setConfigEmail] = useState('')
  const configNameInputRef = useRef<HTMLInputElement>(null)
  const configEmailInputRef = useRef<HTMLInputElement>(null)
  const configLoadSeq = useRef(0)
  const initialCommitHint = t('Create an initial commit before pushing.')

  const repoPath = projectService.getCurrentProject()?.rootPath

  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

  const callGit = async (action: () => Promise<any>) => {
    try {
      return await action()
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  }

  const withTimeout = <T,>(promise: Promise<T>, timeoutValue: T, ms = 10000) => {
    return Promise.race([
      promise,
      new Promise<T>(resolve => setTimeout(() => resolve(timeoutValue), ms)),
    ])
  }

  const refresh = useCallback(async () => {
    if (!repoPath || !window.electronAPI) return
    const result = await callGit(() => window.electronAPI!.gitStatus(repoPath))
    if (result.success) {
      setIsRepo(true)
      setStatus(result.status)
      setHasCommits(result.hasCommits === true)
      setMessage(null)
    } else {
      const notRepo = /not a git repository/i.test(result.error || '')
      setIsRepo(!notRepo)
      setStatus(null)
      setHasCommits(false)
      if (!notRepo) setMessage(result.error || t('Failed to get git status'))
    }
  }, [repoPath])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Refresh after AI writes create/update files, and when the fs watcher
  // reports external changes (Explorer re-dispatches them as this event)
  useEffect(() => {
    const handler = () => refresh()
    window.addEventListener('file-created', handler)
    window.addEventListener('teaspoon:project-fs-changed', handler)
    return () => {
      window.removeEventListener('file-created', handler)
      window.removeEventListener('teaspoon:project-fs-changed', handler)
    }
  }, [refresh])

  const runGitAction = async (action: () => Promise<{ success: boolean; error?: string }>, okMessage: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      if (result.success) {
        setMessage(okMessage)
        await refresh()
      } else {
        setMessage(result.error || t('Git operation failed'))
      }
    } finally {
      setBusy(false)
    }
  }

  const handleInit = () => {
    if (!repoPath || !window.electronAPI) return
    runGitAction(() => window.electronAPI!.gitInit(repoPath), t('Repository initialized'))
  }

  const handleCommit = async () => {
    if (!repoPath || !window.electronAPI || !commitMessage.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      // Stage checked files; if none checked, stage everything
      const paths = checked.size > 0
        ? Array.from(checked)
        : ['.']
      const addResult = await window.electronAPI.gitAdd(repoPath, paths)
      if (!addResult.success) {
        setMessage(addResult.error || t('Failed to stage files'))
        return
      }
      const commitResult = await window.electronAPI.gitCommit(repoPath, commitMessage.trim())
      if (commitResult.success) {
        setMessage(t('Committed'))
        setCommitMessage('')
        setChecked(new Set())
        await refresh()
      } else {
        setMessage(commitResult.error || t('Commit failed'))
      }
    } finally {
      setBusy(false)
    }
  }

  const handlePush = () => {
    if (!repoPath || !window.electronAPI) return
    runGitAction(() => window.electronAPI!.gitPush(repoPath), t('Pushed'))
  }

  const handlePull = () => {
    if (!repoPath || !window.electronAPI) return
    runGitAction(() => window.electronAPI!.gitPull(repoPath), t('Pulled'))
  }

  const openCloneDialog = () => {
    setCloneUrl('')
    setDialogMessage(null)
    setDialogMode('clone')
  }

  const handleClone = async () => {
    if (!repoPath || !window.electronAPI || !cloneUrl.trim()) return
    setDialogBusy(true)
    setDialogMessage(null)
    try {
      const result = await callGit(() => window.electronAPI!.gitClone(cloneUrl.trim(), repoPath))
      if (result.success) {
        setDialogMode(null)
        setMessage(t('Repository cloned'))
        window.dispatchEvent(new CustomEvent('file-created', { detail: { filePath: repoPath } }))
        await refresh()
      } else {
        setDialogMessage(result.error || t('Git operation failed'))
      }
    } finally {
      setDialogBusy(false)
    }
  }

  const openRemoteDialog = async () => {
    if (!repoPath || !window.electronAPI) return
    setDialogMode('remote')
    setDialogMessage(null)
    setRemoteBranch(status?.current || '')
    setDialogBusy(true)
    try {
      const result = await callGit(() => window.electronAPI!.gitGetRemotes(repoPath))
      if (result.success) {
        const list = result.remotes || []
        setRemotes(list)
        const selected = list.find((remote: GitRemoteInfo) => remote.name === 'origin') || list[0]
        setRemoteName(selected?.name || 'origin')
        setRemoteUrl(selected?.refs?.fetch || selected?.refs?.push || '')
      } else {
        setRemotes([])
        setRemoteName('origin')
        setRemoteUrl('')
        setDialogMessage(result.error || t('Git operation failed'))
      }
    } finally {
      setDialogBusy(false)
    }
  }

  const handleSaveRemote = async (pushAfterSave = false) => {
    if (!repoPath || !window.electronAPI) return
    const name = remoteName.trim()
    const url = remoteUrl.trim()
    const branch = remoteBranch.trim()
    if (!name || !url) {
      setDialogMessage(t('Remote name and repository URL are required'))
      return
    }
    if (pushAfterSave && !branch) {
      setDialogMessage(t('Branch is required'))
      return
    }
    if (pushAfterSave && !hasCommits) {
      setDialogMessage(initialCommitHint)
      return
    }
    setDialogBusy(true)
    setDialogMessage(null)
    try {
      let result = await callGit(() => window.electronAPI!.gitSetRemote(repoPath, name, url))
      if (result.success && pushAfterSave) {
        result = await callGit(() => window.electronAPI!.gitPushUpstream(repoPath, name, branch))
      }
      if (result.success) {
        setDialogMode(null)
        setMessage(pushAfterSave ? t('Pushed') : t('Remote saved'))
        await refresh()
      } else {
        setDialogMessage(result.error || t('Git operation failed'))
      }
    } finally {
      setDialogBusy(false)
    }
  }

  const handleInitialCommit = async () => {
    if (!repoPath || !window.electronAPI) return
    const changedFiles = Array.isArray(status?.files) ? status.files.length : 0
    if (changedFiles === 0) {
      setDialogMessage(t('Add at least one file before creating the initial commit.'))
      return
    }
    setDialogBusy(true)
    setDialogMessage(null)
    try {
      const addResult = await callGit(() => window.electronAPI!.gitAdd(repoPath, ['.']))
      if (!addResult.success) {
        setDialogMessage(addResult.error || t('Failed to stage files'))
        return
      }
      const commitResult = await callGit(() => window.electronAPI!.gitCommit(repoPath, 'Initial commit'))
      if (!commitResult.success) {
        setDialogMessage(commitResult.error || t('Commit failed'))
        return
      }
      setDialogMessage(t('Initial commit created. You can now push.'))
      setMessage(t('Initial commit created'))
      setChecked(new Set())
      await refresh()
    } finally {
      setDialogBusy(false)
    }
  }

  const loadConfig = async (scope: GitConfigScope) => {
    if (!repoPath || !window.electronAPI) return
    const requestId = ++configLoadSeq.current
    setConfigLoading(true)
    setDialogMessage(null)
    setConfigName('')
    setConfigEmail('')
    try {
      const result = await withTimeout(
        callGit(() => window.electronAPI!.gitGetConfig(repoPath, scope)),
        { success: false, error: t('Git operation failed') },
      )
      if (requestId !== configLoadSeq.current) return
      if (result.success) {
        setConfigName(result.config?.name || '')
        setConfigEmail(result.config?.email || '')
      } else {
        setDialogMessage(result.error || t('Git operation failed'))
      }
    } finally {
      if (requestId === configLoadSeq.current) setConfigLoading(false)
    }
  }

  const openConfigDialog = () => {
    const scope: GitConfigScope = isRepo ? 'local' : 'global'
    setConfigScope(scope)
    setConfigName('')
    setConfigEmail('')
    setDialogMode('config')
    loadConfig(scope)
  }

  const handleSaveConfig = async () => {
    if (!repoPath || !window.electronAPI) return
    const name = configName.trim() || configNameInputRef.current?.value.trim() || ''
    const email = configEmail.trim() || configEmailInputRef.current?.value.trim() || ''
    if (!name || !email) {
      setDialogMessage(t('Name and email are required'))
      return
    }
    setConfigName(name)
    setConfigEmail(email)
    configLoadSeq.current += 1
    setConfigLoading(false)
    setDialogBusy(true)
    setDialogMessage(null)
    try {
      const result = await callGit(() => window.electronAPI!.gitSetConfig(repoPath, configScope, { name, email }))
      if (result.success) {
        setDialogMode(null)
        setMessage(t('Git config saved'))
      } else {
        setDialogMessage(result.error || t('Git operation failed'))
      }
    } finally {
      setDialogBusy(false)
    }
  }

  const toggleCheck = (filePath: string) => {
    const next = new Set(checked)
    if (next.has(filePath)) {
      next.delete(filePath)
    } else {
      next.add(filePath)
    }
    setChecked(next)
  }

  const statusLetter = (file: GitFileEntry): string => {
    const code = file.working_dir !== ' ' && file.working_dir !== '?'
      ? file.working_dir
      : (file.working_dir === '?' ? '?' : file.index)
    return STATUS_LABELS[code] || code || '?'
  }

  const statusTitle = (file: GitFileEntry): string => {
    const code = file.working_dir !== ' ' ? file.working_dir : file.index
    return STATUS_TITLES[code] ? t(STATUS_TITLES[code]) : t('Changed')
  }

  const absPath = (relPath: string) => {
    if (!repoPath) return relPath
    return `${repoPath.replace(/[\\/]+$/, '')}/${relPath.replace(/\\/g, '/')}`
  }

  const renderDialog = () => {
    if (!dialogMode) return null

    const title = dialogMode === 'clone'
      ? t('Clone Repository')
      : dialogMode === 'remote'
        ? t('Remote Setup')
        : t('Git Config')

    return (
      <div className="git-dialog-overlay">
        <div className="git-dialog" role="dialog" aria-modal="true" aria-label={title}>
          <div className="git-dialog-header">
            <h3>{title}</h3>
            <button
              type="button"
              className="git-dialog-close"
              onClick={() => setDialogMode(null)}
              disabled={dialogBusy}
              aria-label={t('Close')}
            >
              ×
            </button>
          </div>

          <div className="git-dialog-body">
            {dialogMode === 'clone' && (
              <>
                <label className="git-dialog-label">
                  <span>{t('Repository URL')}</span>
                  <input
                    value={cloneUrl}
                    onChange={(event) => setCloneUrl(event.target.value)}
                    placeholder="https://github.com/user/repo.git"
                    disabled={dialogBusy}
                    autoFocus
                  />
                </label>
                <label className="git-dialog-label">
                  <span>{t('Target folder')}</span>
                  <input value={repoPath || ''} readOnly />
                </label>
              </>
            )}

            {dialogMode === 'remote' && (
              <>
                {remotes.length > 0 && (
                  <div className="git-existing-remotes">
                    <span>{t('Existing remotes')}</span>
                    {remotes.map(remote => (
                      <button
                        key={remote.name}
                        type="button"
                        className="git-remote-item"
                        onClick={() => {
                          setRemoteName(remote.name)
                          setRemoteUrl(remote.refs?.fetch || remote.refs?.push || '')
                        }}
                        disabled={dialogBusy}
                      >
                        <strong>{remote.name}</strong>
                        <small>{remote.refs?.fetch || remote.refs?.push || ''}</small>
                      </button>
                    ))}
                  </div>
                )}
                <label className="git-dialog-label">
                  <span>{t('Remote name')}</span>
                  <input
                    value={remoteName}
                    onChange={(event) => setRemoteName(event.target.value)}
                    placeholder="origin"
                    disabled={dialogBusy}
                  />
                </label>
                <label className="git-dialog-label">
                  <span>{t('Repository URL')}</span>
                  <input
                    value={remoteUrl}
                    onChange={(event) => setRemoteUrl(event.target.value)}
                    placeholder="https://github.com/user/repo.git"
                    disabled={dialogBusy}
                  />
                </label>
                <label className="git-dialog-label">
                  <span>{t('Branch')}</span>
                  <input
                    value={remoteBranch}
                    onChange={(event) => setRemoteBranch(event.target.value)}
                    placeholder="main"
                    disabled={dialogBusy}
                  />
                </label>
                {!hasCommits && (
                  <div className="git-dialog-notice">
                    <span>{initialCommitHint}</span>
                    <button type="button" onClick={handleInitialCommit} disabled={dialogBusy}>
                      {t('Initial Commit')}
                    </button>
                  </div>
                )}
              </>
            )}

            {dialogMode === 'config' && (
              <>
                <label className="git-dialog-label">
                  <span>{t('Scope')}</span>
                  <select
                    value={configScope}
                    onChange={(event) => {
                      const scope = event.target.value as GitConfigScope
                      setConfigScope(scope)
                      loadConfig(scope)
                    }}
                    disabled={dialogBusy || configLoading}
                  >
                    <option value="local" disabled={isRepo === false}>{t('This repository')}</option>
                    <option value="global">{t('Global')}</option>
                  </select>
                </label>
                <label className="git-dialog-label">
                  <span>{t('Name')}</span>
                  <input
                    ref={configNameInputRef}
                    value={configName}
                    onChange={(event) => setConfigName(event.target.value)}
                    placeholder="user.name"
                    disabled={dialogBusy || configLoading}
                  />
                </label>
                <label className="git-dialog-label">
                  <span>{t('Email')}</span>
                  <input
                    ref={configEmailInputRef}
                    value={configEmail}
                    onChange={(event) => setConfigEmail(event.target.value)}
                    placeholder="user.email"
                    disabled={dialogBusy || configLoading}
                  />
                </label>
              </>
            )}

            {dialogMessage && dialogMessage !== initialCommitHint && (
              <p className="git-dialog-message">{dialogMessage}</p>
            )}
          </div>

          <div className="git-dialog-actions">
            <button type="button" onClick={() => setDialogMode(null)} disabled={dialogBusy}>
              {t('Cancel')}
            </button>
            {dialogMode === 'clone' && (
              <button type="button" className="git-button" onClick={handleClone} disabled={dialogBusy || !cloneUrl.trim()}>
                {t('Clone')}
              </button>
            )}
            {dialogMode === 'remote' && (
              <>
                <button
                  type="button"
                  className="git-button"
                  onClick={() => handleSaveRemote(false)}
                  disabled={dialogBusy}
                >
                  {t('Save Remote')}
                </button>
                <button
                  type="button"
                  className="git-button"
                  onClick={() => handleSaveRemote(true)}
                  disabled={dialogBusy}
                >
                  {t('Save & Push')}
                </button>
              </>
            )}
            {dialogMode === 'config' && (
              <button
                type="button"
                className="git-button"
                onClick={handleSaveConfig}
                disabled={dialogBusy}
              >
                {t('Save Config')}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (!repoPath) {
    return (
      <div className="git-panel">
        <div className="git-empty"><p>{t('Open a project to use Git')}</p></div>
      </div>
    )
  }

  if (isRepo === false) {
    return (
      <div className="git-panel">
        <div className="git-empty">
          <p>{t('This project is not a Git repository')}</p>
          <div className="git-empty-actions">
            <button className="git-button" onClick={handleInit} disabled={busy}>
              {t('Initialize Git')}
            </button>
            <button className="git-button" onClick={openCloneDialog} disabled={busy}>
              {t('Clone into this folder')}
            </button>
            <button className="git-button" onClick={openConfigDialog} disabled={busy}>
              {t('Git Config')}
            </button>
          </div>
          {message && <p className="git-message">{message}</p>}
        </div>
        {renderDialog()}
      </div>
    )
  }

  const files: GitFileEntry[] = status?.files ?? []

  return (
    <div className="git-panel">
      <div className="git-toolbar">
        <span className="git-branch" title={t('Current branch')}>
          ⎇ {status?.current || t('(no commits yet)')}
        </span>
        <span className="git-sync-info">
          {(status?.ahead ?? 0) > 0 && `↑${status.ahead}`}
          {(status?.behind ?? 0) > 0 && `↓${status.behind}`}
        </span>
        <button className="git-icon-button" onClick={handlePull} disabled={busy} title={t('Pull')}>↓</button>
        <button className="git-icon-button" onClick={handlePush} disabled={busy} title={t('Push')}>↑</button>
        <button className="git-icon-button" onClick={openRemoteDialog} disabled={busy} title={t('Remote Setup')}>⇄</button>
        <button className="git-icon-button" onClick={openConfigDialog} disabled={busy} title={t('Git Config')}>⚙</button>
        <button className="git-icon-button" onClick={refresh} disabled={busy} title={t('Refresh')}>⟳</button>
      </div>

      {message && <p className="git-message">{message}</p>}

      <div className="git-changes">
        {files.length === 0 ? (
          <p className="git-clean">{t('No changes')}</p>
        ) : (
          files.map((file) => (
            <div key={file.path} className="git-file">
              <input
                type="checkbox"
                checked={checked.has(file.path)}
                onChange={() => toggleCheck(file.path)}
                title={t('Stage for commit')}
              />
              <span
                className="git-file-name"
                onClick={() => onOpenDiff(absPath(file.path))}
                title={file.path}
              >
                {file.path}
              </span>
              <span className="git-file-status" title={statusTitle(file)}>
                {statusLetter(file)}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="git-commit">
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder={t('Commit message')}
          rows={3}
          disabled={busy || files.length === 0}
        />
        <button
          className="git-button"
          onClick={handleCommit}
          disabled={busy || !commitMessage.trim() || files.length === 0}
          title={checked.size === 0 ? t('Commits all changes') : `${t('Commits')} ${checked.size} ${t('selected file(s)')}`}
        >
          {checked.size === 0 ? t('Commit All') : `${t('Commit')} (${checked.size})`}
        </button>
      </div>
      {renderDialog()}
    </div>
  )
}

export default GitPanel
