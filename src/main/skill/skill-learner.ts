import { serializeSkill } from './skill-loader'
import { testSkillMarkdown, type SkillTestDiagnostic, type SkillTestResult } from './skill-tester'

export interface SkillLearningInput {
  taskSummary: string
  title?: string
  description?: string
  trigger?: string
  tags?: string[]
  steps?: string[]
  verification?: string[]
  notes?: string[]
  version?: string
}

export interface SkillDraft {
  name: string
  description: string
  trigger?: string
  tags: string[]
  version: string
  markdown: string
  diagnostics: SkillTestDiagnostic[]
  ok: boolean
}

export interface SkillLearnerOptions {
  maxSummaryChars?: number
  defaultTags?: string[]
  validate?: boolean
}

const DEFAULT_MAX_SUMMARY_CHARS = 4_000
const DEFAULT_VERSION = '0.1.0'

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'into',
  'should',
  'must',
  '需要',
  '通过',
  '一个',
  '以及',
  '进行',
  '任务',
  '要求'
])

export class SkillLearner {
  private readonly maxSummaryChars: number
  private readonly defaultTags: string[]
  private readonly validate: boolean

  constructor(options: SkillLearnerOptions = {}) {
    this.maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS
    this.defaultTags = normalizeTags(options.defaultTags ?? ['learned'])
    this.validate = options.validate ?? true
  }

  draft(input: SkillLearningInput): SkillDraft {
    const summary = normalizeWhitespace(input.taskSummary).slice(0, this.maxSummaryChars)
    const name = cleanTitle(input.title) ?? inferTitle(summary)
    const description = cleanSentence(input.description) ?? inferDescription(summary, name)
    const trigger = cleanSentence(input.trigger) ?? inferTrigger(name, summary)
    const tags = normalizeTags([...this.defaultTags, ...(input.tags ?? []), ...inferTags(summary)])
    const steps = normalizeList(input.steps).length > 0 ? normalizeList(input.steps) : inferSteps(summary)
    const verification = normalizeList(input.verification).length > 0 ? normalizeList(input.verification) : inferVerification(summary)
    const notes = normalizeList(input.notes)
    const body = buildBody(name, description, summary, steps, verification, notes)
    const markdown = serializeSkill({
      name,
      description,
      trigger,
      tags,
      version: cleanSentence(input.version) ?? DEFAULT_VERSION,
      body
    })
    const test = this.validate ? testSkillMarkdown(markdown) : emptyTestResult()

    return {
      name,
      description,
      trigger,
      tags,
      version: cleanSentence(input.version) ?? DEFAULT_VERSION,
      markdown,
      diagnostics: test.diagnostics,
      ok: test.ok
    }
  }
}

export function draftSkillFromSummary(input: SkillLearningInput, options: SkillLearnerOptions = {}): SkillDraft {
  return new SkillLearner(options).draft(input)
}

function buildBody(
  name: string,
  description: string,
  summary: string,
  steps: string[],
  verification: string[],
  notes: string[]
): string {
  const lines = [
    `# ${name}`,
    '',
    description,
    '',
    '## 适用场景',
    `- ${summary || description}`,
    '',
    '## 执行步骤',
    ...steps.map((item, index) => `${index + 1}. ${item}`),
    '',
    '## 验证',
    ...verification.map((item, index) => `${index + 1}. ${item}`)
  ]
  if (notes.length > 0) {
    lines.push('', '## 注意事项', ...notes.map((item) => `- ${item}`))
  }
  return lines.join('\n')
}

function inferTitle(summary: string): string {
  const first = firstUsefulLine(summary)
  const cleaned = cleanTitle(first.replace(/^#+\s*/, '').replace(/[:：].*$/, ''))
  if (cleaned) return limitText(cleaned, 48)
  const keywords = topKeywords(summary, 4)
  return keywords.length > 0 ? limitText(`${keywords.join(' ')} Skill`, 48) : '自动沉淀 Skill'
}

function inferDescription(summary: string, name: string): string {
  const line = firstUsefulLine(summary)
  const cleaned = cleanSentence(line)
  if (cleaned && cleaned !== name) return limitText(cleaned, 120)
  return `从任务经验沉淀的可复用流程: ${name}`
}

function inferTrigger(name: string, summary: string): string {
  const keywords = topKeywords(`${name}\n${summary}`, 5)
  return keywords.length > 0 ? keywords.join(' ') : name
}

function inferTags(summary: string): string[] {
  const lower = summary.toLowerCase()
  const tags: string[] = []
  if (/(test|smoke|验证|测试)/i.test(lower)) tags.push('test')
  if (/(skill|技能|沉淀)/i.test(lower)) tags.push('skill')
  if (/(typescript|ts\b)/i.test(lower)) tags.push('typescript')
  if (/(sandbox|沙箱|安全|静态)/i.test(lower)) tags.push('safety')
  if (/(doc|markdown|文档)/i.test(lower)) tags.push('docs')
  return tags
}

function inferSteps(summary: string): string[] {
  const extracted = extractListItems(summary)
  if (extracted.length >= 2) return extracted.slice(0, 8)
  return [
    '读取任务摘要和相关上下文，确认可复用的触发场景。',
    '按既有项目边界整理执行步骤，避免引入默认副作用。',
    '生成 SKILL.md 草案并保留人工复核空间。'
  ]
}

function inferVerification(summary: string): string[] {
  const verificationHints = extractListItems(summary).filter((item) => /(验证|测试|smoke|typecheck|check|build)/i.test(item))
  if (verificationHints.length > 0) return verificationHints.slice(0, 5)
  return ['运行对应 smoke 或类型检查命令。', '检查草案包含名称、描述、执行步骤和验证章节。']
}

function extractListItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^(?:[-*]|\d+[.)]|[（(]?\d+[）)])\s*(.+)$/.exec(line.trim())?.[1])
    .filter((item): item is string => Boolean(item?.trim()))
    .map((item) => cleanSentence(item))
    .filter((item): item is string => Boolean(item))
}

function topKeywords(text: string, limit: number): string[] {
  const counts = new Map<string, number>()
  const tokens = text.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
  for (const raw of tokens) {
    const token = raw.toLowerCase().replace(/^[-_]+|[-_]+$/g, '')
    if (token.length < 2 || STOP_WORDS.has(token)) continue
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token)
}

function normalizeList(items: string[] | undefined): string[] {
  return (items ?? []).map((item) => cleanSentence(item)).filter((item): item is string => Boolean(item)).slice(0, 20)
}

function normalizeTags(tags: string[]): string[] {
  const out: string[] = []
  for (const tag of tags) {
    const cleaned = tag.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
    if (cleaned && !out.includes(cleaned)) out.push(cleaned)
  }
  return out.slice(0, 12)
}

function firstUsefulLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
}

function cleanTitle(value: string | undefined): string | undefined {
  const cleaned = cleanSentence(value)
  return cleaned ? limitText(cleaned, 60) : undefined
}

function cleanSentence(value: string | undefined): string | undefined {
  const cleaned = normalizeWhitespace(value ?? '').replace(/[<>]/g, '').trim()
  return cleaned || undefined
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

function limitText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`
}

function emptyTestResult(): Pick<SkillTestResult, 'ok' | 'diagnostics'> {
  return { ok: true, diagnostics: [] }
}
