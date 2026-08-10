// Must run before imports that construct app-path-bound singletons.
import './app-runtime-paths'
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
import { disposeTypeScriptLanguageServers } from './typescriptLanguageServer'
import { disposeProjectTestRuns } from './projectTestRunner'
import { disposeProjectDebuggers } from './projectDebugger'
import { configureProjectRefactorRecovery, reconcileProjectRefactorsAtStartup } from './projectRefactor'
import { disposeOfficeVisualPreviews } from './previewVisual'
import { startRoutineScheduler, stopRoutineScheduler } from './routineScheduler'
import { executeRoutine } from './routines/routine-executor'
import {
  disposeRoutineSessionLifecycle,
  initializeRoutineSessionLifecycle,
  reconcileRoutineRunsAtStartup
} from './routines/routine-session-lifecycle'
import { initAutoUpdater } from './updater'
import { configureQuickbar, disposeQuickbar, registerQuickbarGlobalShortcut } from './quickbar'
import { listProjects } from './projects'
import { ensureProjectSkillReadiness } from './learning/learning-lifecycle'
import { configureLearningUserDataRoot } from './learning/learning-store'
import { configurePermissionAuditUserDataRoot } from './permission/audit-log'
import { reconcileProviderProfileOperations } from './provider/providerProfileService'
import { reconcileProviderProfileSyncAtStartup } from './provider/providerProfileSync'
import {
  startProviderProfileWebDavAutoSync,
  stopProviderProfileWebDavAutoSync
} from './provider/providerProfileWebDavSync'
import {
  startProviderProfileS3AutoSync,
  stopProviderProfileS3AutoSync
} from './provider/providerProfileS3Sync'
import { reconcileCcSwitchProviderImportOperations } from './provider/ccSwitchProviderImport'
import { refreshProviderCredentialMetrics } from './provider/providerCredentialMetrics'
import { initializeProviderGateway, stopProviderGateway } from './provider/providerGatewayService'
import type { Routine } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let quitCleanupStarted = false
let trayRunningCount: number | null = null
let unsubscribeTraySessionEvents: (() => void) | null = null
let shellInstalled = false

// GPU incompatibility fallback: disable hardware acceleration to avoid black screen
if (process.argv.includes('--disable-gpu') || process.env.CAOGEN_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
}

process.env.CAOGEN_MEMORY_DIR ??= join(app.getPath('userData'), 'memory')
configureLearningUserDataRoot(app.getPath('userData'))
configurePermissionAuditUserDataRoot(app.getPath('userData'))
configureProjectRefactorRecovery(app.getPath('userData'))
const singleInstanceOwner = app.requestSingleInstanceLock()
if (!singleInstanceOwner) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
}

/** 应用图标源文件;Windows 使用透明背景图标,其他平台使用圆角通用图标。 */
function resourcePath(names: string[]): string | undefined {
  // 打包后 resources 随 app 一起分发;dev 时用仓库内的 resources/
  const candidates = names.flatMap((name) => [
    join(process.resourcesPath ?? '', name),
    join(__dirname, '../../resources', name)
  ])
  return candidates.find((p) => p && existsSync(p))
}

function iconPath(): string | undefined {
  return resourcePath(process.platform === 'win32' ? ['icon-win.png', 'icon.png'] : ['icon.png'])
}

function trayIconPath(): string | undefined {
  return process.platform === 'darwin'
    ? resourcePath(['trayTemplate.png'])
    : iconPath()
}

function createWindow(): BrowserWindow {
  const icon = iconPath()
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 360,
    minHeight: 520,
    title: 'CaoGen',
    backgroundColor: '#1a1a2e',
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

  // Diagnostic: renderer load failure
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    console.error('[caogen] renderer did-fail-load:', errorCode, errorDescription, validatedURL)
  })

  // Diagnostic: renderer process crash
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[caogen] render-process-gone:', details.reason, details.exitCode)
  })

  // Diagnostic: forward renderer console to main process
  win.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`)
  })

  const loadRenderer = process.env.ELECTRON_RENDERER_URL
    ? win.loadURL(process.env.ELECTRON_RENDERER_URL)
    : win.loadFile(join(__dirname, '../renderer/index.html'))
  void loadRenderer.catch((error) => {
    console.error('[caogen] renderer load failed:', error)
  })

  // Loading timeout: if renderer hasn't finished in 10s, show error overlay
  const loadTimeout = setTimeout(() => {
    if (!win.isDestroyed() && win.webContents.isLoading()) {
      console.error('[caogen] renderer load timeout (10s)')
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<html><body style="background:#1a1a2e;color:#e0e0e0;font-family:system-ui;padding:40px">' +
        '<h2>CaoGen - Loading Timeout</h2>' +
        '<p>The renderer process did not finish loading within 10 seconds.</p>' +
        '<p>Try restarting with --disable-gpu flag.</p>' +
        '</body></html>'
      ))
    }
  }, 10000)
  win.webContents.once('did-finish-load', () => clearTimeout(loadTimeout))

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
  if (runningCount === trayRunningCount) return
  trayRunningCount = runningCount
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
  const icon = trayIconPath()
  const image = icon ? nativeImage.createFromPath(icon) : nativeImage.createEmpty()
  if (process.platform === 'darwin' && !image.isEmpty()) image.setTemplateImage(true)
  tray = new Tray(image)
  tray.on('click', showMainWindow)
  updateTray()
  unsubscribeTraySessionEvents = sessionManager.subscribe(() => updateTray())
}

function sendMenuCommand(channel: string, value?: unknown): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, value)
}

function ensureApplicationShell(): void {
  if (shellInstalled) return
  registerIpc()
  createWindow()
  installApplicationMenu()
  shellInstalled = true
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

async function recoverLearningMaterializationAtStartup(): Promise<void> {
  const projectRoots = [...new Set(listProjects().map((project) => project.path).filter(Boolean))]
  await Promise.all(projectRoots.map(async (projectRoot) => {
    try {
      await ensureProjectSkillReadiness(projectRoot)
    } catch (error) {
      // Project Skill loading also fails closed until the same recovery succeeds.
      console.error(`[caogen] Learning materialization recovery failed for ${projectRoot}:`, error)
    }
  }))
}

void app.whenReady().then(async () => {
  if (!singleInstanceOwner) return

  // Create the shell before recovery/migration work. A damaged or slow durable
  // store must never leave the user with a process and no diagnosable window.
  // IPC handlers are safe to register before session hydration; they expose the
  // current (possibly empty) session set until recovery completes.
  ensureApplicationShell()

  try {
    reconcileProviderProfileOperations()
  } catch (error) {
    console.error('[caogen] Provider Profile operation recovery failed:', error)
  }
  try {
    const recovery = await reconcileProjectRefactorsAtStartup()
    if (recovery.recovered > 0 || recovery.blocked > 0 || recovery.superseded > 0 || recovery.corrupt > 0) {
      console.warn('[caogen] Project refactor recovery:', recovery)
    }
  } catch (error) {
    console.error('[caogen] Project refactor recovery failed:', error instanceof Error ? error.name : 'UnknownError')
  }
  reconcileProviderProfileSyncAtStartup()
  startProviderProfileWebDavAutoSync()
  startProviderProfileS3AutoSync()
  try {
    reconcileCcSwitchProviderImportOperations()
  } catch (error) {
    console.error('[caogen] CC Switch Provider import recovery failed:', error)
  }
  void refreshProviderCredentialMetrics().catch((error) => {
    console.error('[caogen] Provider credential usage refresh failed:', error)
  })
  try { await initializeProviderGateway() } catch (e) { console.error('[caogen] Local Provider Gateway startup failed:', e) }
  try { await recoverLearningMaterializationAtStartup() } catch (e) { console.error('[caogen] learning recovery failed:', e) }
  try { await sessionManager.whenInitialized() } catch (e) { console.error('[caogen] session init failed:', e) }
  const routineRoot = join(app.getPath('userData'), 'routines')
  try { initializeRoutineSessionLifecycle(routineRoot, app.getPath('userData')) } catch (e) { console.error('[caogen] routine lifecycle init failed:', e) }
  try { await reconcileRoutineRunsAtStartup(routineRoot, app.getPath('userData')) } catch (e) { console.error('[caogen] routine reconciliation failed:', e) }
  try { configureQuickbar({ getMainWindow: () => mainWindow, showMainWindow }) } catch (e) { console.error('[caogen] quickbar config failed:', e) }
  try {
    const quickbarState = registerQuickbarGlobalShortcut()
    if (!quickbarState.registered) {
      console.warn('[caogen] quickbar shortcut unavailable:', quickbarState.registrationError)
    }
  } catch (e) { console.error('[caogen] quickbar shortcut failed:', e) }
  try { installTray() } catch (e) { console.error('[caogen] tray install failed:', e) }
  // Routine 定时调度:每 30s 轮询,到点起会话执行(补齐"定时自动执行"承诺)
  try {
    startRoutineScheduler({
      rootDir: join(app.getPath('userData'), 'routines'),
      onTrigger: runRoutine
    })
  } catch (e) { console.error('[caogen] routine scheduler start failed:', e) }
  // 自动更新(打包环境查更新只通知不静默下载;dev/未装依赖降级 no-op)
  try { initAutoUpdater() } catch (e) { console.error('[caogen] auto updater init failed:', e) }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  // Keep the shell alive when a newly added startup task rejects outside its
  // local recovery guard. The error remains in the main-process log, while the
  // user can still inspect settings and choose a recovery path.
  console.error('[caogen] startup failed:', error)
  if (singleInstanceOwner && BrowserWindow.getAllWindows().length === 0) {
    ensureApplicationShell()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !hasRunningSessions()) app.quit()
})

app.on('will-quit', () => {
  disposeRoutineSessionLifecycle()
  disposeQuickbar()
})

app.on('before-quit', (event) => {
  if (!singleInstanceOwner) return
  quitting = true
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  event.preventDefault()
  unsubscribeTraySessionEvents?.()
  unsubscribeTraySessionEvents = null
  stopRoutineScheduler()
  stopProviderProfileWebDavAutoSync()
  stopProviderProfileS3AutoSync()
  disposeOfficeVisualPreviews()
  disposeProjectTestRuns()
  disposeProjectDebuggers()
  // 退出前等待任务快照落盘,再释放项目索引 watcher/SQLite 句柄。
  void (async () => {
    await sessionManager.disposeAll()
    await Promise.all([
      disposeProjectIndexers(),
      disposeTypeScriptLanguageServers(),
      stopProviderGateway()
    ])
  })()
    .catch((error) => {
      console.error('[caogen] quit cleanup failed:', error)
    })
    .finally(() => app.quit())
})
