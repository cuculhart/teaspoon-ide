import { configService } from './configService'
import { i18nService } from './i18nService'
import { APP_CONTEXT_PROMPT, AGENT_INSTRUCTIONS, NO_PROJECT_INSTRUCTIONS, hostOsName, hostOpenCommand } from './agentPrompt'
import { projectService } from './projectService'
import { extractResponseText, generateContentPath } from './geminiRest'
import type { ModelCaps, ModelInfo } from './providers'

// Gemini via the main-process LLM relay: the renderer builds the request
// path and body, the main process attaches the stored credential and does
// the fetch. The API key is never present in the renderer.
export class GeminiService {
  private defaultModel = 'gemini-3.8-flash' // Latest stable model
  private maxTokens = 8192 // Token limit to prevent excessive usage
  private timeout = 120000 // 2 minutes timeout
  private requestSeq = 0

  private resolveModelId(override?: string): string {
    if (override) return override
    // An organization-issued session restricts the model list server-side
    const managed = configService.getManagedSession()
    if (managed?.model) return managed.model
    if (managed?.models?.length) return managed.models[0]
    const model = configService.getGeminiModel()
    if (model === 'custom') {
      const customModel = configService.getGeminiCustomModel()
      return customModel || this.defaultModel
    }
    return model || this.defaultModel
  }

  // Model id the next run should use (managed allowlist > user setting)
  public resolveModel(): string {
    return this.resolveModelId()
  }

  // Label shown in the chat header for the active model
  public modelLabel(): string {
    const managed = configService.getManagedSession()
    if (managed?.model) return managed.model
    const model = configService.getGeminiModel()
    return model === 'custom'
      ? configService.getGeminiCustomModel() || 'Custom'
      : model || this.defaultModel
  }

  public capabilities(_model: string): ModelCaps {
    return { streaming: false, promptVariant: 'full' }
  }

  // Translate LiteLLM/proxy errors into user-facing text under an
  // organization session. Returns null to keep the original message.
  private describeManagedError(errorMessage: string): string | null {
    if (!configService.hasManagedSession()) return null
    const m = errorMessage.toLowerCase()
    if (m.includes('budget')) {
      return i18nService.t('Your allotted usage budget has been fully used. It will reset automatically, or contact your administrator.')
    }
    // Upstream provider quota/billing cap (e.g. Google AI Studio monthly
    // spend limit) - this is the whole organization, not the user's slice.
    if (m.includes('resource_exhausted') || m.includes('quota') || m.includes('exhausted') || m.includes('billing')) {
      return i18nService.t('The organization usage cap has been reached. It resets at the start of the next billing period, or contact your administrator.')
    }
    if (m.includes('rate limit') || m.includes('rate_limit') || m.includes('429')) {
      return i18nService.t('Your allotted usage limit has been reached. Please wait a moment and try again.')
    }
    if (m.includes('not allowed') || m.includes('does not have access') || m.includes('forbidden')) {
      return i18nService.t('This model is not permitted by your organization. Check the model selection in Settings.')
    }
    return null
  }

  // One generateContent call through the relay. Timeout and user cancel
  // both abort the in-flight HTTP request in the main process.
  private async generate(model: string, contents: any[], signal?: AbortSignal): Promise<string> {
    const api = window.electronAPI
    if (!api?.llmRelay) throw new Error('Electron API not available')

    const requestId = `gemini-${Date.now()}-${++this.requestSeq}`
    const credential = configService.hasManagedSession() ? 'managed' : 'personal'
    let timedOut = false
    const abort = () => api.llmRelayAbort(requestId)
    const timer = setTimeout(() => {
      timedOut = true
      abort()
    }, this.timeout)
    signal?.addEventListener('abort', abort)
    try {
      const res = await api.llmRelay({
        credential,
        requestId,
        method: 'POST',
        path: generateContentPath(model),
        body: {
          contents,
          generationConfig: { maxOutputTokens: this.maxTokens, temperature: 0.7 },
        },
      })
      if (!res.ok) {
        if (res.aborted) {
          throw new Error(timedOut ? `Request timeout after ${this.timeout}ms` : 'aborted')
        }
        throw new Error(res.error || `HTTP ${res.status}`)
      }
      return extractResponseText(res.json)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  public isConfigured(): boolean {
    return configService.hasGeminiApiKey() || configService.hasManagedSession()
  }

  // Model list for the Settings dropdown - fetched through the relay so
  // it works for both the personal key and a managed (proxy) session.
  // listModelsResult also returns the HTTP status so the UI can flag a
  // stored-but-rejected key (401/403) instead of silently falling back.
  public async listModelsResult(): Promise<{ ok: boolean; status?: number; models: ModelInfo[] }> {
    const api = window.electronAPI
    if (!api?.llmListModels || !this.isConfigured()) return { ok: false, models: [] }
    const credential = configService.hasManagedSession() ? 'managed' : 'personal'
    const res = await api.llmListModels({ credential })
    return { ok: !!res.ok, status: res.status, models: Array.isArray(res.models) ? res.models : [] }
  }

  public async listModels(): Promise<ModelInfo[]> {
    return (await this.listModelsResult()).models
  }

  public async sendMessage(message: string, context?: string, history: Array<{role: string, content: string}> = [], signal?: AbortSignal, modelOverride?: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(i18nService.t('Gemini API key not configured. Please set your API key in settings.'))
    }

    let prompt = message
    if (context) {
      prompt = `Context:\n${context}\n\nUser message:\n${message}`
    }

    // Host-app identity so the model answers for THIS editor, not VS Code
    prompt += APP_CONTEXT_PROMPT
    const projectOpen = !!projectService.getCurrentProject()?.isOpen
    prompt += `\nThe app runs on ${hostOsName()}.`
    prompt += projectOpen
      ? ` To open a file/URL in the browser, emit "// RUN_COMMAND: ${hostOpenCommand()} <target>".\n`
      : '\n'

    // Add instruction for file operations using simple commands - or warn
    // that they are unavailable when no project is open
    prompt += projectOpen ? AGENT_INSTRUCTIONS : NO_PROJECT_INSTRUCTIONS

    // Build conversation history for Gemini
    const contents = []

    for (const msg of history) {
      if (msg.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] })
      } else if (msg.role === 'assistant') {
        contents.push({ role: 'model', parts: [{ text: msg.content }] })
      }
    }

    contents.push({ role: 'user', parts: [{ text: prompt }] })

    const model = this.resolveModelId(modelOverride)
    try {
      return await this.generate(model, contents, signal)
    } catch (error) {
      console.error('Gemini API error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const managedError = this.describeManagedError(errorMessage)
      if (managedError) throw new Error(managedError)

      // Check if it's a timeout error
      if (errorMessage.includes('timeout')) {
        throw new Error(i18nService.t('Request timed out. The AI response took too long. Try with a simpler prompt or check your internet connection.'))
      }

      // Check if it's a model not found error and try fallback.
      // Skipped in managed mode: the organization controls the model list,
      // and the fallback must not rewrite the personal model setting.
      if (!configService.hasManagedSession() && (errorMessage.includes('not found') || errorMessage.includes('is not supported'))) {
        const currentModel = this.resolveModelId()
        console.log(`Model '${currentModel}' not available, trying fallback...`)
        configService.set('GEMINI_MODEL', this.defaultModel)
        try {
          return await this.generate(this.defaultModel, contents, signal)
        } catch (fallbackError) {
          // Restore original model setting
          configService.set('GEMINI_MODEL', currentModel)
          throw new Error(i18nService.t("Model '{model}' is not available. Please check your API key and model access.").replace('{model}', currentModel))
        }
      }

      throw new Error(`${i18nService.t('Failed to get response from Gemini')}: ${errorMessage}`)
    }
  }
}

export const geminiService = new GeminiService()
