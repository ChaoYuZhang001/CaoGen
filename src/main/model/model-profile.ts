import type { EngineKind, SchedulerStrategy } from '../../shared/types'

export type ModelTaskKind =
  | 'chat'
  | 'coding'
  | 'reasoning'
  | 'vision'
  | 'toolUse'
  | 'longContext'
  | 'review'
  | 'summarization'

export type ModelStrength = 'low' | 'medium' | 'high'

export type ModelLatencyClass = 'fast' | 'balanced' | 'slow'

export interface ModelCapabilityProfile {
  coding: ModelStrength
  reasoning: ModelStrength
  toolUse: ModelStrength
  vision: ModelStrength
  longContext: ModelStrength
  summarization: ModelStrength
}

export interface ModelCostProfile {
  /** 输入 token 估算单价，单位 USD / 1M tokens；未知时使用同档保守值。 */
  inputUsdPerMTok: number
  /** 输出 token 估算单价，单位 USD / 1M tokens；未知时使用同档保守值。 */
  outputUsdPerMTok: number
  /** 成本档位只用于预算降级排序，不对外承诺真实账单。 */
  tier: 'low' | 'medium' | 'high'
}

export interface ModelProfile {
  providerId: string
  providerName?: string
  model: string
  engine?: EngineKind
  capabilities: ModelCapabilityProfile
  cost: ModelCostProfile
  latency: ModelLatencyClass
  contextWindowTokens: number
  supportsTools: boolean
  supportsVision: boolean
  tags: string[]
}

export interface TaskProfileInput {
  prompt: string
  attachments?: Array<{ mime: string }>
  requestedTasks?: ModelTaskKind[]
  contextTokens?: number
  expectedOutputTokens?: number
  strategy?: SchedulerStrategy
  requiresTools?: boolean
  riskLevel?: 'low' | 'medium' | 'high'
}

export interface TaskProfile {
  taskKinds: ModelTaskKind[]
  minContextTokens: number
  expectedInputTokens: number
  expectedOutputTokens: number
  requiresTools: boolean
  requiresVision: boolean
  riskLevel: 'low' | 'medium' | 'high'
  strategy: SchedulerStrategy
}

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_INPUT_TOKENS = 4_000
const DEFAULT_OUTPUT_TOKENS = 2_000

const MEDIUM_CAPABILITY: ModelCapabilityProfile = {
  coding: 'medium',
  reasoning: 'medium',
  toolUse: 'medium',
  vision: 'low',
  longContext: 'medium',
  summarization: 'medium'
}

export function createFallbackProfile(providerId: string, model: string, providerName?: string): ModelProfile {
  const lower = model.toLowerCase()
  const isBudget = hasAny(lower, ['mini', 'lite', 'flash', 'haiku', 'chat'])
  const isReasoning = hasAny(lower, ['reason', 'thinking', 'r1', 'o3', 'opus', 'sonnet'])
  const isVision = hasAny(lower, ['vision', 'gpt-4o', 'gemini', 'qwen-vl'])
  return {
    providerId,
    providerName,
    model,
    capabilities: {
      ...MEDIUM_CAPABILITY,
      coding: isReasoning ? 'high' : 'medium',
      reasoning: isReasoning ? 'high' : 'medium',
      toolUse: 'medium',
      vision: isVision ? 'high' : 'low',
      longContext: hasAny(lower, ['claude', 'gemini', 'qwen-long']) ? 'high' : 'medium',
      summarization: 'medium'
    },
    cost: isBudget
      ? { inputUsdPerMTok: 0.25, outputUsdPerMTok: 1, tier: 'low' }
      : isReasoning
        ? { inputUsdPerMTok: 3, outputUsdPerMTok: 15, tier: 'high' }
        : { inputUsdPerMTok: 1, outputUsdPerMTok: 5, tier: 'medium' },
    latency: isBudget ? 'fast' : isReasoning ? 'slow' : 'balanced',
    contextWindowTokens: hasAny(lower, ['gemini', 'claude', 'qwen-long']) ? 200_000 : DEFAULT_CONTEXT_WINDOW,
    supportsTools: true,
    supportsVision: isVision,
    tags: ['fallback']
  }
}

export function buildModelProfiles(input: {
  providerId: string
  providerName?: string
  models: string[]
  engine?: EngineKind
}): ModelProfile[] {
  return input.models.map((model) => {
    const known = knownProfile(input.providerId, model, input.providerName)
    return { ...(known ?? createFallbackProfile(input.providerId, model, input.providerName)), engine: input.engine }
  })
}

export function inferTaskProfile(input: TaskProfileInput): TaskProfile {
  const prompt = input.prompt.toLowerCase()
  const requested = new Set<ModelTaskKind>(input.requestedTasks ?? [])
  if (hasAny(prompt, ['code', 'typescript', 'bug', 'refactor', '测试', '修复', '代码', '实现'])) requested.add('coding')
  if (hasAny(prompt, ['reason', '推理', '规划', '架构', '分析', 'why'])) requested.add('reasoning')
  if (hasAny(prompt, ['review', '审查', 'diff', '风险'])) requested.add('review')
  if (hasAny(prompt, ['总结', '摘要', 'summarize'])) requested.add('summarization')
  if ((input.contextTokens ?? 0) > 96_000 || hasAny(prompt, ['长上下文', 'large context', '全仓'])) requested.add('longContext')
  if (input.requiresTools || hasAny(prompt, ['tool', 'shell', '文件', '执行', '读取'])) requested.add('toolUse')

  const requiresVision = (input.attachments ?? []).some((item) => item.mime.startsWith('image/'))
  if (requiresVision) requested.add('vision')
  if (requested.size === 0) requested.add('chat')

  const contextTokens = Math.max(input.contextTokens ?? DEFAULT_INPUT_TOKENS, DEFAULT_INPUT_TOKENS)
  const expectedOutputTokens = Math.max(input.expectedOutputTokens ?? DEFAULT_OUTPUT_TOKENS, 256)

  return {
    taskKinds: [...requested],
    minContextTokens: Math.max(contextTokens + expectedOutputTokens, 8_000),
    expectedInputTokens: contextTokens,
    expectedOutputTokens,
    requiresTools: input.requiresTools ?? requested.has('toolUse'),
    requiresVision,
    riskLevel: input.riskLevel ?? (requested.has('review') || requested.has('reasoning') ? 'medium' : 'low'),
    strategy: input.strategy ?? 'balanced'
  }
}

export function scoreProfileForTask(profile: ModelProfile, task: TaskProfile): number {
  let score = 0
  for (const kind of task.taskKinds) score += capabilityScore(profile, kind)
  if (profile.contextWindowTokens >= task.minContextTokens) score += 16
  if (task.requiresTools && profile.supportsTools) score += 10
  if (task.requiresVision && profile.supportsVision) score += 16
  if (task.strategy === 'cost') score += costBias(profile)
  if (task.strategy === 'quality') score += qualityBias(profile)
  if (task.strategy === 'balanced') score += costBias(profile) / 2 + qualityBias(profile) / 2
  if (profile.latency === 'fast') score += 3
  if (profile.latency === 'slow' && task.strategy !== 'quality') score -= 2
  return score
}

export function estimateCostUsd(profile: ModelProfile, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * profile.cost.inputUsdPerMTok + (outputTokens / 1_000_000) * profile.cost.outputUsdPerMTok
}

function knownProfile(providerId: string, model: string, providerName?: string): ModelProfile | undefined {
  const lower = model.toLowerCase()
  if (lower.includes('deepseek-chat')) {
    return {
      providerId,
      providerName,
      model,
      capabilities: { ...MEDIUM_CAPABILITY, coding: 'medium', toolUse: 'medium' },
      cost: { inputUsdPerMTok: 0.27, outputUsdPerMTok: 1.1, tier: 'low' },
      latency: 'fast',
      contextWindowTokens: 64_000,
      supportsTools: true,
      supportsVision: false,
      tags: ['chat', 'budget']
    }
  }
  if (lower.includes('deepseek-reasoner') || lower.includes('r1')) {
    return {
      providerId,
      providerName,
      model,
      capabilities: { ...MEDIUM_CAPABILITY, coding: 'high', reasoning: 'high', toolUse: 'medium' },
      cost: { inputUsdPerMTok: 0.55, outputUsdPerMTok: 2.19, tier: 'medium' },
      latency: 'slow',
      contextWindowTokens: 64_000,
      supportsTools: true,
      supportsVision: false,
      tags: ['reasoning']
    }
  }
  if (lower.includes('gpt-4o-mini') || lower.includes('mini')) {
    return {
      providerId,
      providerName,
      model,
      capabilities: { ...MEDIUM_CAPABILITY, vision: 'medium', summarization: 'high' },
      cost: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6, tier: 'low' },
      latency: 'fast',
      contextWindowTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
      tags: ['budget', 'vision']
    }
  }
  if (lower.includes('gpt-4o') || lower.includes('sonnet') || lower.includes('opus')) {
    return {
      providerId,
      providerName,
      model,
      capabilities: { coding: 'high', reasoning: 'high', toolUse: 'high', vision: 'high', longContext: 'high', summarization: 'high' },
      cost: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, tier: 'high' },
      latency: 'balanced',
      contextWindowTokens: lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') ? 200_000 : 128_000,
      supportsTools: true,
      supportsVision: !lower.includes('claude'),
      tags: ['quality']
    }
  }
  return undefined
}

function capabilityScore(profile: ModelProfile, kind: ModelTaskKind): number {
  if (kind === 'chat') return 8
  if (kind === 'coding') return strengthScore(profile.capabilities.coding)
  if (kind === 'reasoning') return strengthScore(profile.capabilities.reasoning)
  if (kind === 'vision') return strengthScore(profile.capabilities.vision)
  if (kind === 'toolUse') return strengthScore(profile.capabilities.toolUse)
  if (kind === 'longContext') return strengthScore(profile.capabilities.longContext)
  if (kind === 'review') return Math.round((strengthScore(profile.capabilities.coding) + strengthScore(profile.capabilities.reasoning)) / 2)
  return strengthScore(profile.capabilities.summarization)
}

function strengthScore(strength: ModelStrength): number {
  if (strength === 'high') return 20
  if (strength === 'medium') return 12
  return 3
}

function costBias(profile: ModelProfile): number {
  if (profile.cost.tier === 'low') return 12
  if (profile.cost.tier === 'medium') return 6
  return 0
}

function qualityBias(profile: ModelProfile): number {
  if (profile.cost.tier === 'high') return 8
  if (profile.cost.tier === 'medium') return 4
  return 0
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle))
}
