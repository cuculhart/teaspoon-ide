import React, { useState, useEffect } from 'react'
import { configService, ThemeMode, ContextMode, LlmProvider } from '../services/configService'
import { ollamaService } from '../services/ollamaService'
import { i18nService, useT } from '../services/i18nService'
import { themeService } from '../services/themeService'
import { chatHistoryService } from '../services/chatHistoryService'
import { managedService } from '../services/managedService'
import './Settings.css'

interface SettingsProps {
  onClose: () => void
  onApiKeySaved?: () => void
}

const AVAILABLE_MODELS = [
  // Gemini 3 Stable Models
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (Latest Stable)' },
  { id: 'gemini-3.8-live', name: 'Gemini 3.8 Live (Audio)' },
  { id: 'gemini-3.8-live-extended-thinking', name: 'Gemini 3.8 Live Extended Thinking' },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite (Fast & Cost-Effective)' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite' },
  { id: 'gemini-3.5-transcribe', name: 'Gemini 3.5 Transcribe (Audio)' },
  
  // Gemini 3 Preview Models
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro (Preview)' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash (Preview)' },
  { id: 'gemini-3.5-live-translate', name: 'Gemini 3.5 Live Translate (Preview)' },
  { id: 'gemini-3.1-flash-live', name: 'Gemini 3.1 Flash Live (Preview)' },
  { id: 'gemini-3.1-flash-tts', name: 'Gemini 3.1 Flash TTS (Preview)' },
  { id: 'gemini-omni-flash', name: 'Gemini Omni Flash (Preview)' },
  
  // Legacy Models (for compatibility)
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash (Legacy)' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro (Legacy)' },
  
  // Custom option
  { id: 'custom', name: 'Custom Model' }
]

type SettingsGroupId = 'appearance' | 'aiContext' | 'llmProvider' | 'llmProxy' | 'history'

const SETTINGS_GROUPS_KEY = 'settings_groups'

const DEFAULT_OPEN_GROUPS: Record<SettingsGroupId, boolean> = {
  appearance: true,
  aiContext: true,
  llmProvider: true,
  llmProxy: false,
  history: false,
}

const loadOpenGroups = (): Record<SettingsGroupId, boolean> => {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_GROUPS_KEY) || '{}')
    return { ...DEFAULT_OPEN_GROUPS, ...saved }
  } catch {
    return DEFAULT_OPEN_GROUPS
  }
}

interface SettingsGroupProps {
  title: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}

const SettingsGroup: React.FC<SettingsGroupProps> = ({ title, open, onToggle, children }) => (
  <section className="settings-group">
    <button type="button" className="settings-group-header" onClick={onToggle} aria-expanded={open}>
      <span className={`settings-group-chevron${open ? ' open' : ''}`}>▸</span>
      <span className="settings-group-title">{title}</span>
    </button>
    {open && <div className="settings-group-body">{children}</div>}
  </section>
)

const Settings: React.FC<SettingsProps> = ({ onClose, onApiKeySaved }) => {
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [selectedModel, setSelectedModel] = useState('gemini-1.5-flash')
  const [customModel, setCustomModel] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [useProxy, setUseProxy] = useState(false)
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [fontFamily, setFontFamily] = useState('')
  const [fontSize, setFontSize] = useState('')
  const [historyCleared, setHistoryCleared] = useState(false)
  const [chatHistoryCleared, setChatHistoryCleared] = useState(false)
  const [confirmClearApiKey, setConfirmClearApiKey] = useState(false)
  const [confirmClearChatHistory, setConfirmClearChatHistory] = useState(false)
  const [contextMode, setContextMode] = useState<ContextMode>('tree')
  const [contextMaxFiles, setContextMaxFiles] = useState('2000')
  const [autoSummarize, setAutoSummarize] = useState(true)
  const [provider, setProvider] = useState<LlmProvider>('gemini')
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')
  const [ollamaModel, setOllamaModel] = useState('gemma4:e4b')
  const [ollamaNumThread, setOllamaNumThread] = useState('')
  const [ollamaThink, setOllamaThink] = useState<'default' | 'on' | 'off'>('default')
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [ollamaReachable, setOllamaReachable] = useState<boolean | null>(null)
  const [languages, setLanguages] = useState<Array<{ code: string; label: string }>>([
    { code: 'en', label: 'English' },
  ])
  const [language, setLanguage] = useState('en')
  const [managedMode, setManagedMode] = useState(false)
  const [managedServerUrl, setManagedServerUrl] = useState('')
  const [managedUser, setManagedUser] = useState<string | undefined>(undefined)
  const [managedModels, setManagedModels] = useState<string[]>([])
  const [managedModel, setManagedModel] = useState('')
  const [openGroups, setOpenGroups] = useState<Record<SettingsGroupId, boolean>>(loadOpenGroups)
  const t = useT()
  // Logical processor count of this machine - the upper bound for
  // Ollama's num_thread option.
  const maxThreads = navigator.hardwareConcurrency || 0

  const toggleGroup = (id: SettingsGroupId) => {
    setOpenGroups(prev => {
      const next = { ...prev, [id]: !prev[id] }
      localStorage.setItem(SETTINGS_GROUPS_KEY, JSON.stringify(next))
      return next
    })
  }

  useEffect(() => {
    // Load saved settings
    const loadSettings = async () => {
      if (window.electronAPI) {
        const savedKey = configService.getGeminiApiKey()
        const savedModel = configService.getGeminiModel()
        const savedCustomModel = configService.getGeminiCustomModel()
        const savedProxyUrl = configService.getLlmProxyUrl()
        if (savedKey) {
          setApiKey(savedKey)
        }
        if (savedModel) {
          setSelectedModel(savedModel)
          if (savedModel === 'custom' && savedCustomModel) {
            setCustomModel(savedCustomModel)
          }
        }
        if (savedProxyUrl) {
          setProxyUrl(savedProxyUrl)
          setUseProxy(true)
        }
        setTheme(configService.getTheme())
        setFontFamily(configService.getUIFontFamily() || '')
        const savedFontSize = configService.getUIFontSize()
        setFontSize(savedFontSize ? String(savedFontSize) : '')
        setContextMode(configService.getContextMode())
        setContextMaxFiles(String(configService.getContextMaxFiles()))
        setAutoSummarize(configService.getAutoSummarize())
        const p = configService.getLlmProvider()
        setProvider(p)
        setOllamaUrl(configService.getOllamaBaseUrl())
        setOllamaModel(configService.getOllamaModel())
        const nt = configService.getOllamaNumThread()
        setOllamaNumThread(nt ? String(nt) : '')
        const think = configService.getOllamaThink()
        setOllamaThink(think === undefined ? 'default' : think ? 'on' : 'off')
        if (p === 'ollama') {
          refreshOllamaModels()
        }
        setLanguage(configService.getLanguage())
        setManagedMode(configService.getManagedMode())
        setManagedServerUrl(configService.getManagedServerUrl())
        const creds = configService.getManagedCredentials()
        if (creds) {
          setManagedUser(configService.getManagedUser())
          setManagedModels(creds.models || [])
          setManagedModel(creds.model || '')
        }
        window.electronAPI.listLanguages().then((res) => {
          if (res.success && res.languages) setLanguages(res.languages)
        })
      }
    }
    loadSettings()
  }, [])

  const handleSave = () => {
    configService.setGeminiApiKey(apiKey)
    configService.setGeminiModel(selectedModel)
    if (selectedModel === 'custom' && customModel) {
      configService.setGeminiCustomModel(customModel)
    }
    if (useProxy && proxyUrl) {
      configService.setLlmProxyUrl(proxyUrl)
    } else {
      configService.setLlmProxyUrl('')
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    window.dispatchEvent(new Event('teaspoon:llm-changed'))
    onApiKeySaved?.()
  }

  const handleClear = () => {
    setApiKey('')
    configService.clearGeminiApiKey()
    setConfirmClearApiKey(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    window.dispatchEvent(new Event('teaspoon:llm-changed'))
    onApiKeySaved?.()
  }

  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId)
    if (modelId !== 'custom') {
      setCustomModel('')
    }
  }

  // Appearance settings apply immediately (no Save required)
  const handleThemeChange = (value: ThemeMode) => {
    setTheme(value)
    themeService.setMode(value)
  }

  const handleFontFamilyChange = (value: string) => {
    setFontFamily(value)
    configService.setUIFontFamily(value.trim())
    themeService.applyFont()
  }

  const handleFontSizeChange = (value: string) => {
    setFontSize(value)
    const size = parseInt(value, 10)
    configService.setUIFontSize(Number.isFinite(size) && size > 0 ? size : 0)
    themeService.applyFont()
  }

  // AI context settings apply on the next chat message
  const handleContextModeChange = (value: ContextMode) => {
    setContextMode(value)
    configService.setContextMode(value)
    window.dispatchEvent(new Event('teaspoon:context-changed'))
  }

  const handleContextMaxFilesChange = (value: string) => {
    setContextMaxFiles(value)
    const n = parseInt(value, 10)
    if (Number.isFinite(n) && n > 0) {
      configService.setContextMaxFiles(n)
      window.dispatchEvent(new Event('teaspoon:context-changed'))
    }
  }

  const handleAutoSummarizeChange = (on: boolean) => {
    setAutoSummarize(on)
    configService.setAutoSummarize(on)
  }

  // Provider settings apply immediately (no Save needed)
  const refreshOllamaModels = async () => {
    setOllamaReachable(null)
    const models = await ollamaService.listModels()
    setOllamaModels(models)
    setOllamaReachable(models.length > 0)
  }

  const notifyLlmChanged = () => {
    window.dispatchEvent(new Event('teaspoon:llm-changed'))
  }

  const handleProviderChange = (value: LlmProvider) => {
    setProvider(value)
    configService.setLlmProvider(value)
    notifyLlmChanged()
    if (value === 'ollama') {
      refreshOllamaModels()
    }
  }

  const handleOllamaUrlChange = (value: string) => {
    setOllamaUrl(value)
    if (value.trim()) configService.setOllamaBaseUrl(value.trim())
  }

  const handleOllamaModelChange = (value: string) => {
    setOllamaModel(value)
    if (value.trim()) {
      configService.setOllamaModel(value.trim())
      notifyLlmChanged()
    }
  }

  const handleOllamaNumThreadChange = (value: string) => {
    setOllamaNumThread(value)
    const n = parseInt(value, 10)
    configService.setOllamaNumThread(Number.isFinite(n) && n > 0 ? n : undefined)
  }

  const handleOllamaThinkChange = (value: 'default' | 'on' | 'off') => {
    setOllamaThink(value)
    configService.setOllamaThink(value === 'default' ? undefined : value === 'on')
  }

  // Clears Recent Projects (Explorer) and the Quick Open recent-files list.
  // Project files, chats, and settings are untouched.
  const handleClearHistory = () => {
    configService.clearRecentProjects()
    window.dispatchEvent(new Event('teaspoon:clear-file-history'))
    window.dispatchEvent(new Event('teaspoon:recents-cleared'))
    setHistoryCleared(true)
    setTimeout(() => setHistoryCleared(false), 2000)
  }

  // Organization sign-in applies immediately: enabling it locks the app
  // behind the sign-in gate until the server issues credentials.
  const handleManagedServerUrlChange = (value: string) => {
    setManagedServerUrl(value)
    configService.setManagedServerUrl(value.trim())
  }

  const handleManagedModeChange = (on: boolean) => {
    setManagedMode(on)
    configService.setManagedMode(on)
    window.dispatchEvent(new Event('teaspoon:managed-changed'))
  }

  const handleManagedSignOut = () => {
    managedService.logout()
    setManagedUser(undefined)
    setManagedModels([])
    setManagedModel('')
  }

  const handleManagedModelChange = (value: string) => {
    setManagedModel(value)
    configService.setManagedModel(value)
    notifyLlmChanged()
  }

  const handleClearChatHistory = () => {
    void chatHistoryService.clearAll()
    window.dispatchEvent(new Event('teaspoon:chat-history-cleared'))
    setConfirmClearChatHistory(false)
    setChatHistoryCleared(true)
    setTimeout(() => setChatHistoryCleared(false), 2000)
  }

  return (
    <div className="settings-overlay">
      <div className="settings-modal">
        <div className="settings-header">
          <h2>{t('Settings')}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        
        <div className="settings-content">
          <SettingsGroup title={t('Appearance')} open={openGroups.appearance} onToggle={() => toggleGroup('appearance')}>
            <p className="setting-description">
              {t('Changes apply immediately and are saved automatically.')}
            </p>

            <div className="appearance-row">
              <label htmlFor="language-select">{t('Language')}</label>
              <select
                id="language-select"
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value)
                  i18nService.setLanguage(e.target.value)
                }}
                className="model-dropdown"
              >
                {languages.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>

            <div className="appearance-row">
              <label htmlFor="theme-select">{t('Theme')}</label>
              <select
                id="theme-select"
                value={theme}
                onChange={(e) => handleThemeChange(e.target.value as ThemeMode)}
                className="model-dropdown"
              >
                <option value="system">{t('System')}</option>
                <option value="dark">{t('Dark')}</option>
                <option value="light">{t('Light')}</option>
                <option value="quiet">{t('Organic Light')}</option>
                <option value="ocean">{t('Muted Ocean')}</option>
                <option value="console">{t('Ancient Console')}</option>
                <option value="walnut">{t('Walnut')}</option>
                <option value="heritage">{t('Heritage')}</option>
                <option value="wine">{t('Rich Wine')}</option>
                <option value="fizz">{t('Violet Fizz')}</option>
                <option value="otegami">{t('Otegami')}</option>
                <option value="float">{t('Soda Float')}</option>
                <option value="msx">{t('Modern Syntax eXtensible')}</option>
                <option value="chaya">{t('Chaya')}</option>
                <option value="coquette">{t('Coquette')}</option>
              </select>
            </div>

            <div className="appearance-row">
              <label htmlFor="font-family-input">{t('Font Family')}</label>
              <input
                id="font-family-input"
                type="text"
                value={fontFamily}
                onChange={(e) => handleFontFamilyChange(e.target.value)}
                placeholder={t('Default (system font)')}
                className="proxy-url-field"
              />
            </div>

            <div className="appearance-row">
              <label htmlFor="font-size-input">{t('Font Size')}</label>
              <input
                id="font-size-input"
                type="number"
                min="8"
                max="32"
                value={fontSize}
                onChange={(e) => handleFontSizeChange(e.target.value)}
                placeholder="13"
                className="font-size-field"
              />
              <span className="appearance-unit">px</span>
            </div>
          </SettingsGroup>

          <SettingsGroup title={t('AI Context')} open={openGroups.aiContext} onToggle={() => toggleGroup('aiContext')}>
            <p className="setting-description">
              {t('What the app sends to the AI as project context on each message. Applies immediately; changes apply on the next message.')}
            </p>

            <div className="appearance-row">
              <label htmlFor="context-mode-select">{t('Context Mode')}</label>
              <select
                id="context-mode-select"
                value={contextMode}
                onChange={(e) => handleContextModeChange(e.target.value as ContextMode)}
                className="model-dropdown"
              >
                <option value="tree">{t('File tree only (low tokens, recommended)')}</option>
                <option value="full">{t('Full file contents (expensive)')}</option>
              </select>
            </div>

            {contextMode === 'tree' && (
              <div className="appearance-row">
                <label htmlFor="context-max-files">{t('Max Files')}</label>
                <input
                  id="context-max-files"
                  type="number"
                  min="10"
                  max="20000"
                  value={contextMaxFiles}
                  onChange={(e) => handleContextMaxFilesChange(e.target.value)}
                  placeholder="2000"
                  className="font-size-field"
                />
                <span className="appearance-unit">{t('paths')}</span>
              </div>
            )}

            <div className="proxy-toggle">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={autoSummarize}
                  onChange={(e) => handleAutoSummarizeChange(e.target.checked)}
                />
                <span>{t('Summarize long conversations (one extra AI request per turn)')}</span>
              </label>
            </div>
          </SettingsGroup>

          <SettingsGroup title={t('LLM Provider')} open={openGroups.llmProvider} onToggle={() => toggleGroup('llmProvider')}>
            <p className="setting-description">
              {t('Choose the AI backend. Applies immediately - no Save needed.')}
            </p>
            <div className="appearance-row">
              <label htmlFor="provider-select">{t('Provider')}</label>
              <select
                id="provider-select"
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value as LlmProvider)}
                className="model-dropdown"
              >
                <option value="gemini">{t('Gemini API (cloud)')}</option>
                <option value="ollama">{t('Ollama (local, offline)')}</option>
              </select>
            </div>

            {provider === 'ollama' && (
              <>
                <div className="appearance-row">
                  <label htmlFor="ollama-url">{t('Endpoint')}</label>
                  <input
                    id="ollama-url"
                    type="text"
                    value={ollamaUrl}
                    onChange={(e) => handleOllamaUrlChange(e.target.value)}
                    onBlur={refreshOllamaModels}
                    placeholder="http://localhost:11434"
                    className="proxy-url-field"
                  />
                </div>
                <div className="appearance-row">
                  <label htmlFor="ollama-model">{t('Model')}</label>
                  {ollamaModels.length > 0 ? (
                    <select
                      id="ollama-model"
                      value={ollamaModel}
                      onChange={(e) => handleOllamaModelChange(e.target.value)}
                      className="model-dropdown"
                    >
                      {!ollamaModels.includes(ollamaModel) && (
                        <option value={ollamaModel}>{ollamaModel}</option>
                      )}
                      {ollamaModels.map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="ollama-model"
                      type="text"
                      value={ollamaModel}
                      onChange={(e) => handleOllamaModelChange(e.target.value)}
                      placeholder="gemma4:e4b"
                      className="proxy-url-field"
                    />
                  )}
                </div>
                <div className="appearance-row">
                  <label htmlFor="ollama-num-thread">{t('CPU Threads')}</label>
                  <input
                    id="ollama-num-thread"
                    type="number"
                    min="1"
                    max={maxThreads || undefined}
                    value={ollamaNumThread}
                    onChange={(e) => handleOllamaNumThreadChange(e.target.value)}
                    placeholder={maxThreads ? String(maxThreads) : ''}
                    className="font-size-field"
                  />
                  {maxThreads > 0 && (
                    <span className="appearance-unit">/ {maxThreads}</span>
                  )}
                </div>
                <p className="setting-description">
                  {t("Threads Ollama may use for inference. Empty = Ollama's own default (varies by version); a lower number keeps the PC responsive during generation.")}
                </p>
                <div className="appearance-row">
                  <label htmlFor="ollama-think">{t('Thinking')}</label>
                  <select
                    id="ollama-think"
                    value={ollamaThink}
                    onChange={(e) => handleOllamaThinkChange(e.target.value as 'default' | 'on' | 'off')}
                    className="model-dropdown"
                  >
                    <option value="default">{t('Model default')}</option>
                    <option value="on">{t('On')}</option>
                    <option value="off">{t('Off')}</option>
                  </select>
                </div>
                <p className="setting-description">
                  {t('Force reasoning on/off for models that support it (qwen3.5, gpt-oss, ...). Off = much faster replies on slow hardware.')}
                </p>
                <p className="setting-description">
                  {ollamaReachable === null && t('Checking Ollama...')}
                  {ollamaReachable === true && `${t('Connected')} - ${ollamaModels.length} ${t('model(s) installed.')}`}
                  {ollamaReachable === false && t('Cannot reach Ollama. Start it (ollama serve / tray app) and re-open Settings or change the endpoint.')}
                </p>
              </>
            )}

          {provider === 'gemini' && (
          <>
          <div className="setting-section">
            <h3>{t('Gemini API Key')}</h3>
            <p className="setting-description">
              {t('Enter your Google Gemini API key to enable AI chat functionality. Get your API key from')} <a href="https://ai.google.dev/api" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.
            </p>
            
            <div className="api-key-input">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('Enter your Gemini API key')}
                className="api-key-field"
              />
              <button
                className="toggle-visibility"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? '👁️' : '👁️‍🗨️'}
              </button>
            </div>
          </div>

          <div className="setting-section">
            <h3>{t('Model Selection')}</h3>
            <p className="setting-description">
              {t('Select the Gemini model to use for AI chat. Different models have different capabilities and pricing.')}
            </p>
            {managedMode && managedUser && (
              <p className="setting-description">
                {t('Ignored while signed in to an organization - the organization decides the available models.')}
              </p>
            )}

            <div className="model-selection">
              <select
                value={selectedModel}
                onChange={(e) => handleModelChange(e.target.value)}
                className="model-dropdown"
                disabled={managedMode && !!managedUser}
              >
                {AVAILABLE_MODELS.map(model => (
                  <option key={model.id} value={model.id}>
                    {t(model.name)}
                  </option>
                ))}
              </select>
              
              {selectedModel === 'custom' && (
                <input
                  type="text"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder={t('Enter custom model name (e.g., gemini-2.0-flash-thinking)')}
                  className="custom-model-input"
                />
              )}
            </div>
          </div>

          </>
          )}
          </SettingsGroup>

          <SettingsGroup title={t('LLM Proxy')} open={openGroups.llmProxy} onToggle={() => toggleGroup('llmProxy')}>
          {provider === 'gemini' && (
          <div className="setting-section">
            <h3>{t('LLM Proxy (LiteLLM)')}</h3>
            <p className="setting-description">
              {t('Use a proxy server (e.g., LiteLLM) to hide your real API key. The app will send requests to your proxy, which forwards them to the real API.')}
            </p>
            
            <div className="proxy-toggle">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={useProxy}
                  onChange={(e) => setUseProxy(e.target.checked)}
                />
                <span>{t('Use Proxy')}</span>
              </label>
            </div>
            
            {useProxy && (
              <div className="proxy-input">
                <input
                  type="text"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="http://your-litellm-server:4000"
                  className="proxy-url-field"
                />
                <p className="setting-description">
                  {t('Example: http://localhost:4000 or https://your-proxy.com')}
                </p>
              </div>
            )}
          </div>
          )}

          <div className="setting-section">
            <h3>{t('Organization')}</h3>
            <p className="setting-description">
              {t('Sign in with an account issued by your organization. While enabled, the app requires sign-in and sends AI requests through the organization server. Managed sign-in takes precedence over the personal API key above.')}
            </p>

            <div className="appearance-row">
              <label htmlFor="managed-server-url">{t('Server URL')}</label>
              <input
                id="managed-server-url"
                type="text"
                value={managedServerUrl}
                onChange={(e) => handleManagedServerUrlChange(e.target.value)}
                placeholder="https://llm.example.org"
                className="proxy-url-field"
              />
            </div>

            <div className="proxy-toggle">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={managedMode}
                  disabled={!managedMode && !managedServerUrl.trim()}
                  onChange={(e) => handleManagedModeChange(e.target.checked)}
                />
                <span>{t('Require organization sign-in')}</span>
              </label>
            </div>

            {managedMode && (
              <p className="setting-description">
                {managedUser
                  ? `${t('Signed in as')} ${managedUser}`
                  : t('Not signed in - the app will ask for sign-in on the next screen.')}
                {managedUser && (
                  <>
                    {' '}
                    <button className="clear-button" onClick={handleManagedSignOut}>
                      {t('Sign Out')}
                    </button>
                  </>
                )}
              </p>
            )}

            {managedMode && managedUser && managedModels.length > 0 && (
              <div className="appearance-row">
                <label htmlFor="managed-model-select">{t('Model')}</label>
                <select
                  id="managed-model-select"
                  value={managedModel}
                  onChange={(e) => handleManagedModelChange(e.target.value)}
                  className="model-dropdown"
                >
                  {managedModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          </SettingsGroup>

          <SettingsGroup title={t('History')} open={openGroups.history} onToggle={() => toggleGroup('history')}>
            <p className="setting-description">
              {t('Clear the Recent Projects list (Explorer) and recently opened files (Quick Open). Projects, chats, and settings are kept.')}
            </p>
            <button
              className="clear-button"
              onClick={handleClearHistory}
            >
              {historyCleared ? `✓ ${t('Cleared')}` : t('Clear Recent History')}
            </button>
            <p className="setting-description">
              {t('Delete saved AI chat conversations for all projects. Project files and settings are kept.')}
            </p>
            {confirmClearChatHistory ? (
              <div className="setting-actions">
                <button className="clear-button" onClick={handleClearChatHistory}>
                  {t('Confirm Clear')}
                </button>
                <button className="clear-button" onClick={() => setConfirmClearChatHistory(false)}>
                  {t('Cancel')}
                </button>
              </div>
            ) : (
              <button
                className="clear-button"
                onClick={() => setConfirmClearChatHistory(true)}
              >
                {chatHistoryCleared ? `✓ ${t('Cleared')}` : t('Clear All Chat History')}
              </button>
            )}
          </SettingsGroup>

          {/* Nothing needs a manual Save for Ollama - every setting there
              applies on change. The buttons only manage Gemini settings. */}
          {provider === 'gemini' && (
          <div className="setting-actions">
            <button 
              className="save-button" 
              onClick={handleSave}
              disabled={!apiKey.trim() || (selectedModel === 'custom' && !customModel.trim())}
            >
              {saved ? `✓ ${t('Saved')}` : t('Save Settings')}
            </button>
            {confirmClearApiKey ? (
              <>
                <button className="clear-button" onClick={handleClear}>
                  {t('Confirm Clear')}
                </button>
                <button className="clear-button" onClick={() => setConfirmClearApiKey(false)}>
                  {t('Cancel')}
                </button>
              </>
            ) : (
              <button 
                className="clear-button" 
                onClick={() => setConfirmClearApiKey(true)}
                disabled={!apiKey}
              >
                {t('Clear API Key')}
              </button>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Settings
