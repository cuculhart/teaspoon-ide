import { configService } from './configService'
import { geminiService } from './geminiService'
import { ollamaService } from './ollamaService'

// Model capabilities, resolved per provider+model. The UI and agent loop
// read these instead of branching on provider-id strings, so a new provider
// is one registry entry rather than scattered if/else.
export interface ModelCaps {
  streaming: boolean
  thinking?: 'unsupported' | 'optional' | 'always-on'
  promptVariant: 'full' | 'compact'
  historyWindow?: number
}

export interface ModelInfo {
  id: string
  name?: string
  // API-reported version string (e.g. "3.8") - used to demote
  // previous-generation models in the dropdown. Absent for Ollama.
  version?: string
}

export interface SendArgs {
  message: string
  context?: string
  history: Array<{ role: string; content: string }>
  onDelta?: (delta: string) => void
  signal?: AbortSignal
  model?: string
}

// 'main' transport = requests go through the main-process LLM relay so the
// API key never enters the renderer. 'renderer' = the service fetches
// itself (only for key-less providers like Ollama).
export interface ProviderDescriptor {
  id: string
  label: string
  transport: 'main' | 'renderer'
  secretKey?: string
  isConfigured(): boolean
  sendMessage(args: SendArgs): Promise<string>
  listModels?(): Promise<ModelInfo[]>
  capabilities(modelId: string): ModelCaps
  // The model id a run should use right now, and the label the chat
  // header shows for it (includes the provider prefix where useful).
  resolveModel(): string
  modelLabel(): string
}

const geminiProvider: ProviderDescriptor = {
  id: 'gemini',
  label: 'Gemini API (cloud)',
  transport: 'main',
  secretKey: 'gemini_api_key',
  isConfigured: () => geminiService.isConfigured(),
  sendMessage: (a) =>
    geminiService.sendMessage(a.message, a.context, a.history, a.signal, a.model),
  listModels: () => geminiService.listModels(),
  capabilities: (m) => geminiService.capabilities(m),
  resolveModel: () => geminiService.resolveModel(),
  modelLabel: () => geminiService.modelLabel(),
}

const ollamaProvider: ProviderDescriptor = {
  id: 'ollama',
  label: 'Ollama (local, offline)',
  transport: 'renderer',
  isConfigured: () => ollamaService.isConfigured(),
  sendMessage: (a) =>
    ollamaService.sendMessage(a.message, a.context, a.history, a.onDelta, a.signal, a.model),
  listModels: async () => (await ollamaService.listModels()).map((id) => ({ id })),
  capabilities: (m) => ollamaService.capabilities(m),
  resolveModel: () => configService.getOllamaModel(),
  modelLabel: () => `ollama:${configService.getOllamaModel()}`,
}

export const providers: ProviderDescriptor[] = [geminiProvider, ollamaProvider]

// Unknown ids (e.g. a stale LLM_PROVIDER value) fall back to the first
// registered provider instead of breaking the chat.
export function getProvider(id?: string): ProviderDescriptor {
  const pid = id ?? configService.getLlmProvider()
  return providers.find((p) => p.id === pid) ?? providers[0]
}
