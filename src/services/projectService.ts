import { Project, ProjectFile } from '../types/project'
import { contextService } from './contextService'
import { configService } from './configService'

class ProjectService {
  private currentProject: Project | null = null
  private openFiles: Map<string, string> = new Map()
  private selectedFiles: Set<string> = new Set()
  private listeners = new Set<() => void>()

  // Subscribe to open/close transitions. Returns an unsubscribe fn.
  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private notify(): void {
    this.listeners.forEach(cb => cb())
  }

  // Normalize path for cache keys so "C:/a/b" and "C:\a\b" match
  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase()
  }

  getCurrentProject(): Project | null {
    return this.currentProject
  }

  async openProject(rootPath: string): Promise<Project> {
    if (window.electronAPI) {
      // Grant main-process file access to this root before listing it -
      // opens that skip the folder dialog (recent list, drop, CLI) land
      // here without a native-consent path.
      await window.electronAPI.registerProjectRoot?.(rootPath)
      const result = await window.electronAPI.readDirectory(rootPath)
      if (result.success && result.items) {
        const projectName = rootPath.split(/[/\\]/).pop() || rootPath
        const files: ProjectFile[] = result.items.map(item => ({
          path: item.path,
          name: item.name,
          isDirectory: item.isDirectory,
        }))

        this.currentProject = {
          rootPath,
          name: projectName,
          files,
          isOpen: true,
        }

        this.notify()
        return this.currentProject
      }
    }
    throw new Error('Failed to open project')
  }

  closeProject(): void {
    this.currentProject = null
    this.openFiles.clear()
    this.selectedFiles.clear()
    this.notify()
  }

  async readFile(filePath: string): Promise<string> {
    const key = this.normalizePath(filePath)
    if (this.openFiles.has(key)) {
      return this.openFiles.get(key)!
    }

    if (window.electronAPI) {
      const result = await window.electronAPI.readFile(filePath)
      if (result.success && result.content) {
        this.openFiles.set(key, result.content)
        return result.content
      }
    }
    throw new Error(`Failed to read file: ${filePath}`)
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (window.electronAPI) {
      const result = await window.electronAPI.writeFile(filePath, content)
      if (result.success) {
        this.openFiles.set(this.normalizePath(filePath), content)
        return
      }
    }
    throw new Error(`Failed to write file: ${filePath}`)
  }

  invalidateFile(filePath: string): void {
    this.openFiles.delete(this.normalizePath(filePath))
  }

  selectFile(filePath: string): void {
    this.selectedFiles.add(filePath)
  }

  deselectFile(filePath: string): void {
    this.selectedFiles.delete(filePath)
  }

  getSelectedFiles(): string[] {
    return Array.from(this.selectedFiles)
  }

  getOpenFiles(): Map<string, string> {
    return new Map(this.openFiles)
  }

  // LLM context uses project-relative paths - absolute paths would leak the
  // OS user name (e.g. C:\Users\<name>\...) to cloud providers.
  private relativePath(absPath: string): string {
    const root = this.currentProject?.rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const norm = absPath.replace(/\\/g, '/')
    return root && norm.toLowerCase().startsWith(root.toLowerCase() + '/')
      ? norm.slice(root.length + 1)
      : norm
  }

  async getProjectContext(): Promise<string> {
    if (!this.currentProject) {
      return 'No project is currently open.'
    }

    // If user has manually selected files, use those
    if (this.selectedFiles.size > 0) {
      let context = `Project: ${this.currentProject.name}\n`
      context += `Selected Files: ${this.selectedFiles.size}\n\n`

      for (const filePath of this.selectedFiles) {
        try {
          const content = await this.readFile(filePath)
          context += `\n--- ${this.relativePath(filePath)} ---\n${content}\n`
        } catch (error) {
          context += `\n--- ${this.relativePath(filePath)} ---\nError reading file\n`
        }
      }

      return context
    }

    // 'full' mode (Settings): read scored file contents up to the token
    // budget. Expensive - kept for small projects / debugging.
    if (configService.getContextMode() === 'full') {
      try {
        const allFiles = await this.getAllFiles()
        const root = this.currentProject.rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
        return await contextService.buildProjectContext(
          allFiles.map(f => this.relativePath(f.path)),
          (p) => this.readFile(`${root}/${p}`),
        )
      } catch (error) {
        console.error('Failed to build full context:', error)
      }
    }

    // Default 'tree' mode: send only the file tree (relative paths, no
    // contents). File contents are fetched on demand via READ_FILE / GREP /
    // LIST_FILES tools, which keeps per-message token usage low.
    try {
      const result = await window.electronAPI!.findFiles(this.currentProject.rootPath, '*', configService.getContextMaxFiles())
      if (result.success && result.files) {
        let context = `Project File Tree (${result.files.length} files${result.truncated ? ' - list truncated' : ''})\n`
        context += result.files.join('\n')
        context += `\n\nNote: only file paths are listed above; file contents are NOT included. Use READ_FILE to read a file, GREP to search contents, or LIST_FILES to browse a directory.`
        return context
      }
    } catch (error) {
      console.error('Failed to build automatic context:', error)
    }
    // Fallback to simple context
    let context = `Project: ${this.currentProject.name}\n`
    return context
  }

  async getAllFiles(): Promise<ProjectFile[]> {
    if (!this.currentProject) {
      return []
    }

    const allFiles: ProjectFile[] = []
    const collectFiles = async (dirPath: string): Promise<void> => {
      if (window.electronAPI) {
        const result = await window.electronAPI.readDirectory(dirPath)
        if (result.success && result.items) {
          for (const item of result.items) {
            if (item.isDirectory) {
              await collectFiles(item.path)
            } else {
              allFiles.push({
                path: item.path,
                name: item.name,
                isDirectory: false,
              })
            }
          }
        }
      }
    }

    await collectFiles(this.currentProject.rootPath)
    return allFiles
  }
}

export const projectService = new ProjectService()
