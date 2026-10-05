import { configService } from './configService'
import { i18nService } from './i18nService'
import { projectService } from './projectService'
import {
  AGENT_SYSTEM_PROMPT,
  AGENT_SYSTEM_PROMPT_COMPACT,
  NO_PROJECT_SYSTEM_PROMPT,
  hostOsName,
  hostOpenCommand,
} from './agentPrompt'

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

// Local LLM via Ollama's OpenAI-compatible endpoint (no extra deps).
// Same text-based file-command protocol as the Gemini path.
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
  ): Promise<string> {
    const model = modelOverride || this.getModel()
    const isSmall = (tagSizeBillions(model) ?? Infinity) < SMALL_MODEL_MAX_B
    const projectOpen = !!projectService.getCurrentProject()?.isOpen
    const systemPrompt = !projectOpen
      ? NO_PROJECT_SYSTEM_PROMPT
      : isSmall
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

    for (const msg of isSmall ? history.slice(-SMALL_MODEL_HISTORY) : history) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content })
      }
    }

    messages.push({
      role: 'user',
      content: context ? `Context:\n${context}\n\nUser message:\n${message}` : message,
    })

    let res: Response
    try {
      res = await fetch(`${this.getBaseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: !!onDelta,
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

    if (!onDelta || !res.body) {
      const data = await res.json()
      const text = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text) {
        throw new Error(i18nService.t('Ollama returned an empty response'))
      }
      return text
    }

    // SSE stream: `data: {json}` lines terminated by `data: [DONE]`.
    // Thinking-type models put their trace in delta.reasoning - we only
    // surface delta.content (the user-facing reply).
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    let done = false
    while (!done) {
      const { done: eof, value } = await reader.read()
      if (eof) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          done = true
          break
        }
        try {
          const piece = JSON.parse(payload)?.choices?.[0]?.delta?.content
          if (typeof piece === 'string' && piece) {
            full += piece
            onDelta(piece)
          }
        } catch {
          // ignore malformed SSE chunk
        }
      }
    }
    if (!full) {
      throw new Error(i18nService.t('Ollama returned an empty response'))
    }
    return full
  }
}

export const ollamaService = new OllamaService()
