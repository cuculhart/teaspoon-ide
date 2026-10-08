const path = require('path')
const fsSync = require('fs')
const { setupIpcHandlers, registerAllowedRoot } = require('./ipcHandlers')
const i18n = require('./i18n')

let mainWindow = null

// Folder path passed via CLI arg (e.g. dropping a folder on Teaspoon.exe).
// Packaged: argv[1..] are user args; dev: argv[0]=electron, argv[1]=app dir.
function extractArgFolder(argv) {
  const { app } = require('electron')
  const args = app.isPackaged ? argv.slice(1) : argv.slice(2)
  for (const arg of args) {
    try {
      if (!arg.startsWith('-') && fsSync.statSync(arg).isDirectory()) {
        return path.resolve(arg)
      }
    } catch (e) {
      // not a readable path - skip
    }
  }
  return null
}

let pendingFolderArg = extractArgFolder(process.argv)
// A folder handed to the app via CLI / exe drop is user-consented - let the
// filesystem IPCs touch it once the renderer opens it.
if (pendingFolderArg) registerAllowedRoot(pendingFolderArg)

function sendFolderArg() {
  if (pendingFolderArg && mainWindow) {
    mainWindow.webContents.send('open-project-path', pendingFolderArg)
    pendingFolderArg = null
  }
}

function sendMenuAction(action) {
  if (mainWindow) {
    mainWindow.webContents.send('menu-action', action)
  }
}

function buildMenu() {
  const { Menu, dialog } = require('electron')
  const t = i18n.t

  const template = [
    // macOS application menu
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: t('File'),
      submenu: [
        {
          label: t('Open Project...'),
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('open-project'),
        },
        {
          label: t('Clone Repository...'),
          click: () => sendMenuAction('clone-project'),
        },
        {
          label: t('New Project...'),
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => sendMenuAction('new-project'),
        },
        {
          label: t('Open Project Folder'),
          click: () => sendMenuAction('open-project-folder'),
        },
        { type: 'separator' },
        {
          label: t('New File'),
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new-file'),
        },
        {
          label: t('New Folder'),
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => sendMenuAction('new-folder'),
        },
        { type: 'separator' },
        {
          label: t('Quick Open...'),
          accelerator: 'CmdOrCtrl+P',
          click: () => sendMenuAction('quick-open'),
        },
        { type: 'separator' },
        {
          label: t('Save'),
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuAction('save-file'),
        },
        {
          label: t('Export Markdown to PDF...'),
          click: () => sendMenuAction('export-pdf'),
        },
        {
          label: t('Export Markdown to HTML...'),
          click: () => sendMenuAction('export-html'),
        },
        { type: 'separator' },
        {
          label: t('Close Project'),
          click: () => sendMenuAction('close-project'),
        },
        { type: 'separator' },
        { role: 'quit', label: t('Exit') },
      ],
    },
    {
      label: t('Edit'),
      submenu: [
        {
          label: t('Undo'),
          accelerator: 'CmdOrCtrl+Z',
          click: () => sendMenuAction('undo'),
        },
        {
          label: t('Redo'),
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => sendMenuAction('redo'),
        },
        { type: 'separator' },
        { role: 'cut', label: t('Cut') },
        { role: 'copy', label: t('Copy') },
        { role: 'paste', label: t('Paste') },
        { role: 'selectAll', label: t('Select All') },
      ],
    },
    {
      label: t('View'),
      submenu: [
        { role: 'reload', label: t('Reload') },
        { role: 'forceReload', label: t('Force Reload') },
        { role: 'toggleDevTools', label: t('Toggle Developer Tools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('Actual Size') },
        { role: 'zoomIn', label: t('Zoom In') },
        { role: 'zoomOut', label: t('Zoom Out') },
        { type: 'separator' },
        {
          label: t('Toggle Terminal'),
          accelerator: 'CmdOrCtrl+`',
          click: () => sendMenuAction('toggle-terminal'),
        },
        {
          label: t('Toggle Chat Focus'),
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => sendMenuAction('toggle-chat-focus'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('Toggle Full Screen') },
      ],
    },
    {
      label: t('Window'),
      submenu: [
        { role: 'minimize', label: t('Minimize') },
        { role: 'close', label: t('Close Window') },
      ],
    },
    {
      label: t('Help'),
      submenu: [
        {
          label: t('About Teaspoon IDE'),
          click: () => sendMenuAction('about'),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow() {
  const { BrowserWindow } = require('electron')

  mainWindow = new BrowserWindow({
    title: 'Teaspoon IDE',
    width: 1400,
    height: 900,
    // Windows uses the exe icon; this matters on Linux
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (app.isPackaged) {
    // Packaged build: load the bundled renderer produced by `vite build`
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  } else {
    // In development, load from Vite dev server (try common ports)
    const ports = [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182, 5183, 5184, 5185, 5186, 5187, 5188, 5189, 5190]
    let loaded = false
    for (const port of ports) {
      try {
        await mainWindow.loadURL(`http://localhost:${port}`)
        loaded = true
        console.log(`Loaded from port ${port}`)
        break
      } catch (e) {
        // Try next port
      }
    }

    if (!loaded) {
      console.error('Failed to load Vite dev server on any port')
    }
  }

  // Right-click context menu - Electron ships no default one, so without
  // this there is no way to copy selected chat text (Linux/Windows).
  const { Menu } = require('electron')
  mainWindow.webContents.on('context-menu', (e, params) => {
    const t = i18n.t
    const items = params.isEditable
      ? [
          { role: 'undo', label: t('Undo') }, { role: 'redo', label: t('Redo') }, { type: 'separator' },
          { role: 'cut', label: t('Cut') }, { role: 'copy', label: t('Copy') }, { role: 'paste', label: t('Paste') },
          { type: 'separator' }, { role: 'selectAll', label: t('Select All') },
        ]
      : params.selectionText.trim()
        ? [{ role: 'copy', label: t('Copy') }, { type: 'separator' }, { role: 'selectAll', label: t('Select All') }]
        : []
    if (items.length) Menu.buildFromTemplate(items).popup()
  })

  // Deliver the CLI folder arg (folder dropped on the exe) once loaded
  mainWindow.webContents.on('did-finish-load', sendFolderArg)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const { app } = require('electron')

// In packaged builds a main-process crash exits silently (no console).
// Log to a file and show a dialog so failures are diagnosable.
function reportFatalError(err) {
  const message = err && err.stack ? err.stack : String(err)
  try {
    const fs = require('fs')
    const os = require('os')
    fs.appendFileSync(
      path.join(os.tmpdir(), 'teaspoon-crash.log'),
      `${new Date().toISOString()}\n${message}\n\n`,
    )
  } catch (e) {
    // ignore logging failure
  }
  try {
    require('electron').dialog.showErrorBox('Teaspoon IDE failed to start', message)
  } catch (e) {
    // ignore dialog failure
  }
  app.exit(1)
}

process.on('uncaughtException', reportFatalError)
process.on('unhandledRejection', (reason) => reportFatalError(reason))

// Reuse the running instance when a folder is dropped on the exe again
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (event, argv) => {
    const folder = extractArgFolder(argv)
    if (folder) pendingFolderArg = folder
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      sendFolderArg()
    }
  })
}

app.whenReady().then(async () => {
  const { ipcMain } = require('electron')
  // Renderer pulls the pending CLI folder arg on mount (did-finish-load
  // can fire before React listeners are registered)
  ipcMain.handle('teaspoon:take-pending-folder', () => {
    const p = pendingFolderArg
    pendingFolderArg = null
    return p
  })

  // The renderer owns the language setting (localStorage) - it pushes
  // changes here so menus and main-process dialogs/error strings follow.
  ipcMain.on('set-language', (event, code) => {
    i18n.loadLanguage(code)
    buildMenu()
  })

  setupIpcHandlers()
  buildMenu()
  await createWindow()

  app.on('activate', async () => {
    const { BrowserWindow } = require('electron')
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
}).catch(reportFatalError)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
