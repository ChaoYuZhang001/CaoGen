import type { SchedulerStrategy } from '../shared/types'
import { reliabilityScore } from './modelStats'

/** 模型能力档:quality/cost/speed 各 1-3(3 最高)。tier 用于按复杂度匹配。 */
interface ModelCap {
  quality: 1 | 2 | 3
  cost: 1 | 2 | 3
  speed: 1 | 2 | 3
}

/**
 * 已知模型能力表。键为归一化后的模型名子串匹配。
 * 未知模型给中庸默认,避免调度器对新模型无所适从。
 */
const CAP_TABLE: Array<{ match: RegExp; cap: ModelCap }> = [
  { match: /opus/i, cap: { quality: 3, cost: 3, speed: 1 } },
  { match: /sonnet/i, cap: { quality: 2, cost: 2, speed: 2 } },
  { match: /haiku/i, cap: { quality: 1, cost: 1, speed: 3 } },
  { match: /gpt-4o-mini|4o-mini/i, cap: { quality: 1, cost: 1, speed: 3 } },
  { match: /gpt-4o|gpt-4\.1|o3|o1/i, cap: { quality: 3, cost: 2, speed: 2 } },
  { match: /gpt-3\.5|mini|flash|lite/i, cap: { quality: 1, cost: 1, speed: 3 } },
  { match: /gemini.*pro|1\.5-pro|2\.0-pro/i, cap: { quality: 3, cost: 2, speed: 2 } },
  { match: /deepseek.*(reasoner|r1)/i, cap: { quality: 3, cost: 1, speed: 1 } },
  { match: /deepseek/i, cap: { quality: 2, cost: 1, speed: 2 } },
  // 国产模型档位(厂商 Anthropic 兼容端点直连,一等公民)
  { match: /kimi-k2|kimi.*thinking/i, cap: { quality: 3, cost: 1, speed: 2 } },
  { match: /kimi|moonshot/i, cap: { quality: 2, cost: 1, speed: 2 } },
  { match: /glm-4\.5-air|glm.*flash/i, cap: { quality: 1, cost: 1, speed: 3 } },
  { match: /glm/i, cap: { quality: 2, cost: 1, speed: 2 } },
  { match: /qwen.*max|qwen3/i, cap: { quality: 3, cost: 2, speed: 2 } },
  { match: /qwen/i, cap: { quality: 2, cost: 1, speed: 2 } }
]

const DEFAULT_CAP: ModelCap = { quality: 2, cost: 2, speed: 2 }

function capOf(model: string): ModelCap {
  for (const { match, cap } of CAP_TABLE) if (match.test(model)) return cap
  return DEFAULT_CAP
}

export type Complexity = 'simple' | 'medium' | 'complex'

const COMPLEX_HINTS =
  /重构|refactor|架构|architect|设计|design|实现整个|migrat|审查|review|调试|debug|优化性能|optimi|整个项目|whole (repo|project)|端到端|end.to.end/i
const SIMPLE_HINTS =
  /^(查看|列出|显示|读一下|读取|什么是|解释一下|list|show|read|cat|explain|翻译|translate|格式化|format)\b/i

/** 按消息文本启发式判定复杂度 */
export function classifyComplexity(text: string): Complexity {
  const t = text.trim()
  if (t.length > 400 || COMPLEX_HINTS.test(t)) return 'complex'
  if (t.length < 80 && SIMPLE_HINTS.test(t)) return 'simple'
  if (t.length < 40) return 'simple'
  return 'medium'
}

/** 复杂度目标质量档:complex→3, medium→2, simple→1 */
function targetQuality(c: Complexity): 1 | 2 | 3 {
  return c === 'complex' ? 3 : c === 'medium' ? 2 : 1
}

export interface RouteDecision {
  model: string
  reason: string
  complexity: Complexity
}

/**
 * 从候选模型里挑一个。
 * - quality:满足复杂度前提下选质量最高
 * - cost:满足复杂度前提下选成本最低
 * - balanced:选质量档最接近目标档的(打平再比成本)
 */
export function pickModel(
  candidates: string[],
  text: string,
  strategy: SchedulerStrategy
): RouteDecision | null {
  const pool = candidates.filter(Boolean)
  if (pool.length === 0) return null
  const complexity = classifyComplexity(text)
  const target = targetQuality(complexity)

  const scored = pool.map((model) => ({ model, cap: capOf(model) }))

  let chosen: { model: string; cap: ModelCap }
  if (strategy === 'quality') {
    chosen = scored.reduce((a, b) => (b.cap.quality > a.cap.quality ? b : a))
  } else if (strategy === 'cost') {
    // 满足目标质量的最低成本;若无一达标,退而求其次选质量最高
    const eligible = scored.filter((s) => s.cap.quality >= target)
    const from = eligible.length > 0 ? eligible : scored
    chosen = from.reduce((a, b) => (b.cap.cost < a.cap.cost ? b : a))
  } else {
    // balanced:质量档与目标差距最小,打平比成本低
    chosen = scored.reduce((a, b) => {
      const da = Math.abs(a.cap.quality - target)
      const db = Math.abs(b.cap.quality - target)
      if (db !== da) return db < da ? b : a
      return b.cap.cost < a.cap.cost ? b : a
    })
  }

  const cLabel = complexity === 'complex' ? '复杂' : complexity === 'medium' ? '中等' : '简单'
  const sLabel = strategy === 'quality' ? '质量优先' : strategy === 'cost' ? '成本优先' : '均衡'
  return {
    model: chosen.model,
    complexity,
    reason: `${cLabel}任务 · ${sLabel} → ${chosen.model}`
  }
}

/** Claude 模型档位候选,仅用于显式 Claude/Anthropic 类 Provider 的就近映射。 */
export const DEFAULT_AUTO_CANDIDATES = ['haiku', 'sonnet', 'opus']

export interface CrossRouteDecision {
  providerId: string
  providerName: string
  model: string
  reason: string
  complexity: Complexity
  /** 是否跨到了另一家厂商(调用方据此决定是否重建引擎) */
  switchedProvider: boolean
}

/**
 * 跨厂商智能路由:在**所有健康厂商 × 各自模型**的全集里按策略挑最优,
 * 而非局限在会话当前厂商的模型单里。打平时优先留在当前厂商
 * (避免无谓的引擎重建),再比成本。
 */
export function pickModelAcrossProviders(opts: {
  candidates: FailoverCandidate[]
  text: string
  strategy: SchedulerStrategy
  currentProviderId: string
}): CrossRouteDecision | null {
  const complexity = classifyComplexity(opts.text)
  const target = targetQuality(complexity)

  interface Entry {
    providerId: string
    providerName: string
    model: string
    cap: ModelCap
    isCurrent: boolean
  }
  const pool: Entry[] = []
  for (const c of opts.candidates) {
    if (!ensure(c.id).healthy) continue // 跳过不健康厂商(连续失败≥3)
    for (const model of c.models) {
      if (!model) continue
      pool.push({
        providerId: c.id,
        providerName: c.name,
        model,
        cap: capOf(model),
        isCurrent: c.id === opts.currentProviderId
      })
    }
  }
  if (pool.length === 0) return null

  // 比较器:返回 true 表示 b 优于 a。各策略主排序后,统一打平顺序:
  // 实测可靠性(自学习)> 留在当前厂商 > 成本更低。
  // 可靠性按 0.15 档量化打平,避免微小波动频繁改判(仍以质量档为主排序)。
  const relTier = (model: string): number => Math.round(reliabilityScore(model) / 0.15)
  const tieBreak = (a: Entry, b: Entry): boolean => {
    const ra = relTier(a.model)
    const rb = relTier(b.model)
    if (ra !== rb) return rb > ra
    if (a.isCurrent !== b.isCurrent) return b.isCurrent
    return b.cap.cost < a.cap.cost
  }
  let better: (a: Entry, b: Entry) => boolean
  if (opts.strategy === 'quality') {
    better = (a, b) => (b.cap.quality !== a.cap.quality ? b.cap.quality > a.cap.quality : tieBreak(a, b))
  } else if (opts.strategy === 'cost') {
    // 满足目标质量档的里面挑最便宜;无一达标则全量挑最便宜
    const eligible = pool.filter((e) => e.cap.quality >= target)
    const from = eligible.length > 0 ? eligible : pool
    pool.length = 0
    pool.push(...from)
    better = (a, b) => (b.cap.cost !== a.cap.cost ? b.cap.cost < a.cap.cost : tieBreak(a, b))
  } else {
    better = (a, b) => {
      const da = Math.abs(a.cap.quality - target)
      const db = Math.abs(b.cap.quality - target)
      if (db !== da) return db < da
      return tieBreak(a, b)
    }
  }
  const chosen = pool.reduce((a, b) => (better(a, b) ? b : a))

  const cLabel = complexity === 'complex' ? '复杂' : complexity === 'medium' ? '中等' : '简单'
  const sLabel = opts.strategy === 'quality' ? '质量优先' : opts.strategy === 'cost' ? '成本优先' : '均衡'
  const switchedProvider = chosen.providerId !== opts.currentProviderId
  return {
    providerId: chosen.providerId,
    providerName: chosen.providerName,
    model: chosen.model,
    complexity,
    switchedProvider,
    reason: switchedProvider
      ? `${cLabel}任务 · ${sLabel} · 跨厂商 → ${chosen.providerName} / ${chosen.model}`
      : `${cLabel}任务 · ${sLabel} → ${chosen.model}`
  }
}

// ---------- Provider 健康度 ----------

export interface ProviderHealth {
  providerId: string
  successes: number
  failures: number
  consecutiveFailures: number
  lastLatencyMs?: number
  lastError?: string
  lastUsedAt?: number
  /** 派生:consecutiveFailures>=3 判定不健康 */
  healthy: boolean
}

const health = new Map<string, ProviderHealth>()

/** 历史空 Provider 统一用 local-login 作健康度展示 key。 */
function key(providerId: string): string {
  return providerId || 'local-login'
}

function ensure(providerId: string): ProviderHealth {
  const k = key(providerId)
  let h = health.get(k)
  if (!h) {
    h = { providerId: k, successes: 0, failures: 0, consecutiveFailures: 0, healthy: true }
    health.set(k, h)
  }
  return h
}

export function recordSuccess(providerId: string, latencyMs?: number): void {
  const h = ensure(providerId)
  h.successes += 1
  h.consecutiveFailures = 0
  h.healthy = true
  if (latencyMs !== undefined) h.lastLatencyMs = latencyMs
  h.lastUsedAt = Date.now()
}

export function recordFailure(providerId: string, error?: string): void {
  const h = ensure(providerId)
  h.failures += 1
  h.consecutiveFailures += 1
  if (error) h.lastError = error
  h.lastUsedAt = Date.now()
  if (h.consecutiveFailures >= 3) h.healthy = false
}

export function getHealth(providerId: string): ProviderHealth {
  return ensure(providerId)
}

export function listHealth(): ProviderHealth[] {
  return [...health.values()]
}

// ---------- 故障分类与跨厂商切换(M4.1) ----------

export interface FailureClass {
  /** 换一个厂商大概率能解决 → 值得自动切换重试 */
  switchable: boolean
  /** 面向用户的简短原因标签 */
  label: string
}

/**
 * 按错误文本归类失败原因。只有"厂商侧"故障(余额/限流/鉴权/模型下线/
 * 服务端/网络/进程崩溃)才可切换;执行类错误(如 max_turns)换厂商无意义。
 */
export function classifyFailure(text: string | undefined): FailureClass {
  const t = (text || '').slice(0, 2000)
  if (/credit|balance|quota|insufficient|billing|余额|配额/i.test(t))
    return { switchable: true, label: '余额/配额不足' }
  if (/rate.?limit|too.?many.?requests|\b429\b|overloaded|限流|过载/i.test(t))
    return { switchable: true, label: '限流/过载' }
  if (
    /model.{0,24}(not.?found|not.?exist|not.?support|unavailable|invalid)|(unknown|invalid|no such).{0,8}model|模型不存在|无此模型/i.test(
      t
    )
  )
    return { switchable: true, label: '模型不可用' }
  if (/unauthorized|authentication|invalid.{0,12}(api.?key|token)|\b401\b|鉴权/i.test(t))
    return { switchable: true, label: '鉴权失败' }
  if (/forbidden|permission.?denied|\b403\b/i.test(t)) return { switchable: true, label: '访问被拒' }
  if (/\b(500|502|503|504|529)\b|internal.?server|bad.?gateway|service.?unavailable/i.test(t))
    return { switchable: true, label: '服务端错误' }
  if (/econnrefused|enotfound|etimedout|econnreset|network|fetch.?failed|socket|dns/i.test(t))
    return { switchable: true, label: '网络异常' }
  if (/exited with code|process exited|closed unexpectedly|spawn/i.test(t))
    return { switchable: true, label: '引擎异常退出' }
  return { switchable: false, label: t ? '执行错误' : '未知错误' }
}

export interface FailoverCandidate {
  /** Provider id;新故障切换不再主动生成空 Provider 候选。 */
  id: string
  name: string
  models: string[]
}

export interface FailoverTarget {
  providerId: string
  name: string
  /** 目标厂商上与原模型能力档最接近的模型;无模型列表时为空 */
  model?: string
}

/**
 * 挑选故障切换目标:排除已试过的厂商,跳过不健康厂商,
 * 在剩余候选里选"有与期望模型能力档最接近的模型"的一家(打平选成本低)。
 */
export function pickFailoverTarget(opts: {
  candidates: FailoverCandidate[]
  exclude: Set<string>
  desiredModel: string
}): FailoverTarget | null {
  const want = capOf(opts.desiredModel || 'sonnet').quality
  let best: { c: FailoverCandidate; model?: string; dist: number } | null = null
  for (const c of opts.candidates) {
    if (opts.exclude.has(c.id)) continue
    if (!ensure(c.id).healthy) continue
    let model: string | undefined
    let dist = 1 // 无模型列表:能力未知,给轻微劣势
    if (c.models.length > 0) {
      let bm = c.models[0]
      let bd = Number.POSITIVE_INFINITY
      let bc = 4
      for (const m of c.models) {
        const cap = capOf(m)
        const d = Math.abs(cap.quality - want)
        if (d < bd || (d === bd && cap.cost < bc)) {
          bm = m
          bd = d
          bc = cap.cost
        }
      }
      model = bm
      dist = bd
    }
    if (!best || dist < best.dist) best = { c, model, dist }
  }
  return best ? { providerId: best.c.id, name: best.c.name, model: best.model } : null
}
