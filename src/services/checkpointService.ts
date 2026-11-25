// Persistent storage for AI-write checkpoints so the ↩️ rollback button
// keeps working after an app restart (v1.2.0, backlog layer-delta).
// Mirrors chatHistoryService's pattern: the main process owns the files
// under userData/checkpoints, one JSON file per project named by a hash
// of its root path, and renderer writes are serialized + debounced.
//
// Paths inside a batch are stored project-relative so the file stays
// valid if the project folder is later moved or mounted differently.

export interface CheckpointFileSnapshot {
  path: string // project-relative, forward slashes
  prevContent: string
  existed: boolean
}

export interface CheckpointBatch {
  timestamp: number
  files: CheckpointFileSnapshot[]
}

const MAX_BATCHES = 50
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const SAVE_DEBOUNCE_MS = 800

const normRoot = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const relTo = (rootKey: string, absPath: string): string => {
  const n = absPath.replace(/\\/g, '/')
  return n.toLowerCase().startsWith(rootKey + '/') ? n.slice(rootKey.length + 1) : n
}

class CheckpointService {
  private store = new Map<string, CheckpointBatch[]>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  // Writes are serialized so overlapping saves cannot interleave.
  private queue: Promise<unknown> = Promise.resolve()

  // Load the persisted batches for a project (cached afterwards).
  async load(rootPath: string): Promise<CheckpointBatch[]> {
    const key = normRoot(rootPath)
    const cached = this.store.get(key)
    if (cached) return cached
    let batches: CheckpointBatch[] = []
    try {
      const res = await window.electronAPI?.checkpointGet?.(rootPath)
      if (res?.success && typeof res.json === 'string') {
        const parsed = JSON.parse(res.json)
        if (Array.isArray(parsed?.batches)) {
          batches = parsed.batches.filter(
            (b: CheckpointBatch) => Array.isArray(b?.files),
          )
        }
      }
    } catch { /* missing/corrupt file -> start empty */ }
    this.store.set(key, batches)
    return batches
  }

  // Record a batch of pre-write snapshots (absolute paths in, relative
  // paths persisted). Oversized snapshots are skipped - a truncated
  // snapshot could never restore correctly anyway.
  push(rootPath: string, files: { path: string; prevContent: string; existed: boolean }[]): void {
    const key = normRoot(rootPath)
    const kept = files
      .filter((f) => (f.prevContent?.length ?? 0) <= MAX_SNAPSHOT_BYTES)
      .map((f) => ({ path: relTo(key, f.path), prevContent: f.prevContent, existed: !!f.existed }))
    if (kept.length === 0) return
    const arr = this.store.get(key) ?? []
    arr.push({ timestamp: Date.now(), files: kept })
    this.store.set(key, arr)
    this.scheduleSave(key, rootPath)
  }

  pop(rootPath: string): void {
    const key = normRoot(rootPath)
    const arr = this.store.get(key)
    if (arr?.length) {
      arr.pop()
      this.scheduleSave(key, rootPath)
    }
  }

  private scheduleSave(key: string, rootPath: string): void {
    const prev = this.timers.get(key)
    if (prev) clearTimeout(prev)
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      void this.flush(rootPath)
    }, SAVE_DEBOUNCE_MS))
  }

  private async flush(rootPath: string): Promise<void> {
    const key = normRoot(rootPath)
    const task = this.queue.then(async () => {
      if (!window.electronAPI?.checkpointPut) return
      const arr = this.store.get(key) ?? []
      // FIFO trim: batch-count cap first, then total-size cap - oldest
      // batches are the least useful rollback targets.
      while (arr.length > MAX_BATCHES) arr.shift()
      let json = JSON.stringify({ version: 1, batches: arr })
      while (arr.length > 0 && json.length > MAX_TOTAL_BYTES) {
        arr.shift()
        json = JSON.stringify({ version: 1, batches: arr })
      }
      await window.electronAPI.checkpointPut(rootPath, json)
    }).catch((e) => console.warn('Failed to persist checkpoints:', e))
    this.queue = task
    return task
  }
}

export const checkpointService = new CheckpointService()
