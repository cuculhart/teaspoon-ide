import React, { useState, useEffect, useMemo, useRef } from 'react'
import { projectService } from '../services/projectService'
import { contextService } from '../services/contextService'
import { configService, RecentProject } from '../services/configService'
import { useT } from '../services/i18nService'
import './Explorer.css'

interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  depth: number
}

interface ExplorerProps {
  onFileSelect: (path: string) => void
  onProjectChange?: (project: any) => void
}

const Explorer: React.FC<ExplorerProps> = ({ onFileSelect, onProjectChange }) => {
  const t = useT()
  const [rootItems, setRootItems] = useState<FileItem[]>([])
  const [childrenMap, setChildrenMap] = useState<Map<string, FileItem[]>>(new Map())
  const [projectName, setProjectName] = useState<string>('')
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [showProjectDialog, setShowProjectDialog] = useState(false)
  const [useAutoContext, setUseAutoContext] = useState(true)
  const [contextStats, setContextStats] = useState<any>(null)
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const [openError, setOpenError] = useState<string | null>(null)
  const [dialogMode, setDialogMode] = useState<'open' | 'create' | 'clone'>('open')
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectParent, setNewProjectParent] = useState('')
  const [cloneUrl, setCloneUrl] = useState('')
  const [dialogBusy, setDialogBusy] = useState(false)
  const [newItem, setNewItem] = useState<{ parentPath: string; type: 'file' | 'dir'; depth: number } | null>(null)
  const [newItemName, setNewItemName] = useState('')

  const restoreAttemptedRef = useRef(false)
  const refreshBusyRef = useRef(false)
  const refreshQueuedRef = useRef(false)

  useEffect(() => {
    const refreshRecents = () => setRecentProjects(configService.getRecentProjects())
    refreshRecents()
    // Settings > Clear History clears the list while Explorer stays mounted
    window.addEventListener('teaspoon:recents-cleared', refreshRecents)

    // Restore the previously open project after a reload (e.g. Ctrl+R)
    if (!restoreAttemptedRef.current && !projectService.getCurrentProject()?.isOpen) {
      restoreAttemptedRef.current = true
      const lastPath = configService.getLastProjectPath()
      if (lastPath) {
        openProjectByPath(lastPath, false)
      }
    }
    return () => window.removeEventListener('teaspoon:recents-cleared', refreshRecents)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const expandedDirsRef = useRef<Set<string>>(expandedDirs)
  useEffect(() => {
    expandedDirsRef.current = expandedDirs
  }, [expandedDirs])

  // Visible items are derived deterministically from the tree + expansion state
  const items = useMemo(() => {
    const visible: FileItem[] = []
    const walk = (list: FileItem[]) => {
      for (const item of list) {
        visible.push(item)
        if (item.isDirectory && expandedDirs.has(item.path)) {
          const children = childrenMap.get(item.path)
          if (children) walk(children)
        }
      }
    }
    walk(rootItems)
    return visible
  }, [rootItems, childrenMap, expandedDirs])

  const readDirItems = async (dirPath: string, depth: number): Promise<FileItem[]> => {
    if (!window.electronAPI) return []
    const result = await window.electronAPI.readDirectory(dirPath)
    if (result.success && result.items) {
      return result.items.map(item => ({
        name: item.name,
        path: item.path,
        isDirectory: item.isDirectory,
        depth,
      }))
    }
    return []
  }

  const loadProjectFiles = async (rootPath: string) => {
    if (!window.electronAPI) return
    const fileItems = await readDirItems(rootPath, 0)
    setRootItems(fileItems)

    // Reload children for directories that are currently expanded
    const expanded = expandedDirsRef.current
    const newChildrenMap = new Map<string, FileItem[]>()
    const reloadExpanded = async (list: FileItem[]) => {
      for (const item of list) {
        if (item.isDirectory && expanded.has(item.path)) {
          const children = await readDirItems(item.path, item.depth + 1)
          newChildrenMap.set(item.path, children)
          await reloadExpanded(children)
        }
      }
    }
    await reloadExpanded(fileItems)
    setChildrenMap(newChildrenMap)
    console.log('Project files loaded:', fileItems.length)
  }

  // Reload the tree, coalescing bursts of change events (the fs watcher,
  // IDE-internal file-created events, and the refresh button can all fire
  // in rapid succession)
  const refreshProjectFiles = async () => {
    const project = projectService.getCurrentProject()
    if (!project?.isOpen) return
    const rootPath = project.rootPath
    if (refreshBusyRef.current) {
      refreshQueuedRef.current = true
      return
    }
    refreshBusyRef.current = true
    try {
      do {
        refreshQueuedRef.current = false
        await loadProjectFiles(rootPath)
      } while (
        refreshQueuedRef.current &&
        projectService.getCurrentProject()?.rootPath === rootPath
      )
    } finally {
      refreshBusyRef.current = false
    }
  }

  useEffect(() => {
    // Listen for file creation events to refresh explorer
    const handleFileCreated = (event: CustomEvent) => {
      const { filePath } = event.detail
      console.log('File created event received:', filePath)

      refreshProjectFiles()
    }

    window.addEventListener('file-created', handleFileCreated as EventListener)

    return () => {
      window.removeEventListener('file-created', handleFileCreated as EventListener)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync the tree with changes made outside the IDE (external editors,
  // Windows Explorer, terminal, git checkout, ...)
  useEffect(() => {
    const off = window.electronAPI?.onProjectFsChanged?.(() => {
      refreshProjectFiles()
      // Reuse the signal to refresh other panels (e.g. Git status)
      window.dispatchEvent(new CustomEvent('teaspoon:project-fs-changed'))
    })
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep latest handlers accessible to the menu listener.
  // Populated just before render (see below) since the handlers are
  // declared later in this component.
  const actionsRef = useRef<{ openDialog: any; startNewItem: any; handleCloseProject: any }>({
    openDialog: null,
    startNewItem: null,
    handleCloseProject: null,
  })

  // Application menu actions (forwarded from the main process via App.tsx)
  useEffect(() => {
    const handler = (event: Event) => {
      const action = (event as CustomEvent).detail
      const a = actionsRef.current
      const project = projectService.getCurrentProject()
      switch (action) {
        case 'open-project':
          a.openDialog('open')
          break
        case 'new-project':
          a.openDialog('create')
          break
        case 'clone-project':
          a.openDialog('clone')
          break
        case 'close-project':
          if (project?.isOpen) a.handleCloseProject()
          break
        case 'open-project-folder':
          if (project?.isOpen) openProjectFolder()
          break
        case 'new-file':
          if (project?.isOpen) a.startNewItem(project.rootPath, 'file', 0)
          break
        case 'new-folder':
          if (project?.isOpen) a.startNewItem(project.rootPath, 'dir', 0)
          break
      }
    }
    window.addEventListener('app-menu', handler)
    return () => window.removeEventListener('app-menu', handler)
  }, [])

  const openProjectByPath = async (folderPath: string, countOpen = true) => {
    try {
      const project = await projectService.openProject(folderPath)
      setProjectName(project.name)
      setShowProjectDialog(false)
      setOpenError(null)
      if (countOpen) {
        configService.addRecentProject(project.name, project.rootPath)
        setRecentProjects(configService.getRecentProjects())
      }
      configService.setLastProjectPath(project.rootPath)
      onProjectChange?.(project)
      console.log('Project opened:', project.name)
      // Load the project files first
      await loadProjectFiles(project.rootPath)
      // Keep the tree in sync with external file system changes
      window.electronAPI?.watchProject?.(project.rootPath)
      // Then build automatic context
      await buildAutomaticContext()
      // Restore the file that was open before a reload
      await restoreLastOpenFile(project.rootPath)
    } catch (error) {
      console.error('Failed to open project:', error)
      // The folder may have been deleted - remove it from the recent list
      configService.removeRecentProject(folderPath)
      if (folderPath === configService.getLastProjectPath()) {
        configService.setLastProjectPath('')
      }
      setRecentProjects(configService.getRecentProjects())
      setOpenError(`${t('Failed to open')}: ${folderPath}`)
    }
  }

  const restoreLastOpenFile = async (rootPath: string) => {
    const lastFile = configService.getLastOpenFile()
    if (!lastFile || !window.electronAPI) return

    const normalized = lastFile.replace(/\\/g, '/')
    const root = rootPath.replace(/\\/g, '/')
    if (!normalized.toLowerCase().startsWith(root.toLowerCase() + '/')) {
      configService.setLastOpenFile('')
      return
    }

    const result = await window.electronAPI.readFile(lastFile)
    if (result.success) {
      onFileSelect(lastFile)
    } else {
      configService.setLastOpenFile('')
    }
  }

  const handleOpenProject = async () => {
    // Open folder selection dialog
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.selectFolder()

        if (result.success && result.folderPath && !result.canceled) {
          await openProjectByPath(result.folderPath)
        } else if (result.canceled) {
          setShowProjectDialog(false)
        }
      }
    } catch (error) {
      console.error('Failed to open project:', error)
    }
  }

  const handleSelectParent = async () => {
    if (!window.electronAPI) return
    const result = await window.electronAPI.selectFolder()
    if (result.success && result.folderPath && !result.canceled) {
      setNewProjectParent(result.folderPath)
      localStorage.setItem('last_parent_dir', result.folderPath)
      setOpenError(null)
    }
  }

  const handleCreateProject = async () => {
    const name = newProjectName.trim()
    if (!name || !newProjectParent || !window.electronAPI) return
    if (/[\\/:*?"<>|]/.test(name)) {
      setOpenError(t('Project name contains invalid characters') + ': \\ / : * ? " < > |')
      return
    }
    const projectPath = `${newProjectParent.replace(/[\\/]+$/, '')}/${name}`
    const result = await window.electronAPI.createDirectory(projectPath)
    if (result.success) {
      setNewProjectName('')
      setDialogMode('open')
      await openProjectByPath(projectPath)
    } else {
      setOpenError(result.error || t('Failed to create project folder'))
    }
  }

  const inferredCloneName = (url: string) => {
    const lastPart = url.trim()
      .replace(/[?#].*$/, '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || ''
    return lastPart.replace(/\.git$/i, '').replace(/[\\/:*?"<>|]/g, '-')
  }

  const handleCloneUrlChange = (url: string) => {
    setCloneUrl(url)
    if (!newProjectName) setNewProjectName(inferredCloneName(url))
  }

  const handleCloneProject = async () => {
    const name = newProjectName.trim()
    if (!name || !newProjectParent || !cloneUrl.trim() || !window.electronAPI) return
    if (/[\\/:*?"<>|]/.test(name)) {
      setOpenError(t('Project name contains invalid characters') + ': \\ / : * ? " < > |')
      return
    }
    const projectPath = `${newProjectParent.replace(/[\\/]+$/, '')}/${name}`
    setDialogBusy(true)
    setOpenError(null)
    try {
      const result = await window.electronAPI.gitClone(cloneUrl.trim(), projectPath)
      if (result.success) {
        setNewProjectName('')
        setCloneUrl('')
        setDialogMode('open')
        await openProjectByPath(projectPath)
      } else {
        setOpenError(result.error || t('Git operation failed'))
      }
    } finally {
      setDialogBusy(false)
    }
  }

  // Start inline creation of a file/folder under parentPath
  const startNewItem = async (parentPath: string, type: 'file' | 'dir', depth: number) => {
    const project = projectService.getCurrentProject()
    if (!project) return

    // Expand the parent directory so the input row and new item are visible
    if (parentPath !== project.rootPath) {
      if (!childrenMap.has(parentPath)) {
        const parentItem = items.find(i => i.path === parentPath)
        const children = await readDirItems(parentPath, (parentItem?.depth ?? depth - 1) + 1)
        setChildrenMap(prev => new Map(prev).set(parentPath, children))
      }
      setExpandedDirs(prev => new Set(prev).add(parentPath))
    }
    setNewItem({ parentPath, type, depth })
    setNewItemName('')
    setOpenError(null)
  }

  const cancelNewItem = () => {
    setNewItem(null)
    setNewItemName('')
  }

  const submitNewItem = async () => {
    const name = newItemName.trim()
    if (!newItem || !window.electronAPI) return
    if (!name) {
      cancelNewItem()
      return
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      setOpenError(t('Name contains invalid characters') + ': \\ / : * ? " < > |')
      return
    }
    const target = `${newItem.parentPath.replace(/[\\/]+$/, '')}/${name}`
    try {
      const result = newItem.type === 'dir'
        ? await window.electronAPI.createDirectory(target)
        : await window.electronAPI.writeFile(target, '')
      if (!result.success) throw new Error(result.error)
      cancelNewItem()
      const project = projectService.getCurrentProject()
      if (project) await loadProjectFiles(project.rootPath)
      window.dispatchEvent(new CustomEvent('file-created', { detail: { filePath: target } }))
    } catch (error) {
      console.error('Failed to create item:', error)
      setOpenError(`${t('Failed to create')} ${name}: ${error}`)
    }
  }

  // Show what the auto context will send: file count (tree mode) or
  // token estimate (full mode, Settings > AI Context)
  const buildAutomaticContext = async () => {
    try {
      const project = projectService.getCurrentProject()
      if (!project) return
      if (configService.getContextMode() === 'full') {
        const allFiles = await projectService.getAllFiles()
        await contextService.buildProjectContext(
          allFiles.map(f => f.path),
          projectService.readFile.bind(projectService),
        )
        const stats = contextService.getContextStats()
        setContextStats({ fileCount: stats.files.length, totalTokens: stats.totalTokens })
      } else {
        const result = await window.electronAPI!.findFiles(project.rootPath, '*', configService.getContextMaxFiles())
        if (result.success) {
          setContextStats({ fileCount: result.files?.length ?? 0, truncated: result.truncated })
        }
      }
    } catch (error) {
      console.error('Failed to build automatic context:', error)
    }
  }

  // Open a project from an external path: folder dropped on the exe
  // (CLI arg), second-instance launch, or a drop on the app window
  useEffect(() => {
    const openPath = (p: string | null) => {
      if (p) openProjectByPath(p)
    }
    const offIpc = window.electronAPI?.onOpenProjectPath?.(openPath)
    window.electronAPI?.takePendingFolder?.().then(openPath)
    const onWindowDrop = (e: Event) => openPath((e as CustomEvent).detail)
    window.addEventListener('teaspoon:open-project-path', onWindowDrop)
    return () => {
      offIpc?.()
      window.removeEventListener('teaspoon:open-project-path', onWindowDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A project opened or closed outside the Explorer (e.g. the chat's
  // create-project prompt, or picking a project-less conversation from
  // the chat list). Refresh the tree/watcher here instead of going
  // through openProjectByPath/handleCloseProject - their onProjectChange
  // calls would remount the chat and orphan an in-flight agent loop.
  useEffect(() => {
    const onExternalOpen = async (event: Event) => {
      const rootPath = (event as CustomEvent).detail?.rootPath
      const project = projectService.getCurrentProject()
      if (!project?.isOpen) {
        // Closed outside the Explorer - clear the tree like
        // handleCloseProject does, minus the onProjectChange remount.
        window.electronAPI?.unwatchProject?.()
        setRootItems([])
        setChildrenMap(new Map())
        setExpandedDirs(new Set())
        setProjectName('')
        setSelectedFiles(new Set())
        setContextStats(null)
        setNewItem(null)
        setNewItemName('')
        setOpenError(null)
        return
      }
      if (!rootPath || project.rootPath !== rootPath) return
      setProjectName(project.name)
      setOpenError(null)
      setRecentProjects(configService.getRecentProjects())
      await loadProjectFiles(rootPath)
      window.electronAPI?.watchProject?.(rootPath)
      await buildAutomaticContext()
    }
    window.addEventListener('teaspoon:project-opened', onExternalOpen)
    return () => window.removeEventListener('teaspoon:project-opened', onExternalOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh the stats when the user changes Settings > AI Context
  useEffect(() => {
    const refresh = () => {
      if (useAutoContext) buildAutomaticContext()
    }
    window.addEventListener('teaspoon:context-changed', refresh)
    return () => window.removeEventListener('teaspoon:context-changed', refresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useAutoContext])

  const toggleContextMode = () => {
    setUseAutoContext(!useAutoContext)
    if (!useAutoContext) {
      buildAutomaticContext()
    } else {
      contextService.clearContext()
      setContextStats(null)
    }
  }

  const handleCloseProject = () => {
    window.electronAPI?.unwatchProject?.()
    projectService.closeProject()
    contextService.clearContext()
    // Explicit close - do not restore the project on next reload
    configService.setLastProjectPath('')
    configService.setLastOpenFile('')
    setRootItems([])
    setChildrenMap(new Map())
    setExpandedDirs(new Set())
    setProjectName('')
    setSelectedFiles(new Set())
    setContextStats(null)
    setNewItem(null)
    setNewItemName('')
    setOpenError(null)
    onProjectChange?.(null)
  }

  const toggleDirectory = async (item: FileItem) => {
    if (!item.isDirectory) {
      onFileSelect(item.path)
      return
    }

    const newExpanded = new Set(expandedDirs)

    if (expandedDirs.has(item.path)) {
      // Collapse: children stay cached in childrenMap
      newExpanded.delete(item.path)
      setExpandedDirs(newExpanded)
      return
    }

    // Expand: load children if not already cached
    if (!childrenMap.has(item.path)) {
      const children = await readDirItems(item.path, item.depth + 1)
      setChildrenMap(prev => new Map(prev).set(item.path, children))
    }
    newExpanded.add(item.path)
    setExpandedDirs(newExpanded)
  }

  const toggleFileSelection = (e: React.MouseEvent, item: FileItem) => {
    e.stopPropagation()
    if (!item.isDirectory) {
      const newSelected = new Set(selectedFiles)
      if (newSelected.has(item.path)) {
        newSelected.delete(item.path)
        projectService.deselectFile(item.path)
      } else {
        newSelected.add(item.path)
        projectService.selectFile(item.path)
      }
      setSelectedFiles(newSelected)
    }
  }

  const renderRecentProjects = () => {
    if (recentProjects.length === 0) return null
    return (
      <div className="recent-projects">
        <p className="recent-projects-label">{t('Recent Projects')}</p>
        {recentProjects.map(p => (
          <button
            key={p.path}
            className="recent-project-item"
            onClick={() => openProjectByPath(p.path)}
            title={p.path}
          >
            <span className="recent-project-name">{p.name}</span>
            <span className="recent-project-path">{p.path}</span>
          </button>
        ))}
      </div>
    )
  }

  const renderNewItemInput = () => {
    if (!newItem) return null
    return (
      <div
        className="explorer-item"
        style={{ paddingLeft: `${newItem.depth * 16 + 12}px` }}
      >
        <span className="explorer-icon">{newItem.type === 'dir' ? '📁' : '📄'}</span>
        <input
          autoFocus
          className="new-item-input"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitNewItem()
            if (e.key === 'Escape') cancelNewItem()
          }}
          onBlur={cancelNewItem}
          placeholder={newItem.type === 'dir' ? t('Folder name') : t('File name')}
        />
      </div>
    )
  }

  const openDialog = (mode: 'open' | 'create' | 'clone') => {
    setDialogMode(mode)
    if (mode === 'create' || mode === 'clone') {
      setNewProjectParent(localStorage.getItem('last_parent_dir') || '')
      setNewProjectName('')
    }
    if (mode === 'clone') setCloneUrl('')
    setOpenError(null)
    setShowProjectDialog(true)
  }

  const openProjectFolder = async () => {
    const project = projectService.getCurrentProject()
    if (!project?.isOpen || !window.electronAPI?.openPath) return
    const result = await window.electronAPI.openPath(project.rootPath, '.')
    if (!result.success) console.error('Failed to open project folder:', result.error)
  }

  const rootPath = projectService.getCurrentProject()?.rootPath

  actionsRef.current = { openDialog, startNewItem, handleCloseProject }

  return (
    <div className="explorer">
      <div className="explorer-header">
        <div className="project-info">
          <h3>{projectName || t('Explorer')}</h3>
          <div className="project-actions">
            {projectName && (
              <>
                <button
                  className="new-item-button"
                  onClick={() => rootPath && startNewItem(rootPath, 'file', 0)}
                  title={t('New File')}
                >
                  📄+
                </button>
                <button
                  className="new-item-button"
                  onClick={() => rootPath && startNewItem(rootPath, 'dir', 0)}
                  title={t('New Folder')}
                >
                  📁+
                </button>
                <button
                  className="new-item-button"
                  onClick={() => refreshProjectFiles()}
                  title={t('Refresh Explorer')}
                >
                  ⟳
                </button>
                <button
                  className="new-item-button"
                  onClick={openProjectFolder}
                  title={t('Open Project Folder')}
                >
                  ↗
                </button>
                <button
                  className={`context-mode-button ${useAutoContext ? 'active' : ''}`}
                  onClick={toggleContextMode}
                  title={useAutoContext ? t('Using automatic context') : t('Using manual file selection')}
                >
                  🧠
                </button>
                <button
                  className="close-project-button"
                  onClick={handleCloseProject}
                  title={t('Close Project')}
                >
                  ✕
                </button>
              </>
            )}
            <button
              className="open-project-button"
              onClick={() => openDialog('open')}
              title={t('Open Project')}
            >
              📂
            </button>
          </div>
        </div>
        {contextStats && useAutoContext && (
          <div className="context-stats">
            <span className="stat-item">{contextStats.fileCount} {t('files in context')}</span>
            {contextStats.totalTokens != null && (
              <span className="stat-item">~{Math.round(contextStats.totalTokens / 1000)}k {t('tokens')}</span>
            )}
            {contextStats.truncated && <span className="stat-item">({t('truncated')})</span>}
          </div>
        )}

      </div>
      
      {showProjectDialog && (
        <div className="project-dialog">
          <div className="project-dialog-content">
            {dialogMode === 'open' ? (
              <>
                <h4>{t('Open Project')}</h4>
                <p>{t('Select a folder to open as a project')}</p>
                <p className="dialog-note">{t('A folder selection dialog will open to choose your project directory.')}</p>
                {renderRecentProjects()}
                {openError && <p className="open-error">{openError}</p>}
                <div className="dialog-actions">
                  <button onClick={handleOpenProject}>{t('Select Folder')}</button>
                  <button onClick={() => openDialog('clone')}>{t('Clone Repository')}</button>
                  <button onClick={() => openDialog('create')}>{t('New Project')}</button>
                  <button onClick={() => setShowProjectDialog(false)}>{t('Cancel')}</button>
                </div>
              </>
            ) : dialogMode === 'create' ? (
              <>
                <h4>{t('New Project')}</h4>
                <input
                  autoFocus
                  className="dialog-input"
                  placeholder={t('Project name')}
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject() }}
                />
                <button className="parent-folder-button" onClick={handleSelectParent}>
                  {newProjectParent ? `📁 ${newProjectParent}` : `📁 ${t('Choose parent folder...')}`}
                </button>
                {openError && <p className="open-error">{openError}</p>}
                <div className="dialog-actions">
                  <button
                    onClick={handleCreateProject}
                    disabled={!newProjectName.trim() || !newProjectParent}
                  >
                    {t('Create & Open')}
                  </button>
                  <button onClick={() => setDialogMode('open')}>{t('Back')}</button>
                </div>
              </>
            ) : (
              <>
                <h4>{t('Clone Repository')}</h4>
                <input
                  autoFocus
                  className="dialog-input"
                  placeholder={t('Repository URL')}
                  value={cloneUrl}
                  onChange={(e) => handleCloneUrlChange(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCloneProject() }}
                />
                <input
                  className="dialog-input"
                  placeholder={t('Project name')}
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCloneProject() }}
                />
                <button className="parent-folder-button" onClick={handleSelectParent} disabled={dialogBusy}>
                  {newProjectParent ? `📁 ${newProjectParent}` : `📁 ${t('Choose parent folder...')}`}
                </button>
                {openError && <p className="open-error">{openError}</p>}
                <div className="dialog-actions">
                  <button
                    onClick={handleCloneProject}
                    disabled={dialogBusy || !cloneUrl.trim() || !newProjectName.trim() || !newProjectParent}
                  >
                    {t('Clone & Open')}
                  </button>
                  <button onClick={() => openDialog('open')} disabled={dialogBusy}>{t('Back')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      
      <div className="explorer-content">
        {items.length === 0 && !projectName && (
          <div className="explorer-empty">
            <p>{t('No project is currently open')}</p>
            <button onClick={() => openDialog('open')}>{t('Open Project')}</button>
            <button className="new-project-empty-button" onClick={() => openDialog('create')}>{t('New Project')}</button>
            {renderRecentProjects()}
            {openError && <p className="open-error">{openError}</p>}
          </div>
        )}
        {items.length === 0 && projectName && !newItem && (
          <div className="explorer-empty">
            <p>{t('Empty project. Use 📄+ / 📁+ to add files.')}</p>
          </div>
        )}
        {newItem && newItem.parentPath === rootPath && renderNewItemInput()}
        {items.map((item) => (
          <React.Fragment key={item.path}>
            <div
              className={`explorer-item ${item.isDirectory ? 'directory' : 'file'} ${selectedFiles.has(item.path) ? 'selected' : ''}`}
              style={{ paddingLeft: `${item.depth * 16 + 12}px` }}
              onClick={() => toggleDirectory(item)}
            >
              <span className="explorer-icon">
                {item.isDirectory ? (expandedDirs.has(item.path) ? '📂' : '📁') : '📄'}
              </span>
              <span className="explorer-name">{item.name}</span>
              {item.isDirectory ? (
                <span className="dir-actions">
                  <button
                    onClick={(e) => { e.stopPropagation(); startNewItem(item.path, 'file', item.depth + 1) }}
                    title={t('New File')}
                  >
                    📄+
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); startNewItem(item.path, 'dir', item.depth + 1) }}
                    title={t('New Folder')}
                  >
                    📁+
                  </button>
                </span>
              ) : (
                <button
                  className="select-file-button"
                  onClick={(e) => toggleFileSelection(e, item)}
                  title={selectedFiles.has(item.path) ? t('Deselect for AI') : t('Select for AI')}
                >
                  {selectedFiles.has(item.path) ? '✓' : '+'}
                </button>
              )}
            </div>
            {newItem && newItem.parentPath === item.path && renderNewItemInput()}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

export default Explorer
