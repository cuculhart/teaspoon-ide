import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'tighten-csp-for-production',
      transformIndexHtml: {
        order: 'post',
        // Dev needs 'unsafe-inline'/ws for HMR; the packaged build gets a
        // strict CSP instead (Monaco is bundled, no CDN access needed).
        handler(html, ctx) {
          if (ctx.server) return html
          return html.replace(
            /content="default-src[^"]*"/,
            `content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' http://localhost:* https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'"`,
          )
        },
      },
    },
  ],
  base: './',
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
