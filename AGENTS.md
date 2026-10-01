# Project conventions

## Writing

- `CHANGELOG.md` is English only. Do not include Japanese text (e.g. kana
  renderings of theme names).
- `README.ja.md` is the Japanese document; `readme.md` is English.

## Verification

- `npx tsc --noEmit -p .` — type check
- `npm run build:vite` — production build (large-chunk warning is expected)
