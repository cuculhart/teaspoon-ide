// Chat history persistence.
// One JSON file per conversation under userData/chat-history plus a
// small index maintained by the main process (electron/ipcHandlers.js)
// - effectively unlimited size, crash-safe atomic writes, no
// localStorage quota. localStorage survives only as a fallback when
// the Electron bridge is unavailable (plain-browser dev) and as the
// source of the legacy project-keyed store migrated on first run.
//
// Conversations are keyed by convId; projectPath is an attribute, so a
// chat can exist before any project is opened and later gain a path
// when the create-project prompt materializes a folder.

export interface ChatMessageRecord {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  // Round-trip time of the LLM call that produced this message (ms)
  latencyMs?: number
  // Model that produced this response (e.g. "ollama:qwen3.5:4b")
  model?: string
  // Raw model output before command blocks became display notes (see
  // Chat.tsx). Trimmed from older messages before saving - it can
  // carry whole file bodies that are already on disk.
  rawContent?: string
}

export interface Conversation {
  id: string // "conv_<ts>_<rand>"
  title: string
  // null = chat started without a project.
  projectPath: string | null
  createdAt: number
  updatedAt: number
  // messages[0 .. summarizedCount) are folded into contextSummary.
  // The model gets the summary plus a recent window, not the full log.
  summarizedCount: number
  contextSummary: string
  messages: ChatMessageRecord[]
}

export interface ConversationMeta {
  id: string
  title: string
  projectPath: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
}

const LEGACY_STORE_KEY = 'chat_conversations'
const FALLBACK_STORE_KEY = 'chat_conversations_v2'
// rawContent duplicates the display text and can carry whole file
// bodies; only the recent window needs it for history fidelity.
const RAW_HISTORY_WINDOW = 20

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function trimForStorage(messages: ChatMessageRecord[]): ChatMessageRecord[] {
  return messages.map((m, i) =>
    i < messages.length - RAW_HISTORY_WINDOW ? { ...m, rawContent: undefined } : m,
  )
}

const metaOf = (c: Conversation): ConversationMeta => ({
  id: c.id,
  title: c.title,
  projectPath: c.projectPath,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  messageCount: c.messages.length,
})

class ChatHistoryService {
  private migrated = false
  // Writes are serialized: the main-process index update is a
  // read-modify-write, so overlapping saves could lose index entries.
  private queue: Promise<unknown> = Promise.resolve()

  createId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  deriveTitle(messages: ChatMessageRecord[]): string {
    const first = messages.find((m) => m.role === 'user')
    const text = (first?.content ?? '').replace(/\s+/g, ' ').trim()
    return text.slice(0, 40) || 'Untitled chat'
  }

  private get useIpc(): boolean {
    return typeof window !== 'undefined' && !!window.electronAPI?.chatHistoryPut
  }

  // Fallback store for environments without the Electron bridge
  private readFallback(): Record<string, Conversation> {
    try {
      const raw = localStorage.getItem(FALLBACK_STORE_KEY)
      const parsed = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  private writeFallback(store: Record<string, Conversation>): void {
    try {
      localStorage.setItem(FALLBACK_STORE_KEY, JSON.stringify(store))
    } catch (error) {
      console.warn('Failed to persist chat history:', error)
    }
  }

  // Move the legacy project-keyed localStorage store into
  // per-conversation files. The legacy key is removed only after every
  // write succeeds, so a failed migration retries next time.
  private async ensureMigrated(): Promise<void> {
    if (this.migrated || !this.useIpc) return
    this.migrated = true
    let legacy: Record<string, { messages?: ChatMessageRecord[]; createdAt?: number; updatedAt?: number }[]>
    try {
      const raw = localStorage.getItem(LEGACY_STORE_KEY)
      if (!raw) return
      legacy = JSON.parse(raw)
    } catch {
      return
    }
    for (const [key, list] of Object.entries(legacy ?? {})) {
      const conv = Array.isArray(list) ? list[0] : null
      if (!conv || !Array.isArray(conv.messages) || conv.messages.length === 0) continue
      const now = Date.now()
      await this.save({
        id: this.createId(),
        title: this.deriveTitle(conv.messages),
        // Legacy keys are normalized paths - fine on Windows/macOS; a
        // case-differing path on Linux may not reopen, a known limit.
        projectPath: key,
        createdAt: conv.createdAt || now,
        updatedAt: conv.updatedAt || now,
        summarizedCount: 0,
        contextSummary: '',
        messages: conv.messages,
      })
    }
    localStorage.removeItem(LEGACY_STORE_KEY)
  }

  async listConversations(): Promise<ConversationMeta[]> {
    if (!this.useIpc) {
      return Object.values(this.readFallback())
        .map(metaOf)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    }
    await this.ensureMigrated()
    const res = await window.electronAPI!.chatHistoryList()
    return res.success ? (res.conversations ?? []) : []
  }

  async getById(id: string | null | undefined): Promise<Conversation | null> {
    if (!id) return null
    if (!this.useIpc) return this.readFallback()[id] ?? null
    await this.ensureMigrated()
    const res = await window.electronAPI!.chatHistoryGet(id)
    if (!res.success || !res.conversation) return null
    return res.conversation as Conversation
  }

  // 1:1 semantics preserved: "the project's conversation" is the most
  // recently updated one bound to that path.
  async getByProject(projectPath: string): Promise<Conversation | null> {
    const target = normalizePath(projectPath)
    const metas = await this.listConversations()
    const hit = metas.find((m) => m.projectPath && normalizePath(m.projectPath) === target)
    return hit ? this.getById(hit.id) : null
  }

  async save(conv: Conversation): Promise<void> {
    const task = this.queue.then(async () => {
      const stored = { ...conv, messages: trimForStorage(conv.messages) }
      if (!this.useIpc) {
        const store = this.readFallback()
        store[stored.id] = stored
        this.writeFallback(store)
        return
      }
      await window.electronAPI!.chatHistoryPut(stored.id, JSON.stringify(stored))
    }).catch((error) => console.warn('Failed to persist chat history:', error))
    this.queue = task
    return task
  }

  async setProjectPath(id: string, projectPath: string): Promise<void> {
    const conv = await this.getById(id)
    if (!conv) return
    conv.projectPath = projectPath
    conv.updatedAt = Date.now()
    await this.save(conv)
  }

  async delete(id: string): Promise<void> {
    if (!this.useIpc) {
      const store = this.readFallback()
      delete store[id]
      this.writeFallback(store)
      return
    }
    await window.electronAPI!.chatHistoryDelete(id)
  }

  async clearAll(): Promise<void> {
    if (!this.useIpc) {
      localStorage.removeItem(FALLBACK_STORE_KEY)
      localStorage.removeItem(LEGACY_STORE_KEY)
      return
    }
    await window.electronAPI!.chatHistoryClear()
  }
}

export const chatHistoryService = new ChatHistoryService()
