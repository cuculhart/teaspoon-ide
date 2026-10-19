export interface RecentProject {
  name: string
  path: string
  openCount: number
  lastOpenedAt: number
}

const RECENT_PROJECTS_KEY = 'recent_projects'
const MAX_RECENT_PROJECTS = 10

export type ThemeMode =
  'system' | 'dark' | 'light' | 'quiet' | 'ocean' | 'console' | 'walnut' | 'heritage' | 'wine'
  | 'fizz' | 'otegami' | 'float' | 'msx' | 'chaya' | 'coquette'

// 'tree' = send only the file list (AI fetches contents via tools).
// 'full' = send scored file contents up to the token budget (legacy).
export type ContextMode = 'tree' | 'full'

// 'gemini' = Google Gemini API (or LiteLLM proxy). 'ollama' = local Ollama.
export type LlmProvider = 'gemini' | 'ollama'

// Ollama "think" field: boolean on/off, or an effort level for models
// that support levels (gpt-oss, qwen3, ...).
export type OllamaThink = boolean | 'low' | 'medium' | 'high'

// Credentials issued by an organization's management server, stored
// separately from the personal Gemini key so signing out never destroys it.
export interface ManagedSession {
  apiKey: string
  proxyUrl: string
  user?: string
  model?: string    // server-pinned model, or the user's selection
  models?: string[] // model ids the key is allowed to use
  expiresAt?: number // epoch ms; absent = never expires client-side
}

// Storage keys routed through the main process's secret store
// (safeStorage-encrypted secrets.json) via the sync bridge - never plain
// localStorage. Two kinds live there:
//   - credentials ("*_api_key") - write-only from the renderer; the
//     main-process LLM relay is their only reader
//   - endpoint bindings (proxy/server URLs) - still readable for the
//     Settings UI, but stored alongside the key so the relay can trust
//     its own copy rather than a renderer-supplied destination
const API_KEY_STORAGE_KEY = /^[a-z][a-z0-9_]{0,63}_api_key$/
const SECRET_STORAGE_KEYS = new Set([
  'llm_proxy_url',
  'managed_proxy_url',
  'managed_server_url',
])
const isSecretStorageKey = (storageKey: string) =>
  SECRET_STORAGE_KEYS.has(storageKey) || API_KEY_STORAGE_KEY.test(storageKey)

// Config key -> persisted storage key
const STORAGE_KEYS: Record<string, string> = {
  GEMINI_API_KEY: 'gemini_api_key',
  GEMINI_MODEL: 'gemini_model',
  GEMINI_CUSTOM_MODEL: 'gemini_custom_model',
  LLM_PROXY_URL: 'llm_proxy_url',
  THEME: 'theme',
  UI_FONT_FAMILY: 'ui_font_family',
  UI_FONT_SIZE: 'ui_font_size',
  CHAT_FONT_SIZE: 'chat_font_size',
  CONTEXT_MODE: 'context_mode',
  CONTEXT_MAX_FILES: 'context_max_files',
  LLM_PROVIDER: 'llm_provider',
  OLLAMA_BASE_URL: 'ollama_base_url',
  OLLAMA_MODEL: 'ollama_model',
  OLLAMA_NUM_THREAD: 'ollama_num_thread',
  OLLAMA_NUM_CTX: 'ollama_num_ctx',
  OLLAMA_TEMPERATURE: 'ollama_temperature',
  OLLAMA_THINK: 'ollama_think',
  LANGUAGE: 'language',
  MANAGED_MODE: 'managed_mode',
  MANAGED_SERVER_URL: 'managed_server_url',
  MANAGED_API_KEY: 'managed_api_key',
  MANAGED_PROXY_URL: 'managed_proxy_url',
  MANAGED_USER: 'managed_user',
  MANAGED_MODEL: 'managed_model',
  MANAGED_MODELS: 'managed_models',
  MANAGED_EXPIRY: 'managed_expiry',
}

class ConfigService {
  private config: Map<string, string> = new Map()

  constructor() {
    this.loadConfig()
  }

  private readStorage(storageKey: string): string | null {
    if (isSecretStorageKey(storageKey) && window.electronAPI?.secretsGet) {
      // Credentials are never read back - the main process keeps them.
      if (API_KEY_STORAGE_KEY.test(storageKey)) {
        this.migrateLegacySecret(storageKey)
        return null
      }
      const value = window.electronAPI.secretsGet(storageKey)
      if (value) return value
      this.migrateLegacySecret(storageKey)
      // Retry once - the migration above may have just stored a value
      return window.electronAPI.secretsGet(storageKey)
    }
    return localStorage.getItem(storageKey)
  }

  // One-time migration of values saved by pre-safeStorage versions.
  // Works for both credential and endpoint keys; the migrated value is
  // not returned so credentials stay out of renderer memory.
  private migrateLegacySecret(storageKey: string): void {
    const legacy = localStorage.getItem(storageKey)
    if (legacy && window.electronAPI?.secretsSet) {
      window.electronAPI.secretsSet(storageKey, legacy)
      localStorage.removeItem(storageKey)
    }
  }

  private writeStorage(storageKey: string, value: string): void {
    if (isSecretStorageKey(storageKey) && window.electronAPI?.secretsSet) {
      window.electronAPI.secretsSet(storageKey, value)
      return
    }
    localStorage.setItem(storageKey, value)
  }

  private loadConfig() {
    // Load from localStorage / OS keychain (secret keys). Credential values
    // are never cached in the renderer - they are only migrated forward,
    // and read back exclusively by the main process.
    this.migrateLegacySecret('gemini_api_key')
    this.migrateLegacySecret('managed_api_key')
    const model = localStorage.getItem('gemini_model')
    const customModel = localStorage.getItem('gemini_custom_model')
    const proxyUrl = this.readStorage('llm_proxy_url')
    const theme = localStorage.getItem('theme')
    const uiFontFamily = localStorage.getItem('ui_font_family')
    const uiFontSize = localStorage.getItem('ui_font_size')
    const chatFontSize = localStorage.getItem('chat_font_size')
    const contextMode = localStorage.getItem('context_mode')
    const contextMaxFiles = localStorage.getItem('context_max_files')
    const llmProvider = localStorage.getItem('llm_provider')
    const ollamaBaseUrl = localStorage.getItem('ollama_base_url')
    const ollamaModel = localStorage.getItem('ollama_model')
    const ollamaNumThread = localStorage.getItem('ollama_num_thread')
    const ollamaNumCtx = localStorage.getItem('ollama_num_ctx')
    const ollamaTemperature = localStorage.getItem('ollama_temperature')
    const ollamaThink = localStorage.getItem('ollama_think')
    const language = localStorage.getItem('language')
    const managedMode = localStorage.getItem('managed_mode')
    const managedServerUrl = this.readStorage('managed_server_url')
    const managedProxyUrl = this.readStorage('managed_proxy_url')
    const managedUser = localStorage.getItem('managed_user')
    const managedModel = localStorage.getItem('managed_model')
    const managedModels = localStorage.getItem('managed_models')
    const managedExpiry = localStorage.getItem('managed_expiry')

    if (model) this.config.set('GEMINI_MODEL', model)
    if (customModel) this.config.set('GEMINI_CUSTOM_MODEL', customModel)
    if (proxyUrl) this.config.set('LLM_PROXY_URL', proxyUrl)
    if (theme) this.config.set('THEME', theme)
    if (uiFontFamily) this.config.set('UI_FONT_FAMILY', uiFontFamily)
    if (uiFontSize) this.config.set('UI_FONT_SIZE', uiFontSize)
    if (chatFontSize) this.config.set('CHAT_FONT_SIZE', chatFontSize)
    if (contextMode) this.config.set('CONTEXT_MODE', contextMode)
    if (contextMaxFiles) this.config.set('CONTEXT_MAX_FILES', contextMaxFiles)
    if (llmProvider) this.config.set('LLM_PROVIDER', llmProvider)
    if (ollamaBaseUrl) this.config.set('OLLAMA_BASE_URL', ollamaBaseUrl)
    if (ollamaModel) this.config.set('OLLAMA_MODEL', ollamaModel)
    if (ollamaNumThread) this.config.set('OLLAMA_NUM_THREAD', ollamaNumThread)
    if (ollamaNumCtx) this.config.set('OLLAMA_NUM_CTX', ollamaNumCtx)
    if (ollamaTemperature) this.config.set('OLLAMA_TEMPERATURE', ollamaTemperature)
    if (ollamaThink) this.config.set('OLLAMA_THINK', ollamaThink)
    if (language) this.config.set('LANGUAGE', language)
    if (managedMode) this.config.set('MANAGED_MODE', managedMode)
    if (managedServerUrl) this.config.set('MANAGED_SERVER_URL', managedServerUrl)
    if (managedProxyUrl) this.config.set('MANAGED_PROXY_URL', managedProxyUrl)
    if (managedUser) this.config.set('MANAGED_USER', managedUser)
    if (managedModel) this.config.set('MANAGED_MODEL', managedModel)
    if (managedModels) this.config.set('MANAGED_MODELS', managedModels)
    if (managedExpiry) this.config.set('MANAGED_EXPIRY', managedExpiry)
  }

  get(key: string): string | undefined {
    return this.config.get(key)
  }

  set(key: string, value: string): void {
    const storageKey = STORAGE_KEYS[key]
    // Credential values are written through to the secret store but never
    // cached in renderer memory.
    if (storageKey && API_KEY_STORAGE_KEY.test(storageKey) && window.electronAPI?.secretsSet) {
      this.config.delete(key)
      this.writeStorage(storageKey, value)
      return
    }
    this.config.set(key, value)

    // Sync to persistent storage (secrets go via writeStorage to the keychain)
    if (storageKey) this.writeStorage(storageKey, value)
  }

  private remove(key: string, storageKey: string): void {
    this.config.delete(key)
    if (isSecretStorageKey(storageKey) && window.electronAPI?.secretsRemove) {
      window.electronAPI.secretsRemove(storageKey)
      return
    }
    localStorage.removeItem(storageKey)
  }

  // Note: no getGeminiApiKey() - the stored key is never read back into
  // the renderer. Existence is checked via hasGeminiApiKey().

  getGeminiModel(): string {
    return this.get('GEMINI_MODEL') || 'gemini-3.8-flash'
  }

  getGeminiCustomModel(): string | undefined {
    return this.get('GEMINI_CUSTOM_MODEL')
  }

  getLlmProxyUrl(): string | undefined {
    return this.get('LLM_PROXY_URL')
  }

  setGeminiApiKey(apiKey: string): void {
    this.set('GEMINI_API_KEY', apiKey)
  }

  setGeminiModel(model: string): void {
    this.set('GEMINI_MODEL', model)
  }

  setGeminiCustomModel(customModel: string): void {
    this.set('GEMINI_CUSTOM_MODEL', customModel)
  }

  setLlmProxyUrl(proxyUrl: string): void {
    this.set('LLM_PROXY_URL', proxyUrl)
  }

  getTheme(): ThemeMode {
    const value = this.get('THEME')
    const modes: ThemeMode[] = ['dark', 'light', 'quiet', 'ocean', 'console', 'walnut', 'heritage', 'wine',
      'fizz', 'otegami', 'float', 'msx', 'chaya', 'coquette']
    return modes.includes(value as ThemeMode) ? (value as ThemeMode) : 'system'
  }

  setTheme(theme: ThemeMode): void {
    this.set('THEME', theme)
  }

  getUIFontFamily(): string | undefined {
    return this.get('UI_FONT_FAMILY')
  }

  setUIFontFamily(fontFamily: string): void {
    this.set('UI_FONT_FAMILY', fontFamily)
  }

  getUIFontSize(): number | undefined {
    const value = this.get('UI_FONT_SIZE')
    const size = value ? parseInt(value, 10) : NaN
    return Number.isFinite(size) && size > 0 ? size : undefined
  }

  setUIFontSize(fontSize: number): void {
    this.set('UI_FONT_SIZE', String(fontSize))
  }

  // Chat panel font size - separate from the UI/editor size so chat text
  // can be scaled on its own. 0/empty = the 13px CSS default.
  getChatFontSize(): number | undefined {
    const value = this.get('CHAT_FONT_SIZE')
    const size = value ? parseInt(value, 10) : NaN
    return Number.isFinite(size) && size > 0 ? size : undefined
  }

  setChatFontSize(fontSize: number): void {
    this.set('CHAT_FONT_SIZE', String(fontSize))
  }

  getRecentProjects(): RecentProject[] {
    try {
      const raw = localStorage.getItem(RECENT_PROJECTS_KEY)
      if (!raw) return []
      const list = JSON.parse(raw)
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  // Sorted by open count (most used first), then most recent
  addRecentProject(name: string, path: string): void {
    const list = this.getRecentProjects()
    const existing = list.find(p => p.path === path)
    if (existing) {
      existing.openCount += 1
      existing.lastOpenedAt = Date.now()
      existing.name = name
    } else {
      list.push({ name, path, openCount: 1, lastOpenedAt: Date.now() })
    }
    list.sort((a, b) => b.openCount - a.openCount || b.lastOpenedAt - a.lastOpenedAt)
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list.slice(0, MAX_RECENT_PROJECTS)))
  }

  removeRecentProject(path: string): void {
    const list = this.getRecentProjects().filter(p => p.path !== path)
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list))
  }

  // Chat focus mode: only the chat panel is visible, IDE panes hidden
  getChatFocus(): boolean {
    return localStorage.getItem('chat_focus') === '1'
  }

  setChatFocus(on: boolean): void {
    localStorage.setItem('chat_focus', on ? '1' : '0')
  }

  // Conversation active when no project is open - restored on the next
  // run so project-less chats survive restarts like project chats do.
  getLastNoProjectConv(): string | null {
    return localStorage.getItem('last_no_project_conv')
  }

  setLastNoProjectConv(id: string | null): void {
    if (id) {
      localStorage.setItem('last_no_project_conv', id)
    } else {
      localStorage.removeItem('last_no_project_conv')
    }
  }

  // Whether long conversations are compacted into a rolling summary.
  // The compaction costs one extra AI call per turn on long chats, so
  // it can be disabled to keep request counts identical to before.
  getAutoSummarize(): boolean {
    return localStorage.getItem('auto_summarize') !== '0'
  }

  setAutoSummarize(on: boolean): void {
    localStorage.setItem('auto_summarize', on ? '1' : '0')
  }

  getLlmProvider(): LlmProvider {
    return this.get('LLM_PROVIDER') === 'ollama' ? 'ollama' : 'gemini'
  }

  setLlmProvider(provider: LlmProvider): void {
    this.set('LLM_PROVIDER', provider)
  }

  getOllamaBaseUrl(): string {
    return this.get('OLLAMA_BASE_URL') || 'http://localhost:11434'
  }

  setOllamaBaseUrl(url: string): void {
    this.set('OLLAMA_BASE_URL', url)
  }

  getOllamaModel(): string {
    return this.get('OLLAMA_MODEL') || 'gemma4:e4b'
  }

  setOllamaModel(model: string): void {
    this.set('OLLAMA_MODEL', model)
  }

  // CPU threads passed to Ollama as options.num_thread. Unset = let
  // Ollama use every logical core (its default).
  getOllamaNumThread(): number | undefined {
    const value = parseInt(this.get('OLLAMA_NUM_THREAD') || '', 10)
    return Number.isFinite(value) && value > 0 ? value : undefined
  }

  setOllamaNumThread(threads: number | undefined): void {
    if (threads && threads > 0) {
      this.set('OLLAMA_NUM_THREAD', String(threads))
    } else {
      this.remove('OLLAMA_NUM_THREAD', 'ollama_num_thread')
    }
  }

  // Context window passed to Ollama as options.num_ctx. Empty = Ollama's
  // own default (4096), which is too small for agent loops: the system
  // prompt + file reads + reasoning can exhaust it mid-generation and
  // surface as an empty reply. 8192+ is recommended for agent use.
  getOllamaNumCtx(): number | undefined {
    const value = parseInt(this.get('OLLAMA_NUM_CTX') || '', 10)
    return Number.isFinite(value) && value > 0 ? value : undefined
  }

  setOllamaNumCtx(ctx: number | undefined): void {
    if (ctx && ctx > 0) {
      this.set('OLLAMA_NUM_CTX', String(ctx))
    } else {
      this.remove('OLLAMA_NUM_CTX', 'ollama_num_ctx')
    }
  }

  // Sampling temperature passed to Ollama as options.temperature. Empty =
  // the model's own default (typically 1.0-ish - measured as a source of
  // language drift and hallucinated details in agent loops). The agent
  // loop falls back to a low default when unset; see ollamaService.
  getOllamaTemperature(): number | undefined {
    const value = parseFloat(this.get('OLLAMA_TEMPERATURE') || '')
    return Number.isFinite(value) && value >= 0 && value <= 2 ? value : undefined
  }

  setOllamaTemperature(temperature: number | undefined): void {
    if (temperature !== undefined && temperature >= 0 && temperature <= 2) {
      this.set('OLLAMA_TEMPERATURE', String(temperature))
    } else {
      this.remove('OLLAMA_TEMPERATURE', 'ollama_temperature')
    }
  }

  // Thinking control for reasoning models (qwen3.5, gpt-oss, ...), sent
  // as the "think" field of /api/chat: boolean on/off, or an effort level
  // for models that accept one. gpt-oss cannot fully disable thinking -
  // "low" is its minimum. undefined = let the model decide (most thinking
  // models default to on).
  getOllamaThink(): OllamaThink | undefined {
    const value = this.get('OLLAMA_THINK')
    if (value === '1') return true
    if (value === '0') return false
    if (value === 'low' || value === 'medium' || value === 'high') return value
    return undefined
  }

  setOllamaThink(think: OllamaThink | undefined): void {
    if (think === undefined) {
      this.remove('OLLAMA_THINK', 'ollama_think')
    } else {
      this.set('OLLAMA_THINK', think === true ? '1' : think === false ? '0' : think)
    }
  }

  getLanguage(): string {
    return this.get('LANGUAGE') || 'en'
  }

  setLanguage(code: string): void {
    this.set('LANGUAGE', code)
  }

  getContextMode(): ContextMode {
    return this.get('CONTEXT_MODE') === 'full' ? 'full' : 'tree'
  }

  setContextMode(mode: ContextMode): void {
    this.set('CONTEXT_MODE', mode)
  }

  getContextMaxFiles(): number {
    const value = parseInt(this.get('CONTEXT_MAX_FILES') || '', 10)
    return Number.isFinite(value) && value > 0 ? value : 2000
  }

  setContextMaxFiles(maxFiles: number): void {
    this.set('CONTEXT_MAX_FILES', String(maxFiles))
  }

  // --- Organization (managed) mode ---
  // When enabled, the app shows a sign-in gate until credentials issued by
  // the organization's server are stored. The managed key is kept separate
  // from the personal Gemini key, so signing out leaves personal config
  // untouched and disabling managed mode instantly restores local use.

  getManagedMode(): boolean {
    return this.get('MANAGED_MODE') === '1'
  }

  setManagedMode(on: boolean): void {
    this.set('MANAGED_MODE', on ? '1' : '0')
  }

  getManagedServerUrl(): string {
    return this.get('MANAGED_SERVER_URL') || ''
  }

  setManagedServerUrl(url: string): void {
    this.set('MANAGED_SERVER_URL', url)
  }

  getManagedUser(): string | undefined {
    return this.get('MANAGED_USER')
  }

  getManagedSessionExpiry(): number | undefined {
    const value = parseInt(this.get('MANAGED_EXPIRY') || '', 10)
    return Number.isFinite(value) && value > 0 ? value : undefined
  }

  setManagedSession(session: ManagedSession): void {
    this.set('MANAGED_API_KEY', session.apiKey)
    this.set('MANAGED_PROXY_URL', session.proxyUrl)
    if (session.user) {
      this.set('MANAGED_USER', session.user)
    } else {
      this.remove('MANAGED_USER', 'managed_user')
    }
    if (session.model) {
      this.set('MANAGED_MODEL', session.model)
    }
    if (session.models && session.models.length > 0) {
      this.set('MANAGED_MODELS', JSON.stringify(session.models))
      // Keep an existing selection if still allowed, else fall back
      // to the first allowed model.
      const current = this.get('MANAGED_MODEL')
      if (!current || !session.models.includes(current)) {
        this.set('MANAGED_MODEL', session.models[0])
      }
    } else {
      this.remove('MANAGED_MODELS', 'managed_models')
      if (!session.model) {
        this.remove('MANAGED_MODEL', 'managed_model')
      }
    }
    if (session.expiresAt) {
      this.set('MANAGED_EXPIRY', String(session.expiresAt))
    } else {
      this.remove('MANAGED_EXPIRY', 'managed_expiry')
    }
  }

  // Drops the issued key and session metadata. Server URL and the on/off
  // flag are kept, so re-enabling or re-signing-in is one step.
  clearManagedSession(): void {
    this.remove('MANAGED_API_KEY', 'managed_api_key')
    this.remove('MANAGED_PROXY_URL', 'managed_proxy_url')
    this.remove('MANAGED_USER', 'managed_user')
    this.remove('MANAGED_MODEL', 'managed_model')
    this.remove('MANAGED_MODELS', 'managed_models')
    this.remove('MANAGED_EXPIRY', 'managed_expiry')
  }

  // Existence check for a stored secret without reading the value -
  // goes through the main process's secrets-has (or localStorage in
  // non-Electron fallbacks).
  private hasSecret(storageKey: string): boolean {
    if (window.electronAPI?.secretsHas) {
      return !!window.electronAPI.secretsHas(storageKey)
    }
    return !!localStorage.getItem(storageKey)
  }

  hasGeminiApiKey(): boolean {
    return this.hasSecret('gemini_api_key')
  }

  // Model ids this session's key may use (empty = unrestricted/unknown)
  getManagedModels(): string[] {
    try {
      const raw = this.get('MANAGED_MODELS')
      const list = raw ? JSON.parse(raw) : []
      return Array.isArray(list) ? list.filter(m => typeof m === 'string') : []
    } catch {
      return []
    }
  }

  // Select among the organization-allowed models
  setManagedModel(model: string): void {
    this.set('MANAGED_MODEL', model)
  }

  // True while a managed session is active: mode on, a stored key
  // present, and the session not expired.
  hasManagedSession(): boolean {
    if (!this.getManagedMode()) return false
    const expiry = this.getManagedSessionExpiry()
    if (expiry && expiry <= Date.now()) return false
    return this.hasSecret('managed_api_key')
  }

  // Non-secret session info (allowed models + selection). The credential
  // and its endpoint stay in the secret store - the renderer never sees them.
  getManagedSession(): { model?: string; models?: string[] } | undefined {
    if (!this.hasManagedSession()) return undefined
    return {
      model: this.get('MANAGED_MODEL'),
      models: this.getManagedModels(),
    }
  }

  // Managed mode on + no valid session = show the sign-in gate.
  isManagedLocked(): boolean {
    return this.getManagedMode() && !this.hasManagedSession()
  }

  // Managed mode on + a stored key whose expiry has passed - the gate
  // uses this to say "expired, sign in again" instead of the bare form.
  hasExpiredManagedSession(): boolean {
    if (!this.getManagedMode()) return false
    const expiry = this.getManagedSessionExpiry()
    return expiry !== undefined && expiry <= Date.now() && this.hasSecret('managed_api_key')
  }

  // Clears the Recent Projects list shown in the Explorer
  clearRecentProjects(): void {
    localStorage.removeItem(RECENT_PROJECTS_KEY)
  }

  // Session restore: reopen the last project/file after a reload
  getLastProjectPath(): string | undefined {
    return localStorage.getItem('last_project_path') || undefined
  }

  setLastProjectPath(path: string): void {
    if (path) {
      localStorage.setItem('last_project_path', path)
    } else {
      localStorage.removeItem('last_project_path')
    }
  }

  getLastOpenFile(): string | undefined {
    return localStorage.getItem('last_open_file') || undefined
  }

  setLastOpenFile(path: string): void {
    if (path) {
      localStorage.setItem('last_open_file', path)
    } else {
      localStorage.removeItem('last_open_file')
    }
  }

  // "Clear API Key" in Settings - only the secret is removed. Model
  // selection, custom model name, and proxy URL are user preferences
  // the owner can change back, so they survive.
  clearGeminiApiKey(): void {
    this.config.delete('GEMINI_API_KEY')
    if (window.electronAPI?.secretsRemove) {
      window.electronAPI.secretsRemove('gemini_api_key')
      return
    }
    localStorage.removeItem('gemini_api_key')
  }
}

export const configService = new ConfigService()
