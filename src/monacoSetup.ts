// Bundle Monaco locally instead of loading it from cdn.jsdelivr.net.
// @monaco-editor/react's loader would otherwise fetch it from the CDN,
// which breaks offline use and widens the CSP.
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
// monaco-editor >=0.52 exports map "."/* to ./esm/vs/*.js, so drop the
// esm/vs prefix from worker paths.
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      default:
        return new editorWorker()
    }
  },
}

loader.config({ monaco })

// Organic Light editor theme - matches the muted warm-paper UI palette in
// index.css ([data-theme='quiet'])
monaco.editor.defineTheme('teaspoon-quiet', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#f7f3ea',
    'editor.foreground': '#4a463c',
    'editorLineNumber.foreground': '#a29a86',
    'editorLineNumber.activeForeground': '#6f695a',
    'editor.lineHighlightBackground': '#ede7d6',
    'editor.selectionBackground': '#d5e0d8',
    'editor.inactiveSelectionBackground': '#e2ddcd',
    'editorCursor.foreground': '#4a463c',
    'editorWhitespace.foreground': '#d9cfba',
    'editorWidget.background': '#efe9dc',
    'editorWidget.border': '#d9cfba',
    'minimap.background': '#f5f1e8',
    'diffEditor.insertedTextBackground': '#4e8a5533',
    'diffEditor.removedTextBackground': '#b3504033',
  },
})

// Muted Ocean editor theme - deep-sea palette in index.css ([data-theme='ocean'])
monaco.editor.defineTheme('teaspoon-ocean', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '8b9cc0' },
    { token: 'string', foreground: 'c9b183' },
    { token: 'number', foreground: 'c98a6e' },
    { token: 'comment', foreground: '5d7080', fontStyle: 'italic' },
    { token: 'type', foreground: '7fb8ac' },
    { token: 'identifier.function', foreground: '7fa8d8' },
  ],
  colors: {
    'editor.background': '#0a1b2a',
    'editor.foreground': '#a9bdd0',
    'editorLineNumber.foreground': '#4a5d6c',
    'editorLineNumber.activeForeground': '#5d7080',
    'editor.lineHighlightBackground': '#0e2233',
    'editor.selectionBackground': '#1d4a6b',
    'editor.inactiveSelectionBackground': '#13314a',
    'editorCursor.foreground': '#a9bdd0',
    'editorWhitespace.foreground': '#1c3a50',
    'editorWidget.background': '#0e2233',
    'editorWidget.border': '#1c3a50',
    'minimap.background': '#0e2233',
    'diffEditor.insertedTextBackground': '#5aa07a33',
    'diffEditor.removedTextBackground': '#c96a5a33',
  },
})

// Ancient Console editor theme - green-phosphor palette ([data-theme='console'])
monaco.editor.defineTheme('teaspoon-console', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'b0cf9e' },
    { token: 'string', foreground: 'c9b98a' },
    { token: 'number', foreground: 'd0a878' },
    { token: 'comment', foreground: '57745a', fontStyle: 'italic' },
    { token: 'type', foreground: '8fbf9f' },
    { token: 'identifier.function', foreground: 'a3c9a8' },
  ],
  colors: {
    'editor.background': '#0c2214',
    'editor.foreground': '#93b494',
    'editorLineNumber.foreground': '#47614a',
    'editorLineNumber.activeForeground': '#57745a',
    'editor.lineHighlightBackground': '#16301d',
    'editor.selectionBackground': '#1f4228',
    'editor.inactiveSelectionBackground': '#14301c',
    'editorCursor.foreground': '#93b494',
    'editorWhitespace.foreground': '#1e3823',
    'editorWidget.background': '#0d1a10',
    'editorWidget.border': '#1e3823',
    'minimap.background': '#0d1a10',
    'diffEditor.insertedTextBackground': '#7fae7233',
    'diffEditor.removedTextBackground': '#d08a6a33',
  },
})

// Walnut editor theme - dark wood with silvery nail-bright text
// ([data-theme='walnut'])
monaco.editor.defineTheme('teaspoon-walnut', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'd0a05f' },
    { token: 'string', foreground: 'b8c49a' },
    { token: 'number', foreground: 'c98d68' },
    { token: 'comment', foreground: '857262', fontStyle: 'italic' },
    { token: 'type', foreground: 'a8a39b' },
    { token: 'identifier.function', foreground: 'd8c9a8' },
  ],
  colors: {
    'editor.background': '#2e2119',
    'editor.foreground': '#c2c7cb',
    'editorLineNumber.foreground': '#6f6152',
    'editorLineNumber.activeForeground': '#857262',
    'editor.lineHighlightBackground': '#3a2b20',
    'editor.selectionBackground': '#4a3a2a',
    'editor.inactiveSelectionBackground': '#3a2c1f',
    'editorCursor.foreground': '#c2c7cb',
    'editorWhitespace.foreground': '#4a382a',
    'editorWidget.background': '#281c14',
    'editorWidget.border': '#4a382a',
    'minimap.background': '#281c14',
    'diffEditor.insertedTextBackground': '#8aa86a33',
    'diffEditor.removedTextBackground': '#d07a5a33',
  },
})

// Heritage editor theme - pale woodgrain, reddish-black groove text
// ([data-theme='heritage'])
monaco.editor.defineTheme('teaspoon-heritage', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7a4a2b' },
    { token: 'string', foreground: '6b5a34' },
    { token: 'number', foreground: '8a5a3a' },
    { token: 'comment', foreground: '8a7a66', fontStyle: 'italic' },
    { token: 'type', foreground: '4f3d2c' },
    { token: 'identifier.function', foreground: '5a4632' },
  ],
  colors: {
    'editor.background': '#e6d7bd',
    'editor.foreground': '#2b1d17',
    'editorLineNumber.foreground': '#a3937d',
    'editorLineNumber.activeForeground': '#8a7a66',
    'editor.lineHighlightBackground': '#dccdb0',
    'editor.selectionBackground': '#cdbb97',
    'editor.inactiveSelectionBackground': '#d6c7a9',
    'editorCursor.foreground': '#2b1d17',
    'editorWhitespace.foreground': '#b8a486',
    'editorWidget.background': '#dccdb0',
    'editorWidget.border': '#b8a486',
    'minimap.background': '#dccdb0',
    'diffEditor.insertedTextBackground': '#4e7a4533',
    'diffEditor.removedTextBackground': '#a0453533',
  },
})

// Resolved app theme -> Monaco theme name. Custom themes are registered
// above; light/dark fall back to Monaco's built-ins.
export const MONACO_THEME: Record<string, string> = {
  dark: 'vs-dark',
  light: 'vs',
  quiet: 'teaspoon-quiet',
  ocean: 'teaspoon-ocean',
  console: 'teaspoon-console',
  walnut: 'teaspoon-walnut',
  heritage: 'teaspoon-heritage',
}
