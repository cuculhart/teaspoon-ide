import React, { useState, useEffect, useRef } from 'react'
import Explorer from './components/Explorer'
import Editor from './components/Editor'
import Chat from './components/Chat'
import Settings from './components/Settings'
import About from './components/About'
import ManagedGate from './components/ManagedGate'
import GitPanel from './components/GitPanel'
import TerminalPanel from './components/TerminalPanel'
import QuickOpen from './components/QuickOpen'
import SearchPanel from './components/SearchPanel'
import { projectService } from './services/projectService'
import { renderMarkdown, markdownDocument } from './utils/markdown'
import { i18nService, useT } from './services/i18nService'
import { configService } from './services/configService'
import { themeService } from './services/themeService'
import './App.css'

// Drag handle between panels. onDelta receives the pointer delta in px
// along the drag axis (vertical splitter: dx, horizontal splitter: dy).
const Splitter: React.FC<{
  orientation: 'vertical' | 'horizontal'
  onDelta: (delta: number) => void
}> = ({ orientation, onDelta }) => {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const bodyClass = orientation === 'vertical' ? 'resizing-col' : 'resizing-row'
    document.body.classList.add(bodyClass)
    let last = orientation === 'vertical' ? e.clientX : e.clientY
    const onMove = (ev: MouseEvent) => {
      const pos = orientation === 'vertical' ? ev.clientX : ev.clientY
      onDelta(pos - last)
      last = pos
    }
    const onUp = () => {
      document.body.classList.remove(bodyClass)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  return <div className={`splitter splitter-${orientation}`} onMouseDown={handleMouseDown} />
}

function App() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [showSettings, setShowSettings] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [settingsKey, setSettingsKey] = useState(0) // Force re-render of Chat when API key changes
  const [sidebarTab, setSidebarTab] = useState<'explorer' | 'git' | 'search'>('explorer')
  const [showQuickOpen, setShowQuickOpen] = useState(false)
  const [gotoLine, setGotoLine] = useState<{ line: number; n: number } | null>(null)
  const [managedLocked, setManagedLocked] = useState(configService.isManagedLocked())
  const fileHistoryRef = useRef<string[]>([]) // absolute paths, most recent first
  const managedLockedRef = useRef(managedLocked)
  managedLockedRef.current = managedLocked

  // Managed mode: re-evaluate the lock when the session changes or expires
  useEffect(() => {
    const refresh = () => setManagedLocked(configService.isManagedLocked())
    window.addEventListener('teaspoon:managed-changed', refresh)
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = configService.getManagedSessionExpiry()
    if (configService.getManagedMode() && expiry) {
      timer = setTimeout(refresh, Math.max(0, expiry - Date.now()))
    }
    return () => {
      window.removeEventListener('teaspoon:managed-changed', refresh)
      if (timer) clearTimeout(timer)
    }
  }, [managedLocked])

  // Load the saved UI language once at startup
  useEffect(() => {
    i18nService.init()
  }, [])

  // Dropping a folder anywhere on the window opens it as a project
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer?.files?.[0]
      if (!file || !window.electronAPI?.getPathForFile) return
      const p = window.electronAPI.getPathForFile(file)
      if (p) {
        window.dispatchEvent(new CustomEvent('teaspoon:open-project-path', { detail: p }))
      }
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // Settings > Clear History empties the Quick Open recent-files list
  useEffect(() => {
    const clear = () => {
      fileHistoryRef.current = []
    }
    window.addEventListener('teaspoon:clear-file-history', clear)
    return () => window.removeEventListener('teaspoon:clear-file-history', clear)
  }, [])
  const [sidebarWidth, setSidebarWidth] = useState(250)
  const [chatWidth, setChatWidth] = useState(400)
  const [terminalHeight, setTerminalHeight] = useState(280)
  const [diffView, setDiffView] = useState<{ filePath: string; original: string; modified: string } | null>(null)
  const [showTerminal, setShowTerminal] = useState(false)
  const t = useT()
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 4000)
  }

  // File > Export Markdown to PDF/HTML: render the open .md file to a
  // standalone HTML document, then let the main process print or save it.
  const buildMarkdownDoc = () => {
    if (!selectedFile?.toLowerCase().endsWith('.md')) {
      showToast(t('Open a Markdown (.md) file first'))
      return null
    }
    const title = selectedFile.split(/[\\/]/).pop()?.replace(/\.md$/i, '') || 'document'
    return { title, html: markdownDocument(title, renderMarkdown(fileContent)) }
  }

  const handleExportPdf = async () => {
    const doc = buildMarkdownDoc()
    if (!doc) return
    const result = await window.electronAPI!.exportPdf(doc.html, `${doc.title}.pdf`)
    if (!result.success) showToast(`${t('PDF export failed')}: ${result.error}`)
    else if (result.canceled) showToast(t('PDF export canceled'))
    else showToast(`${t('Exported')}: ${result.filePath}`)
  }

  const handleExportHtml = async () => {
    const doc = buildMarkdownDoc()
    if (!doc) return
    const result = await window.electronAPI!.exportHtml(doc.html, `${doc.title}.html`)
    if (!result.success) showToast(`${t('HTML export failed')}: ${result.error}`)
    else if (result.canceled) showToast(t('HTML export canceled'))
    else showToast(`${t('Exported')}: ${result.filePath}`)
  }

  // Apply saved theme and font settings on startup
  useEffect(() => {
    themeService.init()
  }, [])

  const handleFileSelect = async (filePath: string) => {
    setSelectedFile(filePath)
    setDiffView(null)
    configService.setLastOpenFile(filePath)
    fileHistoryRef.current = [filePath, ...fileHistoryRef.current.filter(p => p !== filePath)].slice(0, 20)
    // Read file content via project service
    try {
      const content = await projectService.readFile(filePath)
      setFileContent(content)
    } catch (error) {
      console.error('Failed to read file:', error)
    }
  }

  // Refresh the editor when a file is written by the AI
  useEffect(() => {
    const handleFileCreated = (event: Event) => {
      const filePath = (event as CustomEvent).detail?.filePath
      if (!filePath || !selectedFile) return

      const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
      if (normalize(filePath) === normalize(selectedFile)) {
        projectService.readFile(selectedFile)
          .then(setFileContent)
          .catch((error) => console.error('Failed to reload file:', error))
      }
    }

    window.addEventListener('file-created', handleFileCreated)
    return () => window.removeEventListener('file-created', handleFileCreated)
  }, [selectedFile])

  // Route application menu actions from the main process
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onMenuAction) return

    const unsubscribe = api.onMenuAction((action: string) => {
      // While the sign-in gate is up, menu accelerators must not reach
      // the workspace (save/export/open would run against hidden UI).
      if (managedLockedRef.current) return
      if (action === 'toggle-terminal') {
        setShowTerminal(prev => !prev)
        return
      }
      if (action === 'quick-open') {
        if (projectService.getCurrentProject()) setShowQuickOpen(true)
        return
      }
      if (action === 'export-pdf') {
        handleExportPdf()
        return
      }
      if (action === 'export-html') {
        handleExportHtml()
        return
      }
      if (action === 'about') {
        setShowAbout(true)
        return
      }
      if (action === 'save-file') {
        // Save is handled here because App owns the editor content
        if (selectedFile) {
          projectService.writeFile(selectedFile, fileContent)
            .catch((error) => console.error('Failed to save file:', error))
        }
        return
      }
      window.dispatchEvent(new CustomEvent('app-menu', { detail: action }))
    })
    return unsubscribe
  }, [selectedFile, fileContent])

  // AI-issued commands (RUN_COMMAND) spawn terminal processes - make sure
  // the panel is visible so the user can see output and type input.
  useEffect(() => {
    const handleSpawned = () => setShowTerminal(true)
    window.addEventListener('terminal-spawned', handleSpawned)
    return () => window.removeEventListener('terminal-spawned', handleSpawned)
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('teaspoon:layout-changed'))
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [showTerminal, terminalHeight])

  // Ctrl+P opens the quick-open file switcher (menu accelerator covers it
  // too, but this keeps it working when the menu bar is hidden)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        if (projectService.getCurrentProject()) setShowQuickOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Search panel / quick-open result -> open file and jump to a line
  const handleOpenFileAt = async (filePath: string, line: number) => {
    await handleFileSelect(filePath)
    setGotoLine({ line, n: Date.now() })
  }

  const handleContentChange = (newContent: string) => {
    setFileContent(newContent)
  }

  const handleApiKeySaved = () => {
    setSettingsKey(prev => prev + 1) // Force re-render of Chat component
  }

  const handleProjectChange = (project: any) => {
    if (!project) {
      // Project closed: release the open file from the editor
      setSelectedFile(null)
      setFileContent('')
      setDiffView(null)
      setSidebarTab('explorer')
    }
    // Force re-render of Chat component when project changes
    setSettingsKey(prev => prev + 1)
  }

  // Open a diff between HEAD and the working tree for a changed file
  const handleOpenDiff = async (filePath: string) => {
    const project = projectService.getCurrentProject()
    if (!project || !window.electronAPI) return
    const head = await window.electronAPI.gitFileAtHead(project.rootPath, filePath)
    const current = await window.electronAPI.readFile(filePath)
    setDiffView({
      filePath,
      original: head.success ? head.content ?? '' : '',
      modified: current.success ? current.content ?? '' : '',
    })
  }

  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

  // Managed mode without a valid session: replace the whole workspace
  // with the sign-in gate until credentials are issued by the server.
  if (managedLocked) {
    return <ManagedGate />
  }

  return (
    <div className="app">
      <div className="sidebar" style={{ width: sidebarWidth, flexShrink: 0 }}>
        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab ${sidebarTab === 'explorer' ? 'active' : ''}`}
            onClick={() => setSidebarTab('explorer')}
          >
            {t('Explorer')}
          </button>
          <button
            className={`sidebar-tab ${sidebarTab === 'git' ? 'active' : ''}`}
            onClick={() => setSidebarTab('git')}
          >
            {t('Git')}
          </button>
          <button
            className={`sidebar-tab ${sidebarTab === 'search' ? 'active' : ''}`}
            onClick={() => setSidebarTab('search')}
          >
            {t('Search')}
          </button>
        </div>
        <div className={`sidebar-body ${sidebarTab === 'explorer' ? '' : 'hidden'}`}>
          <Explorer onFileSelect={handleFileSelect} onProjectChange={handleProjectChange} />
        </div>
        <div className={`sidebar-body ${sidebarTab === 'git' ? '' : 'hidden'}`}>
          <GitPanel onOpenDiff={handleOpenDiff} />
        </div>
        <div className={`sidebar-body ${sidebarTab === 'search' ? '' : 'hidden'}`}>
          <SearchPanel onOpenFile={handleOpenFileAt} />
        </div>
      </div>
      <Splitter
        orientation="vertical"
        onDelta={(dx) => setSidebarWidth(w => clamp(w + dx, 160, 600))}
      />
      <div className="main-content">
        <div className="editor-area">
          <Editor
            file={selectedFile}
            content={fileContent}
            onChange={handleContentChange}
            diff={diffView}
            onCloseDiff={() => setDiffView(null)}
            gotoLine={gotoLine}
            onExportPdf={handleExportPdf}
            onExportHtml={handleExportHtml}
          />
        </div>
        {showTerminal && (
          <Splitter
            orientation="horizontal"
            onDelta={(dy) => setTerminalHeight(h => clamp(h - dy, 100, 800))}
          />
        )}
        {/* Always mounted so it keeps receiving process/output events even
            while hidden - visibility is controlled via CSS */}
        <TerminalPanel visible={showTerminal} height={terminalHeight} />
      </div>
      <Splitter
        orientation="vertical"
        onDelta={(dx) => setChatWidth(w => clamp(w - dx, 260, 800))}
      />
      <div className="chat-panel" style={{ width: chatWidth, flexShrink: 0 }}>
        <Chat 
          key={`${settingsKey}`} 
          onOpenSettings={() => setShowSettings(true)} 
        />
      </div>
      {showSettings && <Settings onClose={() => setShowSettings(false)} onApiKeySaved={handleApiKeySaved} />}
      {showAbout && <About onClose={() => setShowAbout(false)} />}
      {toast && <div className="toast">{toast}</div>}
      {showQuickOpen && projectService.getCurrentProject() && (
        <QuickOpen
          rootPath={projectService.getCurrentProject()!.rootPath}
          recents={fileHistoryRef.current
            .map(p => p.replace(/\\/g, '/'))
            .filter(p => p.toLowerCase().startsWith(projectService.getCurrentProject()!.rootPath.replace(/\\/g, '/').toLowerCase() + '/'))
            .map(p => p.slice(projectService.getCurrentProject()!.rootPath.replace(/\\/g, '/').length + 1))}
          onSelect={handleFileSelect}
          onClose={() => setShowQuickOpen(false)}
        />
      )}
    </div>
  )
}

export default App
