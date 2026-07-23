import { app } from 'electron'

/**
 * 自动更新骨架。
 *
 * 设计取舍:
 * - `electron-updater` 目前 **未** 列入 package.json 依赖,因此本模块 **不能** 静态
 *   `import`(否则 tsc / 打包会因缺模块而失败)。改为运行时 `require` 探测:装了才启用,
 *   没装则整个模块降级为 no-op,主进程照常启动。
 * - 安全:绝不静默下载安装包。查到新版本只 **通知**(emit `update:available` 事件 +
 *   触发系统气泡),下载与安装由用户在 UI 里显式确认后再调用 `downloadUpdate()`。
 *   这里用 autoUpdater.autoDownload = false 强制关闭自动下载。
 *
 * 如何真正启用自动更新:
 *   1) 安装依赖:  npm i -D electron-updater
 *      (electron-updater 是运行时依赖,但因为会被打进 app,通常按项目习惯放 dependencies;
 *       本项目 asar 打包,放 dependencies 更稳妥:  npm i electron-updater)
 *   2) 在 package.json 的 "build" 段加 publish 配置,例如 GitHub:
 *        "build": {
 *          "publish": [{ "provider": "github", "owner": "<org>", "repo": "<repo>" }]
 *        }
 *      或通用 S3 / 静态服务器:
 *        "publish": [{ "provider": "generic", "url": "https://example.com/caogen/" }]
 *      注:package.json 已内置该 generic publish 占位配置,其中的 URL
 *      (https://example.com/caogen/)为**占位符**,发版时须改成真实的更新分发地址。
 *   3) 发版时用 `electron-builder --publish always`(或 CI)上传 latest.yml + 安装包。
 *   4) 本模块探测到 electron-updater 后会自动接管,无需改调用点。
 */

/** 更新事件:转发给渲染层用于展示"发现新版本 / 进度 / 报错"。 */
export type UpdaterEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'download-progress'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }
  | { kind: 'disabled'; reason: string }

type UpdaterListener = (event: UpdaterEvent) => void

const listeners = new Set<UpdaterListener>()

/** 订阅更新事件;返回取消订阅函数。IPC 层用它把事件 forward 到 `updater:event` 频道。 */
export function subscribeUpdater(listener: UpdaterListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(event: UpdaterEvent): void {
  for (const listener of listeners) listener(event)
}

/** 运行时探测 electron-updater;未安装返回 null(降级为 no-op)。 */
function loadAutoUpdater(): { autoUpdater: any } | null {
  try {
    // 动态 require,避免在未安装依赖时破坏静态编译与打包。
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- optional dependency is probed at runtime
    const mod = require('electron-updater') as { autoUpdater?: unknown }
    if (mod && typeof mod.autoUpdater === 'object' && mod.autoUpdater) {
      return { autoUpdater: mod.autoUpdater }
    }
    return null
  } catch {
    return null
  }
}

let started = false
let cachedAutoUpdater: any = null

/**
 * 初始化自动更新。应在 app ready、创建窗口后调用一次(见 wiringSpec)。
 * - 未安装 electron-updater:no-op(仅 emit 一次 `disabled`,方便 UI 静默隐藏入口)。
 * - dev(未打包)环境:electron-updater 通常无法工作,同样降级为 no-op。
 * - 已安装且已打包:配置 autoDownload = false,绑定事件转发,并做一次检查(只查不下载)。
 */
export function initAutoUpdater(): void {
  if (started) return
  started = true

  // dev / 未打包 下 electron-updater 会因缺少 app-update.yml 报错,直接降级。
  if (!app.isPackaged) {
    emit({ kind: 'disabled', reason: '未打包环境,自动更新不可用' })
    return
  }

  const loaded = loadAutoUpdater()
  if (!loaded) {
    emit({ kind: 'disabled', reason: '未安装 electron-updater 依赖' })
    return
  }

  const { autoUpdater } = loaded
  cachedAutoUpdater = autoUpdater

  // 安全:关闭自动下载与自动安装,查到更新只通知。
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => emit({ kind: 'checking' }))
  autoUpdater.on('update-available', (info: { version: string; releaseNotes?: string }) =>
    emit({ kind: 'available', version: info.version, releaseNotes: normalizeNotes(info.releaseNotes) })
  )
  autoUpdater.on('update-not-available', (info: { version: string }) =>
    emit({ kind: 'not-available', version: info.version })
  )
  autoUpdater.on(
    'download-progress',
    (p: { percent: number; transferred: number; total: number }) =>
      emit({
        kind: 'download-progress',
        percent: p.percent,
        transferred: p.transferred,
        total: p.total
      })
  )
  autoUpdater.on('update-downloaded', (info: { version: string }) =>
    emit({ kind: 'downloaded', version: info.version })
  )
  autoUpdater.on('error', (err: unknown) =>
    emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
  )

  // 只检查,不下载(autoDownload=false 保证)。
  void autoUpdater.checkForUpdates().catch((err: unknown) => {
    emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
  })
}

/** 手动触发一次检查(供 UI "检查更新" 按钮);未启用时 no-op 并回 false。 */
export async function checkForUpdates(): Promise<boolean> {
  if (!cachedAutoUpdater) return false
  try {
    await cachedAutoUpdater.checkForUpdates()
    return true
  } catch (err) {
    emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/**
 * 用户在 UI 显式确认后再下载(遵守"不静默下载")。未启用时 no-op 并回 false。
 * 下载完成会 emit `downloaded`,UI 可再提供"重启并安装"入口调用 `quitAndInstall()`。
 */
export async function downloadUpdate(): Promise<boolean> {
  if (!cachedAutoUpdater) return false
  try {
    await cachedAutoUpdater.downloadUpdate()
    return true
  } catch (err) {
    emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** 重启并安装已下载的更新;未启用时 no-op。 */
export function quitAndInstall(): void {
  if (!cachedAutoUpdater) return
  // isSilent=false, isForceRunAfter=true:非静默,安装后重启。
  cachedAutoUpdater.quitAndInstall(false, true)
}

function normalizeNotes(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes
  return undefined
}
