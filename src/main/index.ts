import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { sessionManager } from './sessionManager'
import { disposeProjectIndexers } from './indexer'
import { startRoutineScheduler, stopRoutineScheduler } from './routineScheduler'
import { executeRoutine } from './routines/routine-executor'
import { stopIdeBridge, syncIdeBridgeFromSettings } from './ide/ide-bridge-manager'
import { initAutoUpdater } from './updater'
import { configureQuickbar, disposeQuickbar, registerQuickbarGlobalShortcut } from './quickbar'
import type { Routine } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let quitCleanupStarted = false
let trayTimer: NodeJS.Timeout | null = null

// 未打包运行时(dev / 直接 electron out/...)默认 userData 是共享的 "Electron" 目录。
// 测试脚本可通过 CAOGEN_USER_DATA_DIR 指向临时目录,避免污染真实 CaoGen 配置。
app.setName('CaoGen')
app.setPath('userData', process.env.CAOGEN_USER_DATA_DIR || join(app.getPath('appData'), 'CaoGen'))

/** 应用图标源文件;放置后自动生效(Windows/Linux 窗口图标 + 打包) */
function iconPath(): string | undefined {
  // 打包后 resources 随 app 一起分发;dev 时用仓库内的 resources/
  const candidates = [
    join(process.resourcesPath ?? '', 'icon.png'),
    join(__dirname, '../../resources/icon.png')
  ]
  return candidates.find((p) => p && existsSync(p))
}

function createWindow(): BrowserWindow {
  const icon = iconPath()
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 360,
    minHeight: 520,
    title: 'CaoGen',
    backgroundColor: '#0d0d0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  mainWindow = win
  win.on('close', (event) => {
    if (quitting || !hasRunningSessions()) return
    event.preventDefault()
    win.hide()
    updateTray()
  })
  return win
}

function hasRunningSessions(): boolean {
  return sessionManager.list().some((meta) => meta.status === 'starting' || meta.status === 'running')
}

function showMainWindow(): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  win.show()
  win.focus()
}

function updateTray(): void {
  if (!tray) return
  const runningCount = sessionManager
    .list()
    .filter((meta) => meta.status === 'starting' || meta.status === 'running').length
  tray.setToolTip(runningCount > 0 ? `CaoGen · ${runningCount} running` : 'CaoGen')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: runningCount > 0 ? `Running tasks: ${runningCount}` : 'No running tasks', enabled: false },
      { type: 'separator' },
      { label: 'Show CaoGen', click: showMainWindow },
      {
        label: 'New Session',
        click: () => {
          showMainWindow()
          sendMenuCommand('menu:new-session')
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function installTray(): void {
  if (tray) return
  const icon = iconPath()
  const image = icon ? nativeImage.createFromPath(icon) : nativeImage.createEmpty()
  tray = new Tray(image)
  tray.on('click', showMainWindow)
  updateTray()
  trayTimer = setInterval(updateTray, 5000)
}

function sendMenuCommand(channel: string, value?: unknown): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, value)
}

function installApplicationMenu(): void {
  const sessionItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, index) => ({
    label: `切换到会话 ${index + 1}`,
    accelerator: `CommandOrControl+${index + 1}`,
    click: () => sendMenuCommand('menu:select-session', index)
  }))
  const settingsItem: MenuItemConstructorOptions = {
    label: '设置',
    accelerator: 'CommandOrControl+,',
    click: () => sendMenuCommand('menu:settings')
  }

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settingsItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CommandOrControl+N',
          click: () => sendMenuCommand('menu:new-session')
        },
        ...(process.platform === 'darwin' ? [] : [{ type: 'separator' as const }, settingsItem]),
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: '搜索会话',
          accelerator: 'CommandOrControl+F',
          click: () => sendMenuCommand('menu:open-search')
        }
      ]
    },
    {
      label: '会话',
      submenu: [
        {
          label: '命令面板',
          accelerator: 'CommandOrControl+K',
          click: () => sendMenuCommand('menu:command-palette')
        },
        { type: 'separator' },
        ...sessionItems
      ]
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Routine 到点触发:统一走 executor,由 runner 写运行历史并推进 nextRunAt。 */
function runRoutine(routine: Routine, nextRunAt: number | null): void {
  void executeRoutine(join(app.getPath('userData'), 'routines'), routine, { nextRunAt }).catch((err) => {
    console.error('[caogen] routine execute failed:', err)
  })
}
void app.whenReady().then(async () => {
  await sessionManager.init()
  registerIpc()
  createWindow()
  configureQuickbar({ getMainWindow: () => mainWindow, showMainWindow })
  const quickbarState = registerQuickbarGlobalShortcut()
  if (!quickbarState.registered) {
    console.warn('[caogen] quickbar shortcut unavailable:', quickbarState.registrationError)
  }
  installTray()
  installApplicationMenu()
  await syncIdeBridgeFromSettings().catch((error) => {
    console.error('[caogen] IDE bridge start failed:', error)
  })
  // Routine 定时调度:每 30s 轮询,到点起会话执行(补齐"定时自动执行"承诺)
  startRoutineScheduler({
    rootDir: join(app.getPath('userData'), 'routines'),
    onTrigger: runRoutine
  })
  // 自动更新(打包环境查更新只通知不静默下载;dev/未装依赖降级 no-op)
  initAutoUpdater()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !hasRunningSessions()) app.quit()
})

app.on('will-quit', () => {
  disposeQuickbar()
})

app.on('before-quit', (event) => {
  quitting = true
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  event.preventDefault()
  if (trayTimer) {
    clearInterval(trayTimer)
    trayTimer = null
  }
  stopRoutineScheduler()
  // 退出前等待任务快照落盘,再释放项目索引 watcher/SQLite 句柄。
  void (async () => {
    await sessionManager.disposeAll()
    await stopIdeBridge()
    await disposeProjectIndexers()
  })()
    .catch((error) => {
      console.error('[caogen] quit cleanup failed:', error)
    })
    .finally(() => app.quit())
})
