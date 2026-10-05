import { configService } from './configService'
import { i18nService } from './i18nService'

// Organization (managed) mode client.
//
// Expected management-server contract:
//   POST {serverUrl}/api/login
//     request:  { "username": string, "password": string }
//     response: 200 { "api_key": string,          // required: key for the LLM proxy
//                     "proxy_url"?: string,       // defaults to serverUrl itself
//                     "display_name"?: string,    // shown in Settings
//                     "model"?: string,           // pins the model if present
//                     "models"?: string[],        // ids this key may use
//                     "expires_at"?: string|number } // ISO date or epoch s/ms
//     errors:   non-2xx, optionally { "error": string }
//
// The server is typically a thin wrapper that mints a LiteLLM virtual key
// (budget/rate/model limits live there), so the app never sees a real key.

export interface ManagedLoginResult {
  user?: string
}

const LOGIN_TIMEOUT_MS = 15000

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // epoch seconds vs milliseconds
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const asNum = Number(value)
    if (Number.isFinite(asNum) && value.trim() !== '') return parseExpiry(asNum)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

class ManagedService {
  // Throws Error with a user-facing message on failure.
  async login(serverUrl: string, username: string, password: string): Promise<ManagedLoginResult> {
    const base = serverUrl.trim().replace(/\/+$/, '')
    if (!base) throw new Error(i18nService.t('Server URL is not set'))

    let res: Response
    try {
      res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      })
    } catch {
      throw new Error(i18nService.t('Could not reach the server. Check the URL and your network connection.'))
    }

    let body: any = null
    try {
      body = await res.json()
    } catch {
      // non-JSON error body - handled below via res.ok check
    }

    if (!res.ok) {
      throw new Error(body?.error || `${i18nService.t('Sign-in failed')} (HTTP ${res.status})`)
    }
    if (!body?.api_key || typeof body.api_key !== 'string') {
      throw new Error(i18nService.t('The server did not issue an API key'))
    }

    const models = Array.isArray(body.models)
      ? body.models.filter((m: unknown) => typeof m === 'string')
      : undefined
    configService.setManagedSession({
      apiKey: body.api_key,
      proxyUrl: typeof body.proxy_url === 'string' && body.proxy_url ? body.proxy_url : base,
      user: typeof body.display_name === 'string' && body.display_name ? body.display_name : username.trim(),
      model: typeof body.model === 'string' ? body.model : undefined,
      models,
      expiresAt: parseExpiry(body.expires_at),
    })
    window.dispatchEvent(new Event('teaspoon:managed-changed'))
    window.dispatchEvent(new Event('teaspoon:llm-changed'))
    return { user: configService.getManagedUser() }
  }

  logout(): void {
    configService.clearManagedSession()
    window.dispatchEvent(new Event('teaspoon:managed-changed'))
    window.dispatchEvent(new Event('teaspoon:llm-changed'))
  }

  // Per-key spend/budget from the management server (proxies LiteLLM
  // /key/info). Returns null when not signed in or the server fails.
  async getUsage(): Promise<{ spend: number; maxBudget: number | null; resetAt?: string } | null> {
    const creds = configService.getManagedCredentials()
    const base = configService.getManagedServerUrl().trim().replace(/\/+$/, '')
    if (!creds || !base) return null
    try {
      const res = await fetch(`${base}/api/usage`, {
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return null
      const body = await res.json()
      return {
        spend: Number(body.spend) || 0,
        maxBudget: body.max_budget != null ? Number(body.max_budget) : null,
        resetAt: typeof body.budget_reset_at === 'string' ? body.budget_reset_at : undefined,
      }
    } catch {
      return null
    }
  }

  // Switch back to local use. The issued key is kept so re-enabling does
  // not force a fresh sign-in; use logout() to drop it for good.
  disable(): void {
    configService.setManagedMode(false)
    window.dispatchEvent(new Event('teaspoon:managed-changed'))
    window.dispatchEvent(new Event('teaspoon:llm-changed'))
  }
}

export const managedService = new ManagedService()
