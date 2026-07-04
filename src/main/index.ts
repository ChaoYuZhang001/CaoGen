import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { sessionManager } from './sessionManager'
import { startRoutineScheduler, stopRoutineScheduler, computeNextRun } from './routineScheduler'
import { markRun } from './routineStore'
import type { Routine } from '../shared/types'

// 未打包运行时(dev / 直接 electron out/...)默认 userData 是共享的 "Electron" 目录
app.setName('CaoGen')
app.setPath('userData', join(app.getPath('appData'), 'CaoGen'))

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

/** Routine 到点触发:起一个会话并自动发送 routine.prompt,随后记录本次运行并算下次 */
function runRoutine(routine: Routine): void {
  try {
    const meta = sessionManager.create({
      cwd: routine.projectCwd,
      model: routine.model || undefined,
      providerId: routine.providerId || undefined,
      permissionMode: routine.permissionMode,
      title: `⏱ ${routine.name}`
    })
    // 起会话是异步 start();稍等 SDK init 后再发首条 prompt
    const prompt = routine.prompt
    setTimeout(() => {
      try {
        sessionManager.get(meta.id)?.send(prompt)
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
  // Routine 定时调度:每 30s 轮询,到点起会话执行(补齐"定时自动执行"承诺)
  startRoutineScheduler({
    rootDir: join(app.getPath('userData'), 'routines'),
    onTrigger: runRoutine
  })
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
