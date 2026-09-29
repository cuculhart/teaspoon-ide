const fs = require('fs/promises')
const { watch: fsWatch } = require('fs')
const path = require('path')
const simpleGit = require('simple-git')
const { spawn } = require('child_process')
const pty = require('node-pty')
const { ipcMain, dialog, nativeTheme, shell, BrowserWindow, app } = require('electron')

// Running terminal processes, keyed by a small app-level id
const runningProcesses = new Map()
let nextProcessId = 1

// Project folder watchers, keyed by webContents id
const projectWatchers = new Map()
const watcherHookedSenders = new Set()
const WATCH_DEBOUNCE_MS = 300
const MAX_WATCH_DIRS = 2000

function setupIpcHandlers() {
  // File system operations
  ipcMain.handle('read-file', async (event, filePath) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('write-file', async (event, filePath, content) => {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content, 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Delete a file, restricted to inside the given project root.
  // Used by the AI-edit rollback feature (files the AI created).
  ipcMain.handle('delete-file', async (event, rootPath, filePath) => {
    try {
      const resolvedRoot = path.resolve(rootPath).toLowerCase()
      const resolvedFile = path.resolve(filePath).toLowerCase()
      if (!resolvedFile.startsWith(resolvedRoot + path.sep)) {
        return { success: false, error: 'Path is outside the project root' }
      }
      await fs.unlink(filePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('create-directory', async (event, dirPath) => {
    try {
      await fs.mkdir(dirPath, { recursive: true })
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('read-directory', async (event, dirPath) => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const items = entries.map(entry => ({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
      }))
      return { success: true, items }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Directories skipped during project-wide searches
  const IGNORED_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'build',
    '.next', '.nuxt', 'coverage', '.cache', '.idea', '.vscode',
    'target', 'vendor', '__pycache__', '.venv', 'venv',
  ])
  const MAX_WALK_FILES = 20000
  const MAX_SEARCH_FILE_SIZE = 512 * 1024
  const MAX_SEARCH_MATCHES = 100
  const MAX_FIND_RESULTS = 300

  async function walkFiles(dir, base, results) {
    if (results.length >= MAX_WALK_FILES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= MAX_WALK_FILES) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walkFiles(full, base, results)
        }
      } else if (entry.isFile()) {
        results.push(path.relative(base, full))
      }
    }
  }

  // Content search across the project (AI "grep" tool)
  ipcMain.handle('search-files', async (event, rootPath, pattern) => {
    try {
      const files = []
      await walkFiles(rootPath, rootPath, files)

      let regex = null
      try {
        regex = new RegExp(pattern, 'i')
      } catch { /* fall back to case-insensitive substring */ }

      const matches = []
      for (const rel of files) {
        if (matches.length >= MAX_SEARCH_MATCHES) break
        const full = path.join(rootPath, rel)
        try {
          const stat = await fs.stat(full)
          if (stat.size > MAX_SEARCH_FILE_SIZE) continue
          const content = await fs.readFile(full, 'utf-8')
          if (content.includes('\0')) continue // binary file
          const lines = content.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            const hit = regex
              ? regex.test(lines[i])
              : lines[i].toLowerCase().includes(pattern.toLowerCase())
            if (hit) {
              matches.push({ file: rel.replace(/\\/g, '/'), line: i + 1, text: lines[i].slice(0, 300) })
              if (matches.length >= MAX_SEARCH_MATCHES) break
            }
          }
        } catch { /* unreadable file - skip */ }
      }
      return {
        success: true,
        matches,
        truncated: matches.length >= MAX_SEARCH_MATCHES,
        searchedFiles: files.length,
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Path search across the project (AI "find files" tool / Quick Open)
  ipcMain.handle('find-files', async (event, rootPath, pattern, maxResults) => {
    try {
      const files = []
      await walkFiles(rootPath, rootPath, files)
      const limit = typeof maxResults === 'number' && maxResults > 0
        ? maxResults
        : MAX_FIND_RESULTS

      let matcher
      if (/[*?]/.test(pattern)) {
        // Glob: * = any chars, ? = one char (matched against path and basename)
        const src = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.')
        const re = new RegExp(src, 'i')
        matcher = (f) => re.test(f.replace(/\\/g, '/')) || re.test(path.basename(f))
      } else {
        const needle = pattern.toLowerCase()
        matcher = (f) => f.toLowerCase().includes(needle)
      }

      const results = files.filter(matcher).slice(0, limit)
        .map(f => f.replace(/\\/g, '/'))
      return {
        success: true,
        files: results,
        truncated: files.filter(matcher).length > limit,
        totalFiles: files.length,
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Watch the project folder so the Explorer stays in sync with changes
  // made outside the app (external editors, Windows Explorer, terminal,
  // git checkout, ...). fs.watch with recursive:true works on Windows
  // and macOS; elsewhere each directory is watched individually.
  function stopProjectWatch(webContentsId) {
    const state = projectWatchers.get(webContentsId)
    if (!state) return
    projectWatchers.delete(webContentsId)
    if (state.timer) clearTimeout(state.timer)
    for (const w of state.watchers.values()) {
      try { w.close() } catch { /* already closed */ }
    }
  }

  ipcMain.handle('watch-project', async (event, rootPath) => {
    const sender = event.sender
    stopProjectWatch(sender.id)

    let resolved
    try {
      resolved = path.resolve(String(rootPath))
      const stat = await fs.stat(resolved)
      if (!stat.isDirectory()) return { success: false, error: 'Not a directory' }
    } catch (error) {
      return { success: false, error: error.message }
    }

    const state = { watchers: new Map(), timer: null, hadRename: false, syncDirs: null }
    projectWatchers.set(sender.id, state)

    const notify = (isRename) => {
      state.hadRename = state.hadRename || isRename
      if (state.timer) clearTimeout(state.timer)
      state.timer = setTimeout(() => {
        state.timer = null
        const hadRename = state.hadRename
        state.hadRename = false
        // The directory set may have changed - pick up new dirs
        if (hadRename && state.syncDirs) state.syncDirs()
        if (!sender.isDestroyed()) sender.send('project-fs-changed', { rootPath: resolved })
      }, WATCH_DEBOUNCE_MS)
    }

    // Changes inside ignored dirs (node_modules, .git, dist, ...) are not
    // reported - same policy as project-wide searches. Only the first
    // path segment is checked, so events deeper in the tree still fire.
    const isIgnoredPath = (rel) => IGNORED_DIRS.has(String(rel || '').split(/[\\/]/)[0])

    try {
      const watcher = fsWatch(resolved, { recursive: true }, (eventType, filename) => {
        if (!isIgnoredPath(filename)) notify(eventType === 'rename')
      })
      watcher.on('error', () => {})
      state.watchers.set(resolved, watcher)
    } catch {
      // No recursive watch on this platform (Linux): watch each dir
      const attach = (dir) => {
        if (state.watchers.has(dir)) return
        try {
          const w = fsWatch(dir, (eventType) => notify(eventType === 'rename'))
          w.on('error', () => {})
          state.watchers.set(dir, w)
        } catch { /* unreadable dir */ }
      }
      const collectDirs = async (dir, out) => {
        let entries
        try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          if (out.size >= MAX_WATCH_DIRS) return
          if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            const full = path.join(dir, entry.name)
            out.add(full)
            await collectDirs(full, out)
          }
        }
      }
      state.syncDirs = async () => {
        const next = new Set([resolved])
        await collectDirs(resolved, next)
        for (const [dir, w] of state.watchers) {
          if (!next.has(dir)) {
            try { w.close() } catch { /* already closed */ }
            state.watchers.delete(dir)
          }
        }
        for (const dir of next) attach(dir)
      }
      await state.syncDirs()
    }

    if (!watcherHookedSenders.has(sender.id)) {
      watcherHookedSenders.add(sender.id)
      sender.once('destroyed', () => {
        watcherHookedSenders.delete(sender.id)
        stopProjectWatch(sender.id)
      })
    }
    return { success: true }
  })

  ipcMain.handle('unwatch-project', (event) => {
    stopProjectWatch(event.sender.id)
    return { success: true }
  })

  ipcMain.handle('select-folder', async (event) => {
    try {
      const result = await dialog.showOpenDialog(event.sender.getOwnerBrowserWindow(), {
        properties: ['openDirectory'],
        title: 'Select Project Folder',
        buttonLabel: 'Select Folder',
        defaultPath: process.cwd()
      })
      
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      
      return { success: true, folderPath: result.filePaths[0] }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Native edit fallback for inputs outside Monaco (e.g. chat textarea)
  ipcMain.handle('edit-undo', (event) => {
    event.sender.undo()
    return { success: true }
  })

  ipcMain.handle('edit-redo', (event) => {
    event.sender.redo()
    return { success: true }
  })

  // Terminal: run a command inside a real PTY (node-pty / ConPTY on
  // Windows). Interactive CLI programs see a genuine console, so
  // prompts, colors and keyboard input all work as expected.
  // Long-running processes (npm start, docker, ...) stay in
  // runningProcesses until they exit or are killed.
  ipcMain.handle('terminal-run', (event, cwd, command) => {
    try {
      const id = `proc-${nextProcessId++}`
      const sender = event.sender
      const send = (channel, payload) => {
        if (!sender.isDestroyed()) sender.send(channel, payload)
      }

      const isWin = process.platform === 'win32'
      const file = isWin ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh')
      const args = isWin ? ['/c', command] : ['-c', command]

      const proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cwd,
        env: process.env,
        cols: 80,
        rows: 24,
        useConpty: isWin,
      })
      runningProcesses.set(id, proc)

      proc.onData((data) => {
        send('terminal-output', { id, data, stream: 'stdout' })
      })
      proc.onExit(({ exitCode }) => {
        runningProcesses.delete(id)
        send('terminal-exit', { id, code: exitCode })
      })

      return { success: true, id }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('terminal-kill', (event, id) => {
    const proc = runningProcesses.get(id)
    if (!proc) return { success: false, error: 'Process not found' }
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree first (npm/node grandchildren of cmd.exe)
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: false })
      }
      proc.kill()
      runningProcesses.delete(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Send input to a running PTY (interactive CLI apps, REPLs, ...)
  ipcMain.handle('terminal-input', (event, id, data) => {
    const proc = runningProcesses.get(id)
    if (!proc) {
      return { success: false, error: 'Process not found' }
    }
    try {
      proc.write(data)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Resize the PTY to match the xterm.js viewport
  ipcMain.handle('terminal-resize', (event, id, cols, rows) => {
    const proc = runningProcesses.get(id)
    if (!proc) return { success: false, error: 'Process not found' }
    try {
      proc.resize(cols, rows)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Save an HTML document to disk (Export Markdown to HTML)
  ipcMain.handle('export-html', async (event, html, suggestedName) => {
    try {
      const owner = event.sender.getOwnerBrowserWindow()
      const result = await dialog.showSaveDialog(owner, {
        title: 'Export to HTML',
        defaultPath: suggestedName || 'document.html',
        filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      })
      if (result.canceled || !result.filePath) {
        return { success: true, canceled: true }
      }
      await fs.writeFile(result.filePath, html, 'utf-8')
      return { success: true, filePath: result.filePath }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Render an HTML document to PDF via a hidden window + printToPDF.
  // Used by "Export Markdown to PDF" - the renderer sends a complete
  // self-contained HTML document (styles inlined).
  ipcMain.handle('export-pdf', async (event, html, suggestedName) => {
    let win = null
    try {
      win = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      })
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
      })
      win.destroy()
      win = null

      const owner = event.sender.getOwnerBrowserWindow()
      const result = await dialog.showSaveDialog(owner, {
        title: 'Export to PDF',
        defaultPath: suggestedName || 'document.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (result.canceled || !result.filePath) {
        return { success: true, canceled: true }
      }
      await fs.writeFile(result.filePath, pdf)
      return { success: true, filePath: result.filePath }
    } catch (error) {
      if (win) win.destroy()
      return { success: false, error: error.message }
    }
  })

  // Language files live in <resources>/lang in packaged builds and in
  // <projectRoot>/lang during development, so users can add translations
  // without rebuilding.
  function langDir() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'lang')
      : path.join(app.getAppPath(), 'lang')
  }

  ipcMain.handle('list-languages', async () => {
    const langs = [{ code: 'en', label: 'English' }] // source language is built in
    try {
      const entries = await fs.readdir(langDir())
      for (const name of entries) {
        if (!name.endsWith('.json') || name === 'en.json') continue
        const code = name.slice(0, -5)
        let label = code
        try {
          const raw = await fs.readFile(path.join(langDir(), name), 'utf-8')
          const parsed = JSON.parse(raw)
          if (parsed._name) label = parsed._name
        } catch { /* unreadable file - fall back to code as label */ }
        langs.push({ code, label })
      }
    } catch { /* no lang dir - English only */ }
    return { success: true, languages: langs }
  })

  ipcMain.handle('load-language', async (event, code) => {
    try {
      if (!/^[a-zA-Z0-9_-]+$/.test(code)) {
        return { success: false, error: 'Invalid language code' }
      }
      const raw = await fs.readFile(path.join(langDir(), `${code}.json`), 'utf-8')
      return { success: true, dict: JSON.parse(raw) }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Open a URL in the system browser (localhost:3000 etc. from dev servers)
  ipcMain.handle('open-external', async (event, url) => {
    if (!/^https?:\/\//i.test(url)) {
      return { success: false, error: 'Only http(s) URLs are allowed' }
    }
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Open a file with its default app (index.html -> default browser).
  // Confined to the project root, same policy as file writes.
  ipcMain.handle('open-path', async (event, rootPath, target) => {
    try {
      const base = path.resolve(rootPath)
      const resolved = path.resolve(base, target)
      if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        return { success: false, error: 'Path is outside the project root' }
      }
      const err = await shell.openPath(resolved)
      return err ? { success: false, error: err } : { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Appearance
  ipcMain.handle('set-theme-source', (event, theme) => {
    if (theme === 'system' || theme === 'dark' || theme === 'light') {
      nativeTheme.themeSource = theme
      return { success: true }
    }
    return { success: false, error: `Invalid theme: ${theme}` }
  })

  // Git operations
  // simple-git results may contain non-cloneable values - serialize them
  // before crossing the IPC boundary.
  const cloneable = (value) => JSON.parse(JSON.stringify(value))

  ipcMain.handle('git-status', async (event, repoPath) => {
    try {
      const git = simpleGit(repoPath)
      const status = await git.status()
      const hasCommits = await git.revparse(['--verify', 'HEAD'])
        .then(() => true)
        .catch(() => false)
      return { success: true, status: cloneable(status), hasCommits }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-init', async (event, repoPath) => {
    try {
      const git = simpleGit(repoPath)
      await git.init()
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-add', async (event, repoPath, paths) => {
    try {
      const git = simpleGit(repoPath)
      await git.add(paths)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-commit', async (event, repoPath, message) => {
    try {
      const git = simpleGit(repoPath)
      const result = await git.commit(message)
      return { success: true, commit: cloneable(result) }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  const validRemoteName = (name) => /^[A-Za-z0-9._-]+$/.test(name || '')
  const validGitArg = (value) => typeof value === 'string' && value.trim() && !value.startsWith('-')
  const validBranchName = (name) => validGitArg(name) && !/\s/.test(name)

  ipcMain.handle('git-push', async (event, repoPath) => {
    try {
      const git = simpleGit(repoPath)
      const status = await git.status()
      if (status.tracking) {
        await git.push()
        return { success: true }
      }
      const branch = String(status.current || '').trim()
      if (!validBranchName(branch)) {
        return { success: false, error: 'No current branch to push' }
      }
      const remotes = await git.getRemotes(false)
      const remote = remotes.find(item => item.name === 'origin')
        || (remotes.length === 1 ? remotes[0] : null)
      if (!remote || !validRemoteName(remote.name)) {
        return { success: false, error: 'No upstream remote configured. Use Remote Setup.' }
      }
      await git.raw(['push', '--set-upstream', remote.name, branch])
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-pull', async (event, repoPath) => {
    try {
      const git = simpleGit(repoPath)
      await git.pull()
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-clone', async (event, repoUrl, targetPath) => {
    try {
      const url = String(repoUrl || '').trim()
      if (!validGitArg(url)) return { success: false, error: 'Invalid repository URL' }
      if (!validGitArg(targetPath)) return { success: false, error: 'Invalid target path' }
      await simpleGit().clone(url, targetPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-remotes', async (event, repoPath) => {
    try {
      const remotes = await simpleGit(repoPath).getRemotes(true)
      return { success: true, remotes: cloneable(remotes) }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-set-remote', async (event, repoPath, name, repoUrl) => {
    try {
      const remote = String(name || '').trim()
      const url = String(repoUrl || '').trim()
      if (!validRemoteName(remote)) return { success: false, error: 'Invalid remote name' }
      if (!validGitArg(url)) return { success: false, error: 'Invalid repository URL' }
      const git = simpleGit(repoPath)
      const remotes = await git.getRemotes(false)
      if (remotes.some(item => item.name === remote)) {
        await git.remote(['set-url', remote, url])
      } else {
        await git.addRemote(remote, url)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-push-upstream', async (event, repoPath, remote, branch) => {
    try {
      const remoteName = String(remote || '').trim()
      const branchName = String(branch || '').trim()
      if (!validRemoteName(remoteName)) return { success: false, error: 'Invalid remote name' }
      if (!validBranchName(branchName)) return { success: false, error: 'Invalid branch name' }
      await simpleGit(repoPath).raw(['push', '--set-upstream', remoteName, branchName])
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-config-get', async (event, repoPath, scope) => {
    try {
      if (scope !== 'local' && scope !== 'global') {
        return { success: false, error: 'Invalid config scope' }
      }
      const git = simpleGit(repoPath)
      const readKey = async (key) => {
        try {
          const result = await git.getConfig(key, scope)
          return result.value || ''
        } catch {
          return ''
        }
      }
      return {
        success: true,
        config: {
          name: await readKey('user.name'),
          email: await readKey('user.email'),
        },
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-config-set', async (event, repoPath, scope, values) => {
    try {
      if (scope !== 'local' && scope !== 'global') {
        return { success: false, error: 'Invalid config scope' }
      }
      const git = simpleGit(repoPath)
      const name = String(values?.name || '').trim()
      const email = String(values?.email || '').trim()
      if (!name) return { success: false, error: 'user.name is required' }
      if (!email) return { success: false, error: 'user.email is required' }
      await git.addConfig('user.name', name, false, scope)
      await git.addConfig('user.email', email, false, scope)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // File content at HEAD - used as the "original" side of the diff view
  ipcMain.handle('git-file-at-head', async (event, repoPath, filePath) => {
    try {
      const git = simpleGit(repoPath)
      const rel = path.relative(repoPath, filePath).replace(/\\/g, '/')
      const content = await git.show([`HEAD:${rel}`])
      return { success: true, content }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('git-diff', async (event, repoPath) => {
    try {
      const git = simpleGit(repoPath)
      const diff = await git.diff()
      return { success: true, diff }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
}

module.exports = { setupIpcHandlers }
