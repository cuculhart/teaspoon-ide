import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({
  gfm: true,
  breaks: true,
})

// Markdown -> sanitized HTML fragment (safe to inject into the DOM)
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string
  return DOMPurify.sanitize(html)
}

// Styles shared by the in-app preview and the exported PDF document.
// Selectors are scoped under .markdown-body so they can be reused in both.
export const MARKDOWN_CSS = `
.markdown-body {
  font-family: var(--ui-font-family, 'Segoe UI', 'Yu Gothic', sans-serif);
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary, #24292f);
  word-wrap: break-word;
  /* Parents like .message-text use pre-wrap for plain text - rendered
     HTML must not inherit it or source newlines double-render */
  white-space: normal;
}
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  margin: 1.2em 0 0.5em;
  font-weight: 600;
  line-height: 1.3;
}
.markdown-body h1 { font-size: 1.8em; border-bottom: 1px solid var(--border-color, #d0d7de); padding-bottom: 0.3em; }
.markdown-body h2 { font-size: 1.4em; border-bottom: 1px solid var(--border-color, #d0d7de); padding-bottom: 0.2em; }
.markdown-body h3 { font-size: 1.15em; }
.markdown-body p { margin: 0.6em 0; }
.markdown-body a { color: var(--accent, #0969da); }
.markdown-body code {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.9em;
  background: rgba(128, 128, 128, 0.15);
  padding: 0.15em 0.4em;
  border-radius: 4px;
}
.markdown-body pre {
  background: rgba(128, 128, 128, 0.12);
  border: 1px solid var(--border-color, #d0d7de);
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
}
.markdown-body pre code {
  background: none;
  padding: 0;
}
.markdown-body blockquote {
  margin: 0.8em 0;
  padding: 0 1em;
  color: var(--text-secondary, #57606a);
  border-left: 3px solid var(--border-color, #d0d7de);
}
.markdown-body ul, .markdown-body ol { padding-left: 2em; }
.markdown-body table {
  border-collapse: collapse;
  margin: 0.8em 0;
}
.markdown-body th, .markdown-body td {
  border: 1px solid var(--border-color, #d0d7de);
  padding: 6px 12px;
}
.markdown-body th { background: rgba(128, 128, 128, 0.12); }
.markdown-body img { max-width: 100%; }
.markdown-body hr {
  border: none;
  border-top: 1px solid var(--border-color, #d0d7de);
  margin: 1.5em 0;
}
`

// Wrap a rendered fragment in a standalone HTML document (for PDF export)
export function markdownDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${MARKDOWN_CSS}</style>
</head>
<body class="markdown-body">
${bodyHtml}
</body>
</html>`
}
