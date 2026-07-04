/**
 * 轻量 cron 解析(纯函数,无副作用)。
 *
 * 支持标准 5 段:分 时 日 月 周
 *   - 分   minute       0-59
 *   - 时   hour         0-23
 *   - 日   day-of-month 1-31
 *   - 月   month        1-12
 *   - 周   day-of-week  0-6(0=周日;7 归一化为 0)
 *
 * 每段字段支持:
 *   - `*`         通配(整个取值域)
 *   - `a`         单值
 *   - `a-b`       闭区间
 *   - `a,b,c`     枚举(各项本身可为 `*` / `a-b` / `*​/n` / `a-b/n`)
 *   - `*​/n`       步长(从域最小值起每隔 n)
 *   - `a-b/n`     区间步长
 *
 * routineScheduler 使用:
 *   const c = parseCron(expr)
 *   if (c && c.match(new Date())) fire()
 *   const next = nextAfter(expr, Date.now())  // 下一次触发的毫秒时间戳
 *
 * 语义与 Vixie cron 对齐:当「日」与「周」都不是 `*` 时,取二者的并集
 * (满足其一即匹配);否则取交集(即某一段为 `*` 时不约束)。
 */

/** 单个字段的取值域(闭区间)。 */
interface FieldRange {
  min: number
  max: number
}

const RANGES: { minute: FieldRange; hour: FieldRange; dom: FieldRange; month: FieldRange; dow: FieldRange } = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 }
}

/** 已解析的 cron:各字段展开为允许值集合,外加日/周是否受限的标记。 */
interface ParsedCron {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** 「日」段是否为受限(非 `*`),用于 Vixie 日/周并集语义。 */
  domRestricted: boolean
  /** 「周」段是否为受限(非 `*`)。 */
  dowRestricted: boolean
}

/** 判定字段是否是无约束通配(纯 `*` 或 `*​/1`)。 */
function isWildcard(field: string): boolean {
  return field === '*' || field === '*/1'
}

/**
 * 解析单个字段为允许值集合。非法则返回 null。
 * 支持逗号分隔的多项,每项可为 `*` / `a` / `a-b` / `* /n` / `a-b/n`。
 */
function parseField(field: string, range: FieldRange): Set<number> | null {
  const trimmed = field.trim()
  if (trimmed === '') return null
  const result = new Set<number>()

  for (const rawPart of trimmed.split(',')) {
    const part = rawPart.trim()
    if (part === '') return null

    // 拆步长
    let base = part
    let step = 1
    const slash = part.indexOf('/')
    if (slash >= 0) {
      base = part.slice(0, slash).trim()
      const stepStr = part.slice(slash + 1).trim()
      if (!/^\d+$/.test(stepStr)) return null
      step = parseInt(stepStr, 10)
      if (step <= 0) return null
    }

    let lo: number
    let hi: number
    if (base === '*') {
      lo = range.min
      hi = range.max
    } else if (base.includes('-')) {
      const [aStr, bStr, ...rest] = base.split('-')
      if (rest.length > 0) return null
      if (!/^\d+$/.test(aStr ?? '') || !/^\d+$/.test(bStr ?? '')) return null
      lo = parseInt(aStr, 10)
      hi = parseInt(bStr, 10)
    } else {
      if (!/^\d+$/.test(base)) return null
      lo = parseInt(base, 10)
      // 单值 + 步长(如 `5/10`)按「从 5 到域上界每隔 10」处理
      hi = slash >= 0 ? range.max : lo
    }

    if (lo > hi) return null
    if (lo < range.min || hi > range.max) return null

    for (let v = lo; v <= hi; v += step) result.add(v)
  }

  return result.size > 0 ? result : null
}

/** 已解析 cron 的匹配器:match(date) 判定给定时刻是否命中(秒级忽略)。 */
export interface CronMatcher {
  match(date: Date): boolean
}

/**
 * 解析 5 段 cron 表达式。合法返回带 match() 的匹配器,非法返回 null。
 * 多余空白与制表符会被折叠;必须恰好 5 段。
 */
export function parseCron(expr: string): CronMatcher | null {
  const parsed = parseCronInternal(expr)
  if (!parsed) return null
  return {
    match(date: Date): boolean {
      return matchParsed(parsed, date)
    }
  }
}

/** 内部:解析为 ParsedCron 结构(供 parseCron 与 nextAfter 共用)。 */
function parseCronInternal(expr: string): ParsedCron | null {
  if (typeof expr !== 'string') return null
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null

  const [minF, hourF, domF, monthF, dowF] = fields

  const minute = parseField(minF, RANGES.minute)
  const hour = parseField(hourF, RANGES.hour)
  const dom = parseField(domF, RANGES.dom)
  const month = parseField(monthF, RANGES.month)
  // 周:先把 7 归一化为 0,再解析
  const dowNorm = normalizeDow(dowF)
  const dow = dowNorm === null ? null : parseField(dowNorm, RANGES.dow)

  if (!minute || !hour || !dom || !month || !dow) return null

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: !isWildcard(domF.trim()),
    dowRestricted: !isWildcard(dowF.trim())
  }
}

/**
 * 把「周」字段里的 7 归一化为 0(cron 允许 0 和 7 都表示周日)。
 * 仅对纯数字 token 生效,保留 `*` / `/` / `-` / `,` 结构。非法返回 null。
 */
function normalizeDow(field: string): string | null {
  const trimmed = field.trim()
  if (trimmed === '') return null
  // 逐字符扫描连续数字,遇 7 且作为独立数字时替换为 0。
  // 简化处理:先按 , - / 拆再重组,保证 token 边界清晰。
  return trimmed.replace(/\d+/g, (numStr) => {
    const n = parseInt(numStr, 10)
    return n === 7 ? '0' : numStr
  })
}

/** 判定某时刻是否命中已解析的 cron(Vixie 日/周语义)。 */
function matchParsed(p: ParsedCron, date: Date): boolean {
  if (!p.minute.has(date.getMinutes())) return false
  if (!p.hour.has(date.getHours())) return false
  if (!p.month.has(date.getMonth() + 1)) return false

  const domHit = p.dom.has(date.getDate())
  const dowHit = p.dow.has(date.getDay())

  // Vixie 语义:日与周都受限 → 并集;否则受限的那个(或都不限)按交集。
  if (p.domRestricted && p.dowRestricted) {
    return domHit || dowHit
  }
  if (p.domRestricted) return domHit
  if (p.dowRestricted) return dowHit
  return true // 日与周都是 *,不约束
}

/** 向后扫描的天数上限(含闰年余量)。 */
const MAX_SCAN_DAYS = 366

/**
 * 求 `from`(毫秒时间戳)之后严格大于它的下一个匹配时刻(毫秒时间戳)。
 * 向后最多扫描 366 天;扫不到返回 null。cron 表达式非法也返回 null。
 *
 * 实现:从 from 的下一分钟开始按分钟推进(cron 精度为分钟),
 * 用 ParsedCron 直接判定,命中即返回该分钟的 0 秒时间戳。
 */
export function nextAfter(expr: string, from: number): number | null {
  const parsed = parseCronInternal(expr)
  if (!parsed) return null
  if (!Number.isFinite(from)) return null

  // 起点:from 所在分钟的下一分钟(秒/毫秒清零)。
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  const limit = new Date(from + MAX_SCAN_DAYS * 24 * 60 * 60 * 1000)

  while (cursor.getTime() <= limit.getTime()) {
    // 月不匹配:快进到下月 1 日 0 点,减少无谓的分钟级扫描。
    if (!parsed.month.has(cursor.getMonth() + 1)) {
      cursor.setDate(1)
      cursor.setHours(0, 0, 0, 0)
      cursor.setMonth(cursor.getMonth() + 1)
      continue
    }
    // 日/周不匹配:快进到次日 0 点。
    if (!dayMatches(parsed, cursor)) {
      cursor.setHours(0, 0, 0, 0)
      cursor.setDate(cursor.getDate() + 1)
      continue
    }
    // 时不匹配:快进到下一小时的 0 分。
    if (!parsed.hour.has(cursor.getHours())) {
      cursor.setMinutes(0, 0, 0)
      cursor.setHours(cursor.getHours() + 1)
      continue
    }
    // 分匹配即命中。
    if (parsed.minute.has(cursor.getMinutes())) {
      return cursor.getTime()
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }

  return null
}

/** 仅判定「日/周」维度是否命中(供 nextAfter 快进使用,复用 Vixie 语义)。 */
function dayMatches(p: ParsedCron, date: Date): boolean {
  const domHit = p.dom.has(date.getDate())
  const dowHit = p.dow.has(date.getDay())
  if (p.domRestricted && p.dowRestricted) return domHit || dowHit
  if (p.domRestricted) return domHit
  if (p.dowRestricted) return dowHit
  return true
}
