import { listRoutines, markRun, updateRoutine, type Routine } from './routineStore'
import { normalizeCronAlias } from './cronParse'

/**
 * Routine 定时调度器(主进程内)。
 *
 * - 每 `intervalMs`(默认 30s)轮询一次 routine store。
 * - 对 `enabled` 且 `nextRunAt <= now` 的 routine 触发 `onTrigger(routine)`。
 * - 触发后按 `schedule` 计算下一个 `nextRunAt` 并 `markRun`。
 * - `enabled` 但缺失 `nextRunAt` 的 routine 会被回填(不立即触发),使调度器自洽。
 *
 * 触发回调由 index.ts 注入,用于起会话跑 `routine.prompt`。
 */

export type RoutineTriggerCallback = (routine: Routine, nextRunAt: number | null) => void | Promise<void>

export interface StartRoutineSchedulerOptions {
  /** routine store 的根目录(同 ipc.ts 的 routineStoreRoot(),即 userData/routines) */
  rootDir: string
  /** 触发回调:拿到到点的 routine,由调用方决定如何起会话 */
  onTrigger: RoutineTriggerCallback
  /** 轮询间隔,毫秒。默认 30000 */
  intervalMs?: number
  /** 可注入的时钟,便于测试。默认 Date.now */
  now?: () => number
}

interface SchedulerState {
  timer: ReturnType<typeof setInterval>
  rootDir: string
  onTrigger: RoutineTriggerCallback
  now: () => number
  /** 防止上一轮异步 tick 未完又进入下一轮 */
  ticking: boolean
}

const DEFAULT_INTERVAL_MS = 30_000
/** cron 向前搜索上限:约 366 天(分钟),避免不可满足的表达式导致死循环 */
const CRON_SEARCH_LIMIT_MINUTES = 366 * 24 * 60
const MINUTE_MS = 60_000

let state: SchedulerState | null = null

/** 启动调度器(幂等:重复调用会先停旧的再起新的) */
export function startRoutineScheduler(opts: StartRoutineSchedulerOptions): void {
  stopRoutineScheduler()
  const intervalMs = opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_INTERVAL_MS
  const now = opts.now ?? Date.now
  const local: SchedulerState = {
    timer: setInterval(() => {
      void runTick(local)
    }, intervalMs),
    rootDir: opts.rootDir,
    onTrigger: opts.onTrigger,
    now,
    ticking: false
  }
  // Node 定时器:不要阻止进程退出
  if (typeof local.timer.unref === 'function') local.timer.unref()
  state = local
  // 启动即跑一轮,不必等第一个 interval
  void runTick(local)
}

/** 停止调度器(幂等) */
export function stopRoutineScheduler(): void {
  if (!state) return
  clearInterval(state.timer)
  state = null
}

/** 是否正在运行(便于测试/诊断) */
export function isRoutineSchedulerRunning(): boolean {
  return state !== null
}

async function runTick(local: SchedulerState): Promise<void> {
  // 若调度器已被替换/停止,或上一轮仍在跑,跳过
  if (state !== local || local.ticking) return
  local.ticking = true
  try {
    const now = local.now()
    const routines = await listRoutines(local.rootDir)
    for (const routine of routines) {
      if (state !== local) break
      if (!routine.enabled) continue

      const nextRunAt = typeof routine.nextRunAt === 'number' ? routine.nextRunAt : null

      if (nextRunAt === null) {
        // enabled 但没排期:回填一个 nextRunAt,本轮不触发
        const seeded = computeNextRun(routine.schedule, now)
        if (seeded !== null) {
          await safeUpdateNextRun(local.rootDir, routine.id, seeded)
        }
        continue
      }

      if (nextRunAt > now) continue

      // 到点:先触发回调,再排下一次
      try {
        const upcoming = computeNextRun(routine.schedule, now)
        await local.onTrigger(routine, upcoming)
      } catch (err) {
        console.error('[caogen] routine 触发回调异常:', routine.id, err)
      }

    }
  } catch (err) {
    console.error('[caogen] routine 调度轮询失败:', err)
  } finally {
    local.ticking = false
  }
}

async function safeUpdateNextRun(rootDir: string, id: string, nextRunAt: number): Promise<void> {
  try {
    await updateRoutine(rootDir, id, { nextRunAt })
  } catch (err) {
    console.error('[caogen] routine 回填 nextRunAt 失败:', id, err)
  }
}

/**
 * 纯函数:根据 schedule 与基准时刻 `from` 计算下一次运行的毫秒时间戳。
 *
 * 支持两种格式:
 *  1. 间隔式:`every 30m` / `every 2h` / `30m` / `2h`(也接受 `s` 秒、`d` 天)。
 *  2. 5 段 cron:`minute hour day-of-month month day-of-week`,
 *     字段支持 `*`、`a`、`a-b`、`a,b,c`、`* / n`、`a-b/n`;
 *     day-of-week 0-6(0=周日,也接受 7=周日);
 *     当 day-of-month 与 day-of-week 都被限制时按 cron 惯例取「或」。
 *
 * 无法解析或不可满足时返回 null。
 */
export function computeNextRun(schedule: string, from: number): number | null {
  if (typeof schedule !== 'string') return null
  const trimmed = schedule.trim()
  if (trimmed === '') return null

  const interval = parseIntervalSchedule(trimmed)
  if (interval !== null) {
    if (interval <= 0) return null
    return from + interval
  }

  return computeNextCron(normalizeCronAlias(trimmed), from)
}

/** 解析间隔式表达式,返回毫秒;非间隔式返回 null */
function parseIntervalSchedule(input: string): number | null {
  const match = /^(?:every\s+)?(\d+)\s*([smhd])$/i.exec(input)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return 0 // 触发上层返回 null
  const unit = match[2].toLowerCase()
  const unitMs = unit === 's' ? 1_000 : unit === 'm' ? MINUTE_MS : unit === 'h' ? 3_600_000 : 86_400_000
  return value * unitMs
}

interface CronSpec {
  minute: number[]
  hour: number[]
  dom: number[]
  month: number[]
  dow: number[]
  domRestricted: boolean
  dowRestricted: boolean
}

function computeNextCron(input: string, from: number): number | null {
  const spec = parseCron(input)
  if (!spec) return null

  // 从下一分钟起搜索(cron 精度为分钟)
  const start = new Date(from)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  const cursor = new Date(start)
  for (let i = 0; i < CRON_SEARCH_LIMIT_MINUTES; i++) {
    if (cronMatches(spec, cursor)) return cursor.getTime()
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.includes(date.getMinutes())) return false
  if (!spec.hour.includes(date.getHours())) return false
  if (!spec.month.includes(date.getMonth() + 1)) return false

  const domOk = spec.dom.includes(date.getDate())
  // getDay(): 0=周日..6=周六;spec.dow 已把 7 归一为 0
  const dowOk = spec.dow.includes(date.getDay())

  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk
  if (spec.domRestricted) return domOk
  if (spec.dowRestricted) return dowOk
  return true
}

function parseCron(input: string): CronSpec | null {
  const fields = input.split(/\s+/)
  if (fields.length !== 5) return null

  const minute = parseCronField(fields[0], 0, 59)
  const hour = parseCronField(fields[1], 0, 23)
  const dom = parseCronField(fields[2], 1, 31)
  const month = parseCronField(fields[3], 1, 12)
  const dowRaw = parseCronField(fields[4], 0, 7)
  if (!minute || !hour || !dom || !month || !dowRaw) return null

  // 归一化 day-of-week:7 -> 0(都表示周日),并去重排序
  const dow = Array.from(new Set(dowRaw.map((d) => (d === 7 ? 0 : d)))).sort((a, b) => a - b)

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*'
  }
}

/** 解析单个 cron 字段为其匹配的整数集合;非法返回 null */
function parseCronField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    if (part === '') return null
    const parsed = parseCronPart(part, min, max)
    if (!parsed) return null
    for (const v of parsed) values.add(v)
  }
  if (values.size === 0) return null
  return Array.from(values).sort((a, b) => a - b)
}

function parseCronPart(part: string, min: number, max: number): number[] | null {
  let step = 1
  let rangePart = part

  const slash = part.indexOf('/')
  if (slash !== -1) {
    rangePart = part.slice(0, slash)
    const stepStr = part.slice(slash + 1)
    step = Number(stepStr)
    if (!Number.isInteger(step) || step <= 0 || stepStr.trim() === '') return null
  }

  let lo: number
  let hi: number

  if (rangePart === '*') {
    lo = min
    hi = max
  } else if (rangePart.includes('-')) {
    const [loStr, hiStr] = rangePart.split('-')
    lo = Number(loStr)
    hi = Number(hiStr)
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null
  } else {
    const single = Number(rangePart)
    if (!Number.isInteger(single)) return null
    lo = single
    hi = single
  }

  if (lo < min || hi > max || lo > hi) return null

  const out: number[] = []
  for (let v = lo; v <= hi; v += step) out.push(v)
  return out
}
