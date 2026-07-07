import type { ModelRoutePlanView, SessionMeta, TranscriptEntry } from '../../shared/types'

export interface CrossValidationReviewInput {
  parentMeta: SessionMeta
  routePlan: ModelRoutePlanView
  resultText: string
  transcript: readonly TranscriptEntry[]
  turnSeq?: number
}

export interface CrossValidationArbitrationInput {
  parentMeta: SessionMeta
  routePlan: ModelRoutePlanView
  primaryResultText: string
  reviewerResultText: string
  transcript: readonly TranscriptEntry[]
  turnSeq?: number
}

export type CrossValidationTarget = ModelRoutePlanView['validators'][number]

const MAX_USER_PROMPT_CHARS = 2000
const MAX_RESULT_CHARS = 6000

export function firstCrossValidationTarget(plan: ModelRoutePlanView): CrossValidationTarget | null {
  if (!plan.enabled || plan.validators.length === 0) return null
  return plan.validators[0]
}

export function arbitrationCrossValidationTarget(plan: ModelRoutePlanView): CrossValidationTarget | null {
  if (!plan.enabled || plan.validators.length < 2) return null
  return plan.validators[1]
}

export function needsCrossValidationArbitration(reviewText: string): boolean {
  const upper = reviewText.toUpperCase()
  return upper.includes('ARBITRATION_REQUIRED') || upper.includes('BLOCKED') || upper.includes('CONCERNS')
}

export function buildCrossValidationReviewPrompt(input: CrossValidationReviewInput): string {
  const validator = firstCrossValidationTarget(input.routePlan)
  if (!validator) throw new Error('cross validation plan has no validator')
  const userPrompt = latestUserPrompt(input.transcript)
  const primary = formatModel(input.routePlan.primary)
  const reviewer = formatModel(validator)
  const lines = [
    '[P2-003 模型交叉复核]',
    '',
    '你是第二模型 Code Review 审查员。请只复核主模型本轮输出，不要直接修改文件，也不要执行高风险命令。',
    '',
    `原会话: ${input.parentMeta.title || input.parentMeta.id}`,
    `工作目录: ${input.parentMeta.sourceCwd ?? input.parentMeta.cwd}`,
    `主模型: ${primary}`,
    `复核模型: ${reviewer}`,
    `复核策略: ${input.routePlan.policy}`,
    `触发原因: ${input.routePlan.reason}`,
    input.turnSeq === undefined ? '' : `事件序号: ${input.turnSeq}`,
    '',
    '## 用户请求摘录',
    truncate(userPrompt || '(未捕获到用户请求)', MAX_USER_PROMPT_CHARS),
    '',
    '## 主模型输出',
    truncate(input.resultText, MAX_RESULT_CHARS),
    '',
    '## 请输出',
    '1. 结论: PASS / CONCERNS / BLOCKED / ARBITRATION_REQUIRED',
    '2. 关键风险: 列出会导致 Bug、回归、安全或验收失败的问题',
    '3. 遗漏项: 对照用户请求指出缺口',
    '4. 测试缺口: 指出还需要跑的最小验证命令',
    '5. 仲裁建议: 如果与主模型结论冲突，说明是否需要第三模型或人工仲裁',
    '',
    '要求: 用中文回答，优先给文件/函数级证据；没有问题时明确说 PASS。'
  ]
  return lines.filter((line) => line.length > 0).join('\n')
}

export function buildCrossValidationArbitrationPrompt(input: CrossValidationArbitrationInput): string {
  const target = arbitrationCrossValidationTarget(input.routePlan)
  if (!target) throw new Error('cross validation plan has no arbitration target')
  const userPrompt = latestUserPrompt(input.transcript)
  const primary = formatModel(input.routePlan.primary)
  const arbitrator = formatModel(target)
  const reviewer = formatModel(input.routePlan.validators[0])
  const lines = [
    '[P2-003 模型交叉仲裁]',
    '',
    '你是第三方仲裁模型。请比较主模型输出与第二模型复核意见，给出最终可执行结论。不要直接修改文件，也不要执行高风险命令。',
    '',
    `原会话: ${input.parentMeta.title || input.parentMeta.id}`,
    `工作目录: ${input.parentMeta.sourceCwd ?? input.parentMeta.cwd}`,
    `主模型: ${primary}`,
    `复核模型: ${reviewer}`,
    `仲裁模型: ${arbitrator}`,
    input.turnSeq === undefined ? '' : `事件序号: ${input.turnSeq}`,
    '',
    '## 用户请求摘录',
    truncate(userPrompt || '(未捕获到用户请求)', MAX_USER_PROMPT_CHARS),
    '',
    '## 主模型输出',
    truncate(input.primaryResultText, MAX_RESULT_CHARS),
    '',
    '## 第二模型复核意见',
    truncate(input.reviewerResultText, MAX_RESULT_CHARS),
    '',
    '## 请输出',
    '1. 仲裁结论: PRIMARY_OK / REVIEWER_OK / BOTH_NEED_FIX / NEED_HUMAN',
    '2. 最小修复建议: 如需修复，给出文件/函数级建议',
    '3. 最小验证命令: 给出下一步应跑的命令',
    '4. 风险等级: low / medium / high',
    '',
    '要求: 用中文回答，证据优先；不能判断时输出 NEED_HUMAN。'
  ]
  return lines.filter((line) => line.length > 0).join('\n')
}

function latestUserPrompt(transcript: readonly TranscriptEntry[]): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const event = transcript[index]?.event
    if (event?.kind === 'user-message') return event.text
  }
  return ''
}

function formatModel(model: { providerId: string; providerName?: string; model: string }): string {
  return `${model.providerName ?? model.providerId}/${model.model}`
}

function truncate(value: string, maxChars: number): string {
  const clean = value.replace(/\s+$/g, '').trim()
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, maxChars - 40)}\n...[已截断 ${clean.length - maxChars + 40} 字符]`
}
