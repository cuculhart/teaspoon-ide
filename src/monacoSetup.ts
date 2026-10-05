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

// Rich Wine editor theme - wine-dark bg, silvery text, copper keywords
// and golds; mauve functions keep red out of the code ([data-theme='wine'])
monaco.editor.defineTheme('teaspoon-wine', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'e07b3f' },
    { token: 'string', foreground: 'f0a85d' },
    { token: 'number', foreground: 'f5ca93' },
    { token: 'comment', foreground: '5e3b43', fontStyle: 'italic' },
    { token: 'type', foreground: 'e2e8f0' },
    { token: 'identifier.function', foreground: 'b48ead' },
  ],
  colors: {
    'editor.background': '#1e0a0d',
    'editor.foreground': '#cbd1d6',
    'editorLineNumber.foreground': '#6e4a52',
    'editorLineNumber.activeForeground': '#8a6268',
    'editor.lineHighlightBackground': '#261114',
    'editor.selectionBackground': '#4d2430',
    'editor.inactiveSelectionBackground': '#331a1e',
    'editorCursor.foreground': '#cbd1d6',
    'editorWhitespace.foreground': '#4a2228',
    'editorWidget.background': '#261114',
    'editorWidget.border': '#4a2228',
    'minimap.background': '#261114',
    'diffEditor.insertedTextBackground': '#7fa06a33',
    'diffEditor.removedTextBackground': '#c96a5a33',
  },
})

// Violet Fizz editor theme - violet-cocktail bg, neon-blue keywords,
// moon-yellow strings ([data-theme='fizz'])
monaco.editor.defineTheme('teaspoon-fizz', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '3a86ff' },
    { token: 'string', foreground: 'ffbe0b' },
    { token: 'number', foreground: 'd14fa0' },
    { token: 'comment', foreground: '6b5b85', fontStyle: 'italic' },
    { token: 'type', foreground: '9bf6ff' },
    { token: 'identifier.function', foreground: 'd4a5ff' },
  ],
  colors: {
    'editor.background': '#251c35',
    'editor.foreground': '#ece6f0',
    'editorLineNumber.foreground': '#6b5b85',
    'editorLineNumber.activeForeground': '#8f80a6',
    'editor.lineHighlightBackground': '#2c2140',
    'editor.selectionBackground': '#4a3a6e',
    'editor.inactiveSelectionBackground': '#33254a',
    'editorCursor.foreground': '#ece6f0',
    'editorWhitespace.foreground': '#3f2f5c',
    'editorWidget.background': '#1e162b',
    'editorWidget.border': '#3f2f5c',
    'minimap.background': '#1e162b',
    'diffEditor.insertedTextBackground': '#6fcf9733',
    'diffEditor.removedTextBackground': '#ff6b7f33',
  },
})

// Otegami editor theme - washi paper, soot-ink text, vermilion accents
// ([data-theme='otegami'])
monaco.editor.defineTheme('teaspoon-otegami', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '165e83', fontStyle: 'bold' },
    { token: 'string', foreground: 'a04f14' },
    { token: 'number', foreground: 'a08800' },
    { token: 'comment', foreground: 'a39e93', fontStyle: 'italic' },
    { token: 'type', foreground: '3b4747' },
    { token: 'identifier.function', foreground: '745399' },
  ],
  colors: {
    'editor.background': '#f3eeda',
    'editor.foreground': '#2b2b2b',
    'editorLineNumber.foreground': '#a39e93',
    'editorLineNumber.activeForeground': '#8a8272',
    'editor.lineHighlightBackground': '#ece5d0',
    'editor.selectionBackground': '#dcd2b8',
    'editor.inactiveSelectionBackground': '#e6dfc9',
    'editorCursor.foreground': '#2b2b2b',
    'editorWhitespace.foreground': '#d8ceba',
    'editorWidget.background': '#ede9dc',
    'editorWidget.border': '#d8ceba',
    'minimap.background': '#ede9dc',
    'diffEditor.insertedTextBackground': '#5e7a4633',
    'diffEditor.removedTextBackground': '#a8322633',
  },
})

// Soda Float editor theme - mid sky-blue soda with ink text and pale
// foam colors ([data-theme='float'])
monaco.editor.defineTheme('teaspoon-float', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '8e24aa', fontStyle: 'bold' },
    { token: 'string', foreground: 'e6f5e0' },
    { token: 'number', foreground: 'ffc9e8' },
    { token: 'comment', foreground: '2f5464', fontStyle: 'italic' },
    { token: 'type', foreground: '6d3a26' },
    { token: 'identifier.function', foreground: '1a4fd8' },
  ],
  colors: {
    'editor.background': '#75b1de',
    'editor.foreground': '#121416',
    'editorLineNumber.foreground': '#4a6a7a',
    'editorLineNumber.activeForeground': '#2f5464',
    'editor.lineHighlightBackground': '#66a2d1',
    'editor.selectionBackground': '#5793c4',
    'editor.inactiveSelectionBackground': '#66a2d1',
    'editorCursor.foreground': '#121416',
    'editorWhitespace.foreground': '#5a97c2',
    'editorWidget.background': '#66a2d1',
    'editorWidget.border': '#5a97c2',
    'minimap.background': '#66a2d1',
    'diffEditor.insertedTextBackground': '#1e7a4a33',
    'diffEditor.removedTextBackground': '#b0341f33',
  },
})

// Modern Syntax eXtensible (MSX) editor theme - saturated MSX-blue with
// white text and modernized 16-color brights ([data-theme='msx'])
monaco.editor.defineTheme('teaspoon-msx', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'ffe066' },
    { token: 'string', foreground: 'dda868' },
    { token: 'number', foreground: 'ff8ade' },
    { token: 'comment', foreground: '8fa0d8', fontStyle: 'italic' },
    { token: 'type', foreground: 'b9b4ff' },
    { token: 'identifier.function', foreground: '66e0ff' },
  ],
  colors: {
    'editor.background': '#2438d8',
    'editor.foreground': '#ffffff',
    'editorLineNumber.foreground': '#7f92cc',
    'editorLineNumber.activeForeground': '#a8b8f0',
    'editor.lineHighlightBackground': '#2a3ad0',
    'editor.selectionBackground': '#3d50e8',
    'editor.inactiveSelectionBackground': '#1d2cb8',
    'editorCursor.foreground': '#ffffff',
    'editorWhitespace.foreground': '#4a5ce0',
    'editorWidget.background': '#1d2cb8',
    'editorWidget.border': '#4a5ce0',
    'minimap.background': '#1d2cb8',
    'diffEditor.insertedTextBackground': '#7ef0a833',
    'diffEditor.removedTextBackground': '#ff7a8a33',
  },
})

// Chaya editor theme - tea-field green, new-leaf keywords, jade
// functions, plum-blossom numbers ([data-theme='chaya'])
monaco.editor.defineTheme('teaspoon-chaya', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '8fd18a' },
    { token: 'string', foreground: 'e0cf8f' },
    { token: 'number', foreground: 'e08fb0' },
    { token: 'comment', foreground: '5f7a68', fontStyle: 'italic' },
    { token: 'type', foreground: 'c9976a' },
    { token: 'identifier.function', foreground: '6fd0b0' },
  ],
  colors: {
    'editor.background': '#11241b',
    'editor.foreground': '#e6ecdd',
    'editorLineNumber.foreground': '#5f7a68',
    'editorLineNumber.activeForeground': '#7a927f',
    'editor.lineHighlightBackground': '#182e22',
    'editor.selectionBackground': '#2c4a38',
    'editor.inactiveSelectionBackground': '#1c3527',
    'editorCursor.foreground': '#e6ecdd',
    'editorWhitespace.foreground': '#2c4a38',
    'editorWidget.background': '#0d1c15',
    'editorWidget.border': '#2c4a38',
    'minimap.background': '#0d1c15',
    'diffEditor.insertedTextBackground': '#6fa86033',
    'diffEditor.removedTextBackground': '#c96a5433',
  },
})

// Coquette editor theme - pale blush, plum-chocolate text, satin-rose
// keywords ([data-theme='coquette'])
monaco.editor.defineTheme('teaspoon-coquette', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'b23a66' },
    { token: 'string', foreground: '8a7040' },
    { token: 'number', foreground: 'd4763a' },
    { token: 'comment', foreground: 'b89aa4', fontStyle: 'italic' },
    { token: 'type', foreground: '3f7f8c' },
    { token: 'identifier.function', foreground: '7a4f9e' },
  ],
  colors: {
    'editor.background': '#fdf3f6',
    'editor.foreground': '#5c3a45',
    'editorLineNumber.foreground': '#b89aa4',
    'editorLineNumber.activeForeground': '#a07a88',
    'editor.lineHighlightBackground': '#f8e4ec',
    'editor.selectionBackground': '#f2d4e0',
    'editor.inactiveSelectionBackground': '#f8e4ec',
    'editorCursor.foreground': '#5c3a45',
    'editorWhitespace.foreground': '#e6c3d1',
    'editorWidget.background': '#f8e4ec',
    'editorWidget.border': '#e6c3d1',
    'minimap.background': '#f8e4ec',
    'diffEditor.insertedTextBackground': '#4e8a5533',
    'diffEditor.removedTextBackground': '#c92a4533',
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
  wine: 'teaspoon-wine',
  fizz: 'teaspoon-fizz',
  otegami: 'teaspoon-otegami',
  float: 'teaspoon-float',
  msx: 'teaspoon-msx',
  chaya: 'teaspoon-chaya',
  coquette: 'teaspoon-coquette',
}
