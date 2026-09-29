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

// Quiet Light editor theme - matches the muted warm-paper UI palette in
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
