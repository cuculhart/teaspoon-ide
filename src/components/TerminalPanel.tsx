import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { projectService } from '../services/projectService'
import { i18nService, useT } from '../services/i18nService'
import './TerminalPanel.css'

interface TerminalProcess {
  id: string
  command: string
  running: boolean
  exitCode: number | null
}

const MAX_OUTPUT_CHARS = 100_000

function xtermTheme() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    background: v('--bg-primary', '#1e1e1e'),
    foreground: v('--text-primary', '#cccccc'),
    cursor: v('--text-primary', '#cccccc'),
  }
}

const ProcessOutput: React.FC<{
  proc: TerminalProcess
  onKill: (id: string) => void
  getBuffer: (id: string) => string
  registerTerm: (id: string, term: Terminal | null) => void
  visible: boolean
  expanded: boolean
  onToggleExpand: (id: string) => void
}> = ({ proc, onKill, getBuffer, registerTerm, visible, expanded, onToggleExpand }) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'Consolas', 'Courier New', monospace",
      fontSize: 12,
      cursorBlink: proc.running,
      scrollback: 5000,
      theme: xtermTheme(),
    })
    const fit = new FitAddon()
    // Clickable URLs open in the system browser via the main process
    const links = new WebLinksAddon((_event, uri) => {
      window.electronAPI?.openExternal(uri)
    })
    term.loadAddon(fit)
    term.loadAddon(links)
    term.open(host)
    term.write(getBuffer(proc.id))
    termRef.current = term
    fitRef.current = fit
    registerTerm(proc.id, term)
    try {
      fit.fit()
      window.electronAPI?.resizeProcess(proc.id, term.cols, term.rows)
    } catch { /* host may be hidden */ }

    // Keystrokes go straight to the PTY - real TTY, no local echo needed
    const dataSub = term.onData((data) => {
      window.electronAPI?.sendProcessInput(proc.id, data)
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      window.electronAPI?.resizeProcess(proc.id, cols, rows)
    })
    const observer = new ResizeObserver(() => {
      try { fit.fit() } catch { /* ignore */ }
    })
    observer.observe(host)

    return () => {
      dataSub.dispose()
      resizeSub.dispose()
      observer.disconnect()
      termRef.current = null
      fitRef.current = null
      registerTerm(proc.id, null)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proc.id])

  useEffect(() => {
    if (!visible || !expanded) return
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (term) {
          window.electronAPI?.resizeProcess(proc.id, term.cols, term.rows)
          term.scrollToBottom()
        }
      } catch { }
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, expanded, proc.id])

  return (
    <div className="terminal-process">
      <div
        className={`terminal-process-header${proc.running ? '' : ' clickable'}`}
        onClick={() => !proc.running && onToggleExpand(proc.id)}
        role={proc.running ? undefined : 'button'}
        title={proc.running ? undefined : i18nService.t('Click to expand/collapse output')}
      >
        <span className="terminal-collapse">
          {proc.running ? '' : expanded ? '▾' : '▸'}
        </span>
        <span className={`terminal-status ${proc.running ? 'running' : proc.exitCode === 0 ? 'ok' : 'failed'}`}>
          {proc.running ? '●' : proc.exitCode === 0 ? '✓' : '✕'}
        </span>
        <span className="terminal-command" title={proc.command}>{proc.command}</span>
        <span className="terminal-exit-code">
          {!proc.running && proc.exitCode !== null && `${i18nService.t('exit')} ${proc.exitCode}`}
        </span>
        {proc.running && (
          <button className="terminal-kill" onClick={() => onKill(proc.id)} title={i18nService.t('Stop process')}>
            ■ Stop
          </button>
        )}
      </div>
      <div
        ref={hostRef}
        className="terminal-host"
        style={expanded ? undefined : { display: 'none' }}
      />
    </div>
  )
}

const TerminalPanel: React.FC<{ visible: boolean; height: number }> = ({ visible, height }) => {
  const t = useT()
  const [processes, setProcesses] = useState<TerminalProcess[]>([])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  // Expand/collapse overrides per process id. Default: running processes
  // and the newest process are expanded; older finished ones collapse so
  // stale FAILED output doesn't dominate the panel.
  const [expandOverrides, setExpandOverrides] = useState<Map<string, boolean>>(new Map())
  const toggleExpand = (id: string, expanded: boolean) => {
    setExpandOverrides(prev => new Map(prev).set(id, !expanded))
  }

  // Raw PTY output per process - source of truth for xterm replay on remount
  const outputBuffers = useRef(new Map<string, string>())
  const terms = useRef(new Map<string, Terminal>())
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const processCountRef = useRef(0)

  const cwd = projectService.getCurrentProject()?.rootPath

  const getBuffer = useCallback((id: string) => outputBuffers.current.get(id) || '', [])
  const registerTerm = useCallback((id: string, term: Terminal | null) => {
    if (term) terms.current.set(id, term)
    else terms.current.delete(id)
  }, [])
  const scrollBodyToBottom = useCallback(() => {
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [])
  const handleBodyScroll = () => {
    const body = bodyRef.current
    if (!body) return
    stickToBottomRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24
  }

  useEffect(() => {
    const api = window.electronAPI
    if (!api) return
    const offOutput = api.onTerminalOutput(({ id, data }) => {
      outputBuffers.current.set(id, ((outputBuffers.current.get(id) || '') + data).slice(-MAX_OUTPUT_CHARS))
      terms.current.get(id)?.write(data, () => {
        if (stickToBottomRef.current) {
          requestAnimationFrame(() => {
            if (stickToBottomRef.current) scrollBodyToBottom()
          })
        }
      })
    })
    const offExit = api.onTerminalExit(({ id, code }) => {
      setProcesses(prev => prev.map(p =>
        p.id === id ? { ...p, running: false, exitCode: code } : p
      ))
    })
    // Processes started by the AI (RUN_COMMAND) appear here too
    const handleSpawned = (event: Event) => {
      const { id, command } = (event as CustomEvent).detail
      setProcesses(prev => {
        if (prev.some(p => p.id === id)) return prev
        outputBuffers.current.set(id, `$ ${command}\r\n`)
        return [...prev, { id, command, running: true, exitCode: null }]
      })
    }
    window.addEventListener('terminal-spawned', handleSpawned)
    return () => {
      offOutput()
      offExit()
      window.removeEventListener('terminal-spawned', handleSpawned)
    }
  }, [scrollBodyToBottom])

  useEffect(() => {
    const grew = processes.length > processCountRef.current
    processCountRef.current = processes.length
    if (grew) stickToBottomRef.current = true
    if (stickToBottomRef.current) {
      requestAnimationFrame(() => {
        if (stickToBottomRef.current) scrollBodyToBottom()
      })
    }
  }, [processes, scrollBodyToBottom])

  useEffect(() => {
    if (!visible) return
    stickToBottomRef.current = true
    requestAnimationFrame(() => {
      scrollBodyToBottom()
      terms.current.forEach(term => term.scrollToBottom())
    })
  }, [visible, scrollBodyToBottom])

  const runCommand = async () => {
    const command = input.trim()
    if (!command || !cwd || !window.electronAPI) return

    const result = await window.electronAPI.runCommand(cwd, command)
    if (result.success && result.id) {
      outputBuffers.current.set(result.id, `$ ${command}\r\n`)
      setProcesses(prev => [...prev, {
        id: result.id!,
        command,
        running: true,
        exitCode: null,
      }])
      setHistory(prev => [...prev, command])
    } else {
      const id = `failed-${Date.now()}`
      outputBuffers.current.set(id, `$ ${command}\r\n${result.error || i18nService.t('Failed to start process')}\r\n`)
      setProcesses(prev => [...prev, {
        id,
        command,
        running: false,
        exitCode: 1,
      }])
    }
    setInput('')
    setHistoryIndex(-1)
  }

  const handleKill = (id: string) => {
    window.electronAPI?.killProcess(id)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      runCommand()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(next)
      setInput(history[next])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex < 0) return
      const next = historyIndex + 1
      if (next >= history.length) {
        setHistoryIndex(-1)
        setInput('')
      } else {
        setHistoryIndex(next)
        setInput(history[next])
      }
    }
  }

  const clearFinished = () => {
    const removed = processes.filter(p => !p.running)
    const removedIds = new Set(removed.map(p => p.id))
    removed.forEach(p => outputBuffers.current.delete(p.id))
    setExpandOverrides(prev => new Map([...prev].filter(([id]) => !removedIds.has(id))))
    setProcesses(prev => prev.filter(p => p.running))
  }

  return (
    <div className="terminal-panel" style={{ display: visible ? 'flex' : 'none', height }}>
      <div className="terminal-header">
        <span className="terminal-title">{t('Terminal')}</span>
        <span className="terminal-cwd" title={cwd || t('No project open')}>
          {cwd ? cwd.replace(/\\/g, '/') : ''}
        </span>
        <button className="terminal-clear" onClick={clearFinished} title={t('Clear finished processes')}>
          {t('Clear')}
        </button>
      </div>

      <div className="terminal-body" ref={bodyRef} onScroll={handleBodyScroll}>
        {processes.length === 0 && (
          <p className="terminal-hint">
            {cwd
              ? t('Run a command in the project root (e.g. npm install, npm start, docker compose up)')
              : t('Open a project to run commands')}
          </p>
        )}
        {processes.map((proc, i) => {
          const expanded = expandOverrides.get(proc.id) ?? (proc.running || i === processes.length - 1)
          return (
            <ProcessOutput
              key={proc.id}
              proc={proc}
              onKill={handleKill}
              getBuffer={getBuffer}
              registerTerm={registerTerm}
              visible={visible}
              expanded={expanded}
              onToggleExpand={(id) => toggleExpand(id, expanded)}
            />
          )
        })}
      </div>

      <div className="terminal-input-row">
        <span className="terminal-prompt">&gt;</span>
        <input
          className="terminal-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={cwd ? t('Type a command...') : t('Open a project first')}
          disabled={!cwd}
          spellCheck={false}
        />
      </div>
    </div>
  )
}

export default TerminalPanel
