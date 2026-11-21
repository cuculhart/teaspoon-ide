import { configService } from './configService'
import { i18nService } from './i18nService'
import { APP_CONTEXT_PROMPT, AGENT_INSTRUCTIONS, NO_PROJECT_INSTRUCTIONS, hostOsName, hostOpenCommand } from './agentPrompt'
import { projectService } from './projectService'
import { extractResponseText, extractStreamDelta, extractUsage, generateContentPath, parseRetryDelaySeconds, streamGenerateContentPath } from './geminiRest'
import type { ModelCaps, ModelInfo, TokenUsage } from './providers'

// Sampling temperature used for agent-loop calls when the user has not
// set one - same rationale as Ollama's AGENT_DEFAULT_TEMPERATURE: model
// defaults (~1.0) cause drift and hallucinated details in tool loops.
const AGENT_DEFAULT_TEMPERATURE = 0.2
// Cap on the 429/503 wait. A server asking for more is treated like a
// hard quota error instead of stalling the turn.
const MAX_RETRY_WAIT_MS = 30000
const MAX_RATE_LIMIT_RETRIES = 2
// Streaming requests die when no chunk arrives for this long - the fixed
// timeout would cut legitimate long generations.
const STREAM_IDLE_TIMEOUT_MS = 45000

// Raised by relayOnce on a 429/503 so generate() can apply the backoff
// policy without scraping the error message for the status code.
class RateLimitedError extends Error {
  readonly seconds: number | null
  constructor(seconds: number | null, message: string) {
    super(message)
    this.name = 'RateLimitedError'
    this.seconds = seconds
  }
}

// Gemini via the main-process LLM relay: the renderer builds the request
// path and body, the main process attaches the stored credential and does
// the fetch. The API key is never present in the renderer.
export class GeminiService {
  private defaultModel = 'gemini-3.8-flash' // Latest stable model
  private timeout = 120000 // 2 minutes timeout
  private requestSeq = 0
  // Last model list seen - feeds capabilities() and maxOutputTokens.
  private modelCache = new Map<string, ModelInfo>()

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

  public capabilities(model: string): ModelCaps {
    const info = this.modelCache.get(model)
    return {
      // Until the model list is fetched, assume streaming works - nearly
      // every Gemini model supports streamGenerateContent, and a failed
      // stream falls back to generateContent once anyway. Note the live
      // API often omits 'streamGenerateContent' from
      // supportedGenerationMethods even though the endpoint works, so
      // 'generateContent' support is treated as stream-capable too.
      streaming: info?.generationMethods
        ? info.generationMethods.some(
            (m) => m === 'streamGenerateContent' || m === 'generateContent'
          )
        : true,
      thinking: this.thinkingKind(model) ? 'optional' : 'unsupported',
      promptVariant: 'full',
    }
  }

  // thinkingConfig accepts a level ('low'/'high') on Gemini 3 models but
  // a token budget on the 2.5 family - sending the wrong field errors.
  private thinkingKind(model: string): 'level' | 'budget' | null {
    if (/gemini-3/i.test(model)) return 'level'
    if (/gemini-2\.5/i.test(model)) return 'budget'
    return null
  }

  private thinkingConfigFor(model: string): Record<string, unknown> | undefined {
    const setting = configService.getGeminiThinking()
    if (!setting) return undefined
    const kind = this.thinkingKind(model)
    if (!kind) return undefined
    if (kind === 'level') {
      // Level models cannot fully disable thinking - 'off' maps to low.
      return { thinkingLevel: setting === 'high' ? 'high' : 'low' }
    }
    if (setting === 'off') return { thinkingBudget: 0 }
    if (setting === 'high') return { thinkingBudget: -1 } // dynamic
    return { thinkingBudget: 1024 }
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

  // maxOutputTokens from the API-reported output limit; unset models get
  // the old conservative ceiling's successor - 32768 - capped at 65536 so
  // a huge limit cannot produce an unbounded reply bill.
  private maxOutputTokensFor(model: string): number {
    return Math.min(this.modelCache.get(model)?.outputTokenLimit ?? 32768, 65536)
  }

  private generationConfigFor(model: string, agent?: boolean): Record<string, unknown> {
    const temperature = configService.getGeminiTemperature() ?? (agent ? AGENT_DEFAULT_TEMPERATURE : 0.7)
    const thinking = this.thinkingConfigFor(model)
    return {
      maxOutputTokens: this.maxOutputTokensFor(model),
      temperature,
      ...(thinking ? { thinkingConfig: thinking } : {}),
    }
  }

  // sleep that resolves early when the abort signal fires
  private abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const t = setTimeout(done, ms)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  // One generateContent/streamGenerateContent call through the relay.
  // Timeout and user cancel both abort the in-flight HTTP request in the
  // main process; stream chunks reset the renderer's idle timer.
  private async relayOnce(
    model: string,
    body: Record<string, unknown>,
    useStream: boolean,
    signal: AbortSignal | undefined,
    onDelta: ((delta: string) => void) | undefined,
  ): Promise<{ text: string; usage?: TokenUsage }> {
    const api = window.electronAPI
    if (!api?.llmRelay) throw new Error('Electron API not available')

    const requestId = `gemini-${Date.now()}-${++this.requestSeq}`
    const credential = configService.hasManagedSession() ? 'managed' : 'personal'
    let timedOut = false
    let full = ''
    let usage: TokenUsage | undefined
    const abort = () => api.llmRelayAbort(requestId)
    const armTimer = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        abort()
      }, ms)
    }
    let timer = setTimeout(() => {
      timedOut = true
      abort()
    }, this.timeout)
    signal?.addEventListener('abort', abort)
    const offChunk = useStream && api.onLlmRelayChunk
      ? api.onLlmRelayChunk(requestId, (chunk) => {
          armTimer(STREAM_IDLE_TIMEOUT_MS)
          const delta = extractStreamDelta(chunk)
          if (delta) {
            full += delta
            onDelta?.(delta)
          }
          const u = extractUsage(chunk)
          if (u) usage = u
        })
      : undefined
    try {
      const res = await api.llmRelay({
        credential,
        requestId,
        method: 'POST',
        path: useStream ? streamGenerateContentPath(model) : generateContentPath(model),
        body,
        stream: useStream,
      })
      if (!res.ok) {
        if (res.aborted) {
          throw new Error(timedOut ? `Request timeout after ${this.timeout}ms` : 'aborted')
        }
        // Retryable upstream pressure: honor RetryInfo / Retry-After,
        // capped, at most MAX_RATE_LIMIT_RETRIES times.
        const retryable = res.status === 429 || res.status === 503
        if (retryable) {
          const waitSec = parseRetryDelaySeconds(res.details, res.retryAfter)
          throw new RateLimitedError(waitSec, res.error || `HTTP ${res.status}`)
        }
        const err = new Error(res.error || `HTTP ${res.status}`) as Error & { status?: number }
        err.status = res.status
        throw err
      }
      if (res.streamed) {
        if (!full) throw new Error('Empty response from Gemini')
        return { text: full, usage }
      }
      // A proxy that ignores `stream` answered with plain JSON - the
      // transparent non-streaming fallback path.
      const u = extractUsage(res.json)
      if (u) usage = u
      return { text: extractResponseText(res.json), usage }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      offChunk?.()
    }
  }

  // One generateContent call through the relay, with the 429/503 backoff
  // loop and a one-shot streaming -> non-streaming fallback wrapped
  // around it.
  private async generate(
    model: string,
    contents: any[],
    systemInstruction: string,
    signal?: AbortSignal,
    onUsage?: (u: TokenUsage) => void,
    onDelta?: (delta: string) => void,
    agent?: boolean,
    onStatus?: (status: string) => void,
  ): Promise<string> {
    const makeBody = (extras: boolean): Record<string, unknown> => ({
      contents,
      generationConfig: this.generationConfigFor(model, agent),
      ...(extras && systemInstruction
        ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
        : {}),
    })
    let streamAllowed = !!onDelta && this.capabilities(model).streaming
    let extras = true
    let rateRetries = 0

    for (;;) {
      try {
        const { text, usage } = await this.relayOnce(model, makeBody(extras), streamAllowed, signal, onDelta)
        if (usage && onUsage) onUsage(usage)
        return text
      } catch (e) {
        if (e instanceof RateLimitedError) {
          if (signal?.aborted) throw new Error('aborted')
          const waitMs = Math.min((e.seconds ?? 5) * 1000, MAX_RETRY_WAIT_MS)
          if (rateRetries >= MAX_RATE_LIMIT_RETRIES || waitMs >= MAX_RETRY_WAIT_MS) {
            throw new Error(`${e.message} - ${i18nService.t('the model is rate limited or overloaded; wait a moment and try again')}`)
          }
          rateRetries++
          onStatus?.(i18nService.t('Rate limited - retrying…'))
          await this.abortableSleep(waitMs, signal)
          if (signal?.aborted) throw new Error('aborted')
          continue
        }
        if (signal?.aborted || (e instanceof Error && e.message === 'aborted')) throw e
        // A proxy that does not implement streamGenerateContent answers
        // with an ordinary HTTP error - retry once without `stream`.
        if (streamAllowed) {
          streamAllowed = false
          continue
        }
        // LiteLLM-class proxies may reject fields the upstream would
        // accept - drop the Gemini-only extras once and retry.
        if (extras && e instanceof Error && /systemInstruction|thinkingConfig/i.test(e.message)) {
          extras = false
          continue
        }
        throw e
      }
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
    const models = Array.isArray(res.models) ? res.models : []
    if (res.ok && models.length) {
      this.modelCache = new Map(models.map((m) => [m.id, m]))
    }
    return { ok: !!res.ok, status: res.status, models }
  }

  public async listModels(): Promise<ModelInfo[]> {
    return (await this.listModelsResult()).models
  }

  public async sendMessage(
    message: string,
    context?: string,
    history: Array<{role: string, content: string}> = [],
    signal?: AbortSignal,
    modelOverride?: string,
    onUsage?: (u: TokenUsage) => void,
    onDelta?: (delta: string) => void,
    agent?: boolean,
    onStatus?: (status: string) => void,
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(i18nService.t('Gemini API key not configured. Please set your API key in settings.'))
    }

    // Instructions live in systemInstruction so they no longer ride the
    // user turn - the API treats them as higher-priority context, and the
    // user role stays clean for logging/caching.
    const projectOpen = !!projectService.getCurrentProject()?.isOpen
    const systemInstruction =
      // Host-app identity so the model answers for THIS editor, not VS Code
      APP_CONTEXT_PROMPT +
      `\nThe app runs on ${hostOsName()}.` +
      (projectOpen
        ? ` To open a file/URL in the browser, emit "// RUN_COMMAND: ${hostOpenCommand()} <target>".\n`
        : '\n') +
      (projectOpen ? AGENT_INSTRUCTIONS : NO_PROJECT_INSTRUCTIONS)

    const prompt = context ? `Context:\n${context}\n\nUser message:\n${message}` : message

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
      return await this.generate(model, contents, systemInstruction, signal, onUsage, onDelta, agent, onStatus)
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
          return await this.generate(this.defaultModel, contents, systemInstruction, signal, onUsage, onDelta, agent, onStatus)
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
