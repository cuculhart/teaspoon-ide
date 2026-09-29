export interface ElectronAPI {
  readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
  writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
  readDirectory: (dirPath: string) => Promise<{ success: boolean; items?: Array<{ name: string; path: string; isDirectory: boolean }>; error?: string }>
  createDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>
  deleteFile: (rootPath: string, filePath: string) => Promise<{ success: boolean; error?: string }>
  selectFolder: () => Promise<{ success: boolean; folderPath?: string; canceled?: boolean; error?: string }>
  searchFiles: (rootPath: string, pattern: string) => Promise<{ success: boolean; matches?: Array<{ file: string; line: number; text: string }>; truncated?: boolean; searchedFiles?: number; error?: string }>
  findFiles: (rootPath: string, pattern: string, maxResults?: number) => Promise<{ success: boolean; files?: string[]; truncated?: boolean; totalFiles?: number; error?: string }>
  watchProject: (rootPath: string) => Promise<{ success: boolean; error?: string }>
  unwatchProject: () => Promise<{ success: boolean; error?: string }>
  onProjectFsChanged: (callback: (payload: { rootPath: string }) => void) => () => void
  gitStatus: (repoPath: string) => Promise<{ success: boolean; status?: any; hasCommits?: boolean; error?: string }>
  gitInit: (repoPath: string) => Promise<{ success: boolean; error?: string }>
  gitAdd: (repoPath: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
  gitCommit: (repoPath: string, message: string) => Promise<{ success: boolean; commit?: any; error?: string }>
  gitPush: (repoPath: string) => Promise<{ success: boolean; error?: string }>
  gitPull: (repoPath: string) => Promise<{ success: boolean; error?: string }>
  gitClone: (repoUrl: string, targetPath: string) => Promise<{ success: boolean; error?: string }>
  gitGetRemotes: (repoPath: string) => Promise<{ success: boolean; remotes?: Array<{ name: string; refs?: { fetch?: string; push?: string } }>; error?: string }>
  gitSetRemote: (repoPath: string, name: string, repoUrl: string) => Promise<{ success: boolean; error?: string }>
  gitPushUpstream: (repoPath: string, remote: string, branch: string) => Promise<{ success: boolean; error?: string }>
  gitGetConfig: (repoPath: string, scope: 'local' | 'global') => Promise<{ success: boolean; config?: { name: string; email: string }; error?: string }>
  gitSetConfig: (repoPath: string, scope: 'local' | 'global', values: { name: string; email: string }) => Promise<{ success: boolean; error?: string }>
  gitFileAtHead: (repoPath: string, filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
  gitDiff: (repoPath: string) => Promise<{ success: boolean; diff?: string; error?: string }>
  runCommand: (cwd: string, command: string) => Promise<{ success: boolean; id?: string; error?: string }>
  killProcess: (id: string) => Promise<{ success: boolean; error?: string }>
  sendProcessInput: (id: string, data: string) => Promise<{ success: boolean; error?: string }>
  resizeProcess: (id: string, cols: number, rows: number) => Promise<{ success: boolean; error?: string }>
  onTerminalOutput: (callback: (payload: { id: string; data: string; stream: 'stdout' | 'stderr' }) => void) => () => void
  onTerminalExit: (callback: (payload: { id: string; code: number | null }) => void) => () => void
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
  openPath: (rootPath: string, target: string) => Promise<{ success: boolean; error?: string }>
  exportPdf: (html: string, suggestedName?: string) => Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }>
  exportHtml: (html: string, suggestedName?: string) => Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }>
  editUndo: () => Promise<{ success: boolean }>
  editRedo: () => Promise<{ success: boolean }>
  setThemeSource: (theme: 'system' | 'dark' | 'light') => Promise<{ success: boolean; error?: string }>
  onMenuAction: (callback: (action: string) => void) => () => void
  takePendingFolder: () => Promise<string | null>
  onOpenProjectPath: (callback: (path: string) => void) => () => void
  getPathForFile: (file: File) => string
  listLanguages: () => Promise<{ success: boolean; languages?: Array<{ code: string; label: string }>; error?: string }>
  loadLanguage: (code: string) => Promise<{ success: boolean; dict?: Record<string, string>; error?: string }>
  platform: string
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
