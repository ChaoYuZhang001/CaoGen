import type { SchedulerStrategy } from '../shared/types'

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
  { match: /deepseek/i, cap: { quality: 2, cost: 1, speed: 2 } }
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

/** 官方 Anthropic(无 Provider)时的候选模型档 */
export const DEFAULT_AUTO_CANDIDATES = ['haiku', 'sonnet', 'opus']

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

/** '' 表示官方 Anthropic;统一用 'official' 作 key 便于展示 */
function key(providerId: string): string {
  return providerId || 'official'
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
