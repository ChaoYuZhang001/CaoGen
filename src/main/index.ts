import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { sessionManager } from './sessionManager'
import { startRoutineScheduler, stopRoutineScheduler, computeNextRun } from './routineScheduler'
import { markRun } from './routineStore'
import { initAutoUpdater } from './updater'
import type { Routine } from '../shared/types'

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
    minWidth: 920,
    minHeight: 600,
    title: 'CaoGen',
    backgroundColor: '#0d0d0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
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
  return win
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

/** Routine 到点触发:起一个会话并自动发送 routine.prompt,随后记录本次运行并算下次 */
function runRoutine(routine: Routine): void {
  try {
    const meta = sessionManager.create({
      cwd: routine.projectCwd,
      model: routine.model || undefined,
      providerId: routine.providerId || undefined,
      budgetUsd: routine.budgetUsd,
      permissionMode: routine.permissionMode,
      title: `⏱ ${routine.name}`
    })
    // 起会话是异步 start();稍等 SDK init 后再发首条 prompt
    const prompt = routine.prompt
    setTimeout(() => {
      try {
        sessionManager.send(meta.id, prompt)
      } catch (err) {
        console.error('[caogen] routine 发送 prompt 失败:', err)
      }
    }, 1200)
  } catch (err) {
    console.error('[caogen] routine 触发起会话失败:', err)
  }
  const now = Date.now()
  const next = computeNextRun(routine.schedule, now)
  void markRun(join(app.getPath('userData'), 'routines'), routine.id, {
    ranAt: now,
    nextRunAt: next ?? undefined
  })
}

void app.whenReady().then(() => {
  sessionManager.init()
  registerIpc()
  createWindow()
  installApplicationMenu()
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
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopRoutineScheduler()
})

app.on('before-quit', () => {
  sessionManager.disposeAll()
})
