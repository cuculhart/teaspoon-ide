import { configService, type OllamaThink } from './configService'
import { i18nService } from './i18nService'
import { projectService } from './projectService'
import {
  AGENT_SYSTEM_PROMPT,
  AGENT_SYSTEM_PROMPT_COMPACT,
  NO_PROJECT_SYSTEM_PROMPT,
  hostOsName,
  hostOpenCommand,
} from './agentPrompt'
import type { ModelCaps, TokenUsage } from './providers'

// Parameter count in billions parsed from the model tag ("qwen3:1.7b" -> 1.7);
// null when the tag carries no size marker.
function tagSizeBillions(model: string): number | null {
  const tag = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model
  const m = /(\d+(?:\.\d+)?)b/i.exec(tag)
  return m ? parseFloat(m[1]) : null
}

// Below ~3B params, long prompts and deep history degrade instruction-
// following, so small models get the compact prompt and only recent turns.
const SMALL_MODEL_MAX_B = 3
const SMALL_MODEL_HISTORY = 8

// Models whose "think" field accepts an effort level ("low"/"medium"/
// "high") rather than a plain boolean. Measured on Ollama 0.40: sending a
// level to a boolean-only model (qwen3.5) does NOT error - it silently
// turns thinking ON, so the level must be mapped back to a boolean here.
// Measured on Ollama 0.40: gemma4 also accepts a level string ("low"
// yields a shorter trace + normal content).
const THINK_LEVELS_RE = /gpt-oss|qwen3(?!\.5)|gemma4/i
// gpt-oss and gemma4 cannot disable thinking: "think": false produces a
// reasoning-only turn that surfaces here as an empty reply. Their real
// "off" is the lowest level.
const THINK_ALWAYS_ON_RE = /gpt-oss|gemma4/i

// Models that route tool intent to a channel Ollama reports as
// `thinking` instead of `content` (gpt-oss uses harmony "commentary"
// routing). For them an empty content after a thinking trace is
// structural and retrying cannot help. For other thinking models the
// same shape is just a transient empty reply - gemma4 attaches a
// thinking trace to EVERY response, so thinking proves nothing there -
// and it must stay retryable like a plain empty reply.
const CHANNEL_ROUTED_RE = /gpt-oss/i

// Sampling temperature used for agent-loop calls when the user has not
// set one. The measured failure modes of unset temperature (model
// default ~1.0) were language drift and hallucinated details.
export const AGENT_DEFAULT_TEMPERATURE = 0.2

// Thrown when /api/chat returns no reply text. `thinkingOnly` marks the
// channel-routed case: a gpt-oss-class model emitted reasoning but no
// content because it routes tool intent to a channel the text protocol
// cannot read - retrying cannot fix that, so the agent loop must not
// retry it. Other thinking models never set this flag; their
// reasoning-plus-empty replies are treated as transient empties.
export class OllamaEmptyResponseError extends Error {
  readonly thinkingOnly: boolean
  constructor(thinkingOnly: boolean) {
    super(
      thinkingOnly
        ? i18nService.t('The model produced reasoning but no reply text - it routes tool calls to a channel this protocol cannot read (e.g. gpt-oss) and is not supported by the text-command agent. Try a different model.')
        : i18nService.t('Ollama returned an empty response'),
    )
    this.name = 'OllamaEmptyResponseError'
    this.thinkingOnly = thinkingOnly
  }
}

// Local LLM via Ollama's native /api/chat endpoint. The OpenAI-compatible
// /v1 endpoint cannot carry options like num_thread, so the native API is
// used. Same text-based file-command protocol as the Gemini path.
class OllamaService {
  private getBaseUrl(): string {
    return (configService.getOllamaBaseUrl() || 'http://localhost:11434').replace(/\/+$/, '')
  }

  private getModel(): string {
    return configService.getOllamaModel() || 'gemma4:e4b'
  }

  isConfigured(): boolean {
    return true // local - no key needed; failures surface at request time
  }

  // Per-model capabilities - the agent loop/UI read these through the
  // provider registry instead of branching on the provider id.
  capabilities(model: string): ModelCaps {
    const small = (tagSizeBillions(model) ?? Infinity) < SMALL_MODEL_MAX_B
    return {
      streaming: true,
      thinking: THINK_ALWAYS_ON_RE.test(model) ? 'always-on' : 'optional',
      promptVariant: small ? 'compact' : 'full',
      historyWindow: small ? SMALL_MODEL_HISTORY : undefined,
    }
  }

  // One stored think value serves every model, but only some accept a
  // level string. Degrade to something the model understands instead of
  // sending an incompatible value:
  //   - level for a boolean-only model (qwen3.5, ...) -> nearest boolean
  //     ("low" -> off, "medium"/"high" -> on)
  //   - "off" for an always-reasoning model (gpt-oss) -> its minimum
  //     level, since false yields an empty reply
  private resolveThink(think: OllamaThink | undefined, model: string): OllamaThink | undefined {
    if (think === undefined) return undefined
    if (typeof think === 'boolean') {
      return think === false && THINK_ALWAYS_ON_RE.test(model) ? 'low' : think
    }
    return THINK_LEVELS_RE.test(model) ? think : think === 'low' ? false : true
  }

  // Model names installed in Ollama (for the Settings dropdown)
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/tags`)
      if (!res.ok) return []
      const data = await res.json()
      return (data.models || []).map((m: any) => m.name).filter(Boolean)
    } catch {
      return []
    }
  }

  async sendMessage(
    message: string,
    context?: string,
    history: Array<{ role: string; content: string }> = [],
    onDelta?: (delta: string) => void,
    signal?: AbortSignal,
    modelOverride?: string,
    agent?: boolean,
    onUsage?: (u: TokenUsage) => void,
  ): Promise<string> {
    const model = modelOverride || this.getModel()
    const caps = this.capabilities(model)
    const projectOpen = !!projectService.getCurrentProject()?.isOpen
    const systemPrompt = !projectOpen
      ? NO_PROJECT_SYSTEM_PROMPT
      : caps.promptVariant === 'compact'
        ? AGENT_SYSTEM_PROMPT_COMPACT
        : AGENT_SYSTEM_PROMPT

    // Name the host OS and its browser opener explicitly - small models told
    // "pick the opener for your OS" tend to list all three instead of acting.
    const osNote = projectOpen
      ? `The app runs on ${hostOsName()}. To open a file/URL in the browser, emit "// RUN_COMMAND: ${hostOpenCommand()} <target>".`
      : `The app runs on ${hostOsName()}.`

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: `${systemPrompt.trim()}\n\n${osNote}` },
    ]

    for (const msg of caps.historyWindow ? history.slice(-caps.historyWindow) : history) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content })
      }
    }

    messages.push({
      role: 'user',
      content: context ? `Context:\n${context}\n\nUser message:\n${message}` : message,
    })

    const numThread = configService.getOllamaNumThread()
    const numCtx = configService.getOllamaNumCtx()
    // User setting always wins; agent-loop calls fall back to a low
    // default since measured runs showed unset temperature (model
    // default ~1.0) causes drift/hallucination. Plain chat stays at the
    // model default when unset.
    const temperature = configService.getOllamaTemperature() ?? (agent ? AGENT_DEFAULT_TEMPERATURE : undefined)
    const think = this.resolveThink(configService.getOllamaThink(), model)

    const options = {
      ...(numThread ? { num_thread: numThread } : {}),
      ...(numCtx ? { num_ctx: numCtx } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    }

    let res: Response
    try {
      res = await fetch(`${this.getBaseUrl()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: !!onDelta,
          ...(Object.keys(options).length ? { options } : {}),
          ...(think !== undefined ? { think } : {}),
        }),
        signal,
      })
    } catch (error: any) {
      throw new Error(
        `${i18nService.t('Cannot reach Ollama at {url} - is Ollama running?').replace('{url}', this.getBaseUrl())} (${error.message || error})`,
      )
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${i18nService.t('Ollama error')} ${res.status}: ${body.slice(0, 300) || res.statusText}`)
    }

    const emitUsage = (d: any) => {
      if (!onUsage || !d) return
      const input = typeof d.prompt_eval_count === 'number' ? d.prompt_eval_count : undefined
      const output = typeof d.eval_count === 'number' ? d.eval_count : undefined
      if (input !== undefined || output !== undefined) onUsage({ input, output })
    }

    if (!onDelta || !res.body) {
      const data = await res.json()
      const text = data?.message?.content
      if (typeof text !== 'string' || !text) {
        const thinking = data?.message?.thinking
        throw new OllamaEmptyResponseError(
          typeof thinking === 'string' && thinking.length > 0 && CHANNEL_ROUTED_RE.test(model),
        )
      }
      emitUsage(data)
      return text
    }

    // NDJSON stream: one {json} object per line, terminated by done:true.
    // Thinking-type models put their trace in message.thinking - we only
    // surface message.content (the user-facing reply).
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    let sawThinking = false
    let done = false
    while (!done) {
      const { done: eof, value } = await reader.read()
      if (eof) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const obj = JSON.parse(line)
          const piece = obj?.message?.content
          if (typeof piece === 'string' && piece) {
            full += piece
            onDelta(piece)
          }
          if (typeof obj?.message?.thinking === 'string' && obj.message.thinking) {
            sawThinking = true
          }
          // The terminal chunk carries the run's token counts.
          if (obj?.done) {
            done = true
            emitUsage(obj)
          }
        } catch {
          // ignore malformed NDJSON chunk
        }
      }
    }
    if (!full) {
      throw new OllamaEmptyResponseError(sawThinking && CHANNEL_ROUTED_RE.test(model))
    }
    return full
  }
}

export const ollamaService = new OllamaService()
