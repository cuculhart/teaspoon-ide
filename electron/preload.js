const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Secrets (API keys) - encrypted via safeStorage in the main process.
  // Sync IPC so configService can stay synchronous.
  secretsGet: (key) => ipcRenderer.sendSync('secrets-get', key),
  secretsSet: (key, value) => ipcRenderer.sendSync('secrets-set', key, value),
  secretsRemove: (key) => ipcRenderer.sendSync('secrets-remove', key),

  // File system operations
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  createDirectory: (dirPath) => ipcRenderer.invoke('create-directory', dirPath),
  deleteFile: (rootPath, filePath) => ipcRenderer.invoke('delete-file', rootPath, filePath),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  registerProjectRoot: (dirPath) => ipcRenderer.invoke('register-project-root', dirPath),
  getDocumentsPath: () => ipcRenderer.invoke('documents-path'),

  // Chat history (scoped to userData/chat-history by the main process)
  chatHistoryList: () => ipcRenderer.invoke('chat-history-list'),
  chatHistoryGet: (id) => ipcRenderer.invoke('chat-history-get', id),
  chatHistoryPut: (id, json) => ipcRenderer.invoke('chat-history-put', id, json),
  chatHistoryDelete: (id) => ipcRenderer.invoke('chat-history-delete', id),
  chatHistoryClear: () => ipcRenderer.invoke('chat-history-clear'),
  searchFiles: (rootPath, pattern) => ipcRenderer.invoke('search-files', rootPath, pattern),
  findFiles: (rootPath, pattern, maxResults) => ipcRenderer.invoke('find-files', rootPath, pattern, maxResults),
  watchProject: (rootPath) => ipcRenderer.invoke('watch-project', rootPath),
  unwatchProject: () => ipcRenderer.invoke('unwatch-project'),
  onProjectFsChanged: (callback) => {
    const listener = (event, payload) => callback(payload)
    ipcRenderer.on('project-fs-changed', listener)
    return () => ipcRenderer.removeListener('project-fs-changed', listener)
  },
  
  // Git operations
  gitStatus: (repoPath) => ipcRenderer.invoke('git-status', repoPath),
  gitInit: (repoPath) => ipcRenderer.invoke('git-init', repoPath),
  gitAdd: (repoPath, paths) => ipcRenderer.invoke('git-add', repoPath, paths),
  gitCommit: (repoPath, message) => ipcRenderer.invoke('git-commit', repoPath, message),
  gitPush: (repoPath) => ipcRenderer.invoke('git-push', repoPath),
  gitPull: (repoPath) => ipcRenderer.invoke('git-pull', repoPath),
  gitClone: (repoUrl, targetPath) => ipcRenderer.invoke('git-clone', repoUrl, targetPath),
  gitGetRemotes: (repoPath) => ipcRenderer.invoke('git-remotes', repoPath),
  gitSetRemote: (repoPath, name, repoUrl) => ipcRenderer.invoke('git-set-remote', repoPath, name, repoUrl),
  gitPushUpstream: (repoPath, remote, branch) => ipcRenderer.invoke('git-push-upstream', repoPath, remote, branch),
  gitGetConfig: (repoPath, scope) => ipcRenderer.invoke('git-config-get', repoPath, scope),
  gitSetConfig: (repoPath, scope, values) => ipcRenderer.invoke('git-config-set', repoPath, scope, values),
  gitFileAtHead: (repoPath, filePath) => ipcRenderer.invoke('git-file-at-head', repoPath, filePath),
  gitDiff: (repoPath) => ipcRenderer.invoke('git-diff', repoPath),
  
  // Terminal
  runCommand: (cwd, command) => ipcRenderer.invoke('terminal-run', cwd, command),
  killProcess: (id) => ipcRenderer.invoke('terminal-kill', id),
  sendProcessInput: (id, data) => ipcRenderer.invoke('terminal-input', id, data),
  resizeProcess: (id, cols, rows) => ipcRenderer.invoke('terminal-resize', id, cols, rows),
  onTerminalOutput: (callback) => {
    const listener = (event, payload) => callback(payload)
    ipcRenderer.on('terminal-output', listener)
    return () => ipcRenderer.removeListener('terminal-output', listener)
  },
  onTerminalExit: (callback) => {
    const listener = (event, payload) => callback(payload)
    ipcRenderer.on('terminal-exit', listener)
    return () => ipcRenderer.removeListener('terminal-exit', listener)
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (rootPath, target) => ipcRenderer.invoke('open-path', rootPath, target),
  exportPdf: (html, suggestedName) => ipcRenderer.invoke('export-pdf', html, suggestedName),
  exportHtml: (html, suggestedName) => ipcRenderer.invoke('export-html', html, suggestedName),

  // Native edit fallback
  editUndo: () => ipcRenderer.invoke('edit-undo'),
  editRedo: () => ipcRenderer.invoke('edit-redo'),

  // Appearance
  setThemeSource: (theme) => ipcRenderer.invoke('set-theme-source', theme),

  // Menu events from the main process
  onMenuAction: (callback) => {
    const listener = (event, action) => callback(action)
    ipcRenderer.on('menu-action', listener)
    return () => ipcRenderer.removeListener('menu-action', listener)
  },

  // Open a project from a folder path (CLI arg / folder dropped on exe)
  takePendingFolder: () => ipcRenderer.invoke('teaspoon:take-pending-folder'),
  onOpenProjectPath: (callback) => {
    const listener = (event, p) => callback(p)
    ipcRenderer.on('open-project-path', listener)
    return () => ipcRenderer.removeListener('open-project-path', listener)
  },
  // Real path of a File dropped onto the window (File.path was removed
  // in newer Electron - webUtils is the supported API)
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Localization
  listLanguages: () => ipcRenderer.invoke('list-languages'),
  loadLanguage: (code) => ipcRenderer.invoke('load-language', code),
  // Tells the main process which language to use for menus/dialogs
  setLanguage: (code) => ipcRenderer.send('set-language', code),

  // Platform info
  platform: process.platform,
})
