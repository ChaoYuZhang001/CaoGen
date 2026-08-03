import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 模型实测统计(路由自学习,ROADMAP v2)。
 * 记录每个模型的实际表现 —— 成功/失败次数、延迟指数滑动平均(EMA)——
 * 供跨厂商路由作"同质量档打平时的偏好"与"高失败率降权",让路由从
 * 静态能力表逐步向实测修正。持久化到 userData,跨重启保留。
 *
 * 刻意保守:只做打平偏好与降权,不改变"满足复杂度目标质量档"的主排序,
 * 避免自学习把简单任务错误升到贵模型或反之。
 */

export interface ModelStat {
  model: string
  successes: number
  failures: number
  /** 延迟 EMA(毫秒);无样本为 undefined */
  latencyEmaMs?: number
  lastUsedAt?: number
}

interface StatsFile {
  version: 1
  models: Record<string, ModelStat>
}

const EMA_ALPHA = 0.3 // 新样本权重:越大越跟手,越小越平滑
let cache: StatsFile | null = null
/** 存储目录:生产由 index.ts 注入 userData;测试可注入临时目录 */
let baseDir = ''

/** 注入统计文件所在目录(生产环境启动时设为 userData) */
export function configureModelStatsDir(dir: string): void {
  baseDir = dir
  cache = null
}

function statsFile(): string {
  // 未注入(极早期调用)时退回进程 cwd,避免抛错;正常流程 index.ts 会先注入
  return join(baseDir || process.cwd(), 'model-stats.json')
}

function load(): StatsFile {
  if (cache) return cache
  try {
    const parsed = JSON.parse(readFileSync(statsFile(), 'utf8')) as StatsFile
    if (parsed && parsed.version === 1 && parsed.models) {
      cache = parsed
      return cache
    }
  } catch {
    // 缺失/损坏:空表起步
  }
  cache = { version: 1, models: {} }
  return cache
}

function persist(next: StatsFile): void {
  const file = statsFile()
  const directory = dirname(file)
  const temporary = join(directory, `.model-stats.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    mkdirSync(directory, { recursive: true })
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
    syncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* canonical file remains authoritative */ }
    }
    throw error
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  try {
    const descriptor = openSync(directory, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch {
    // The file is fsynced; some filesystems reject directory fsync.
  }
}

function updateStat(model: string, update: (stat: ModelStat) => void): void {
  const current = load()
  const stat = { ...(current.models[model] ?? { model, successes: 0, failures: 0 }) }
  update(stat)
  const next: StatsFile = { version: 1, models: { ...current.models, [model]: stat } }
  persist(next)
  cache = next
}

/** 记一次成功(带真实延迟);model 为空则忽略(auto 哨兵等) */
export function recordModelSuccess(model: string, latencyMs?: number): void {
  if (!model) return
  updateStat(model, (stat) => {
    stat.successes += 1
    stat.lastUsedAt = Date.now()
    if (latencyMs !== undefined && latencyMs > 0) {
      stat.latencyEmaMs = stat.latencyEmaMs === undefined
        ? latencyMs
        : Math.round(stat.latencyEmaMs * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA)
    }
  })
}

export function recordModelFailure(model: string): void {
  if (!model) return
  updateStat(model, (stat) => {
    stat.failures += 1
    stat.lastUsedAt = Date.now()
  })
}

/** 读取某模型统计(无样本返回 undefined) */
export function getModelStat(model: string): ModelStat | undefined {
  return load().models[model]
}

export function listModelStats(): ModelStat[] {
  return Object.values(load().models)
}

/**
 * 近期可靠性评分 [0,1]:成功率;样本 <5 时向 0.5 收缩(证据不足不轻信)。
 * 用于路由降权:分数明显低的同档模型被让位。
 */
export function reliabilityScore(model: string): number {
  const stat = getModelStat(model)
  if (!stat) return 0.5
  const total = stat.successes + stat.failures
  if (total === 0) return 0.5
  const raw = stat.successes / total
  if (total < 5) return raw * (total / 5) + 0.5 * (1 - total / 5)
  return raw
}

/** 测试用:重置内存缓存(不删盘) */
export function _resetCacheForTest(): void {
  cache = null
}
