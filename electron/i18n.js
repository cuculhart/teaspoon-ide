// Main-process counterpart of the renderer's i18nService: same
// English-source -> localized mapping, same lang/<code>.json files.
// The renderer pushes the selected language via the 'set-language' IPC
// (language itself is stored in its localStorage, which the main
// process cannot read), so menus, dialogs, and IPC error strings
// follow the UI language.

const fsSync = require('fs')
const path = require('path')
const { app } = require('electron')

let dict = {}

// Language files live in <resources>/lang in packaged builds and in
// <projectRoot>/lang during development, so users can add translations
// without rebuilding.
function langDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'lang')
    : path.join(app.getAppPath(), 'lang')
}

function loadLanguage(code) {
  dict = {}
  if (!code || code === 'en' || !/^[a-zA-Z0-9_-]+$/.test(code)) return
  try {
    dict = JSON.parse(fsSync.readFileSync(path.join(langDir(), `${code}.json`), 'utf-8'))
  } catch {
    // Missing/unreadable file - stay on English
  }
}

// English key -> localized string (falls back to the key itself)
function t(key) {
  return dict[key] ?? key
}

module.exports = { langDir, loadLanguage, t }
