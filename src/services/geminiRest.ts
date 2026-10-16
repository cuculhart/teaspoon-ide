// Pure helpers for talking to the Gemini REST API - extracted so node
// tests can exercise them without Electron (see e2e/gemini-rest.test.mjs).
// The main process owns credentials and the HTTP call; these functions
// only shape the request path and interpret the response.

export function generateContentPath(model: string): string {
  return `/v1beta/models/${encodeURIComponent(model)}:generateContent`
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
