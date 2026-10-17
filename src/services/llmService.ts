import { configService } from './configService'
import { getProvider } from './providers'

// Pins a request to the provider/model captured when the user hit Send.
// Without it, changing Settings mid-generation would silently retarget
// later agent-loop steps to the new provider/model.
export interface LlmPin {
  provider?: string
  model?: string
}

// Provider router: the UI talks to llmService, which looks the provider up
// in the registry (providers.ts) and delegates to it. All providers share
// the same sendMessage contract via their descriptor.
export const llmService = {
  isConfigured(): boolean {
    return getProvider().isConfigured()
  },

  sendMessage(
    message: string,
    context?: string,
    history: Array<{ role: string; content: string }> = [],
    onDelta?: (delta: string) => void,
    signal?: AbortSignal,
    pin?: LlmPin,
    agent?: boolean,
  ): Promise<string> {
    const provider = getProvider(pin?.provider ?? configService.getLlmProvider())
    return provider.sendMessage({ message, context, history, onDelta, signal, model: pin?.model, agent })
  },
}
