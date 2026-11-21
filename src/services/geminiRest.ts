// Pure helpers for talking to the Gemini REST API - extracted so node
// tests can exercise them without Electron (see e2e/gemini-rest.test.mjs).
// The main process owns credentials and the HTTP call; these functions
// only shape the request path and interpret the response.

export function generateContentPath(model: string): string {
  return `/v1beta/models/${encodeURIComponent(model)}:generateContent`
}

// Server-sent events variant of the same endpoint. The relay accepts the
// query string as part of the path (it only checks leading "/", no ".."
// and no scheme), so the whole route can be expressed in one string.
export function streamGenerateContentPath(model: string): string {
  return `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
}

// Error message out of a Gemini error body ({error: {message}}) or raw
// text - fed into the managed-error translation in geminiService.
export function geminiErrorMessage(json: any, text: string): string {
  const m = json?.error?.message
  if (typeof m === 'string' && m) return m
  return text || 'Unknown error'
}

// Concatenate the text parts of the first candidate. Throws on a blocked
// or empty response so callers treat it like a request failure.
export function extractResponseText(json: any): string {
  const candidates = json?.candidates
  if (Array.isArray(candidates) && candidates.length > 0) {
    const text = (candidates[0]?.content?.parts ?? [])
      .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
    if (text) return text
  }
  const reason = json?.promptFeedback?.blockReason
  if (reason) throw new Error(`Response blocked: ${reason}`)
  throw new Error('Empty response from Gemini')
}

// Text carried by one SSE chunk (a GenerateContentResponse). Unlike
// extractResponseText this never throws - a mid-stream chunk may carry
// only usageMetadata or a finishReason with no parts.
export function extractStreamDelta(chunk: any): string {
  const parts = chunk?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
}

// usageMetadata rides the final stream chunk (and every non-streamed
// response). thoughtsTokenCount is billed output and folded into
// `output`; cachedContentTokenCount reports implicit-context-cache hits.
export function extractUsage(json: any): { input?: number; output?: number; cached?: number } | undefined {
  const u = json?.usageMetadata
  if (!u) return undefined
  const input = typeof u.promptTokenCount === 'number' ? u.promptTokenCount : undefined
  const output =
    (typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : 0) +
    (typeof u.thoughtsTokenCount === 'number' ? u.thoughtsTokenCount : 0)
  const cached = typeof u.cachedContentTokenCount === 'number' && u.cachedContentTokenCount > 0
    ? u.cachedContentTokenCount
    : undefined
  return { input, output: output || undefined, cached }
}

// google.rpc.RetryInfo in a 429/503 error body: details[] entries carry
// "@type": ".../RetryInfo" and "retryDelay": "Ns" / "N.Ns". Returns
// seconds, or null when absent/unparseable. A Retry-After header value
// (integer seconds) is accepted as a fallback.
export function parseRetryDelaySeconds(details: any, retryAfterHeader?: string): number | null {
  if (Array.isArray(details)) {
    for (const d of details) {
      const t = d?.['@type']
      if (typeof t === 'string' && t.endsWith('RetryInfo')) {
        const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d?.retryDelay ?? ''))
        if (m) return parseFloat(m[1])
      }
    }
  }
  if (retryAfterHeader) {
    const n = parseFloat(retryAfterHeader)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return null
}
