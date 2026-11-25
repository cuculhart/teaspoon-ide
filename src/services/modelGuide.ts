// Recommended num_ctx per known model family (v1.2.0, backlog L9).
// Conservative on purpose: only entries where a larger window is known
// to matter for agent loops are listed, and unknown models get no
// guidance rather than a wrong suggestion.
const NUM_CTX_GUIDE: { match: RegExp; ctx: number }[] = [
  // gemma4 family: thinking is always on, so agent loops burn context on
  // top of the reasoning trace - the measured working value is 16384.
  { match: /^gemma4:/i, ctx: 16384 },
]

export function recommendedNumCtxForModel(model: string): number | undefined {
  const name = model.trim()
  if (!name) return undefined
  return NUM_CTX_GUIDE.find((g) => g.match.test(name))?.ctx
}
