import { loadSkills, serializeSkill, type SkillDefinition, type SkillLoadResult } from './skill-loader'

export interface SkillMatch {
  skill: SkillDefinition
  score: number
  reasons: string[]
}

export interface SkillManagerOptions {
  projectRoot?: string
  threshold?: number
}

const DEFAULT_THRESHOLD = 0.8

export class SkillManager {
  private readonly projectRoot?: string
  private skills: SkillDefinition[] = []
  private diagnostics: SkillLoadResult['diagnostics'] = []

  constructor(options: SkillManagerOptions = {}) {
    this.projectRoot = options.projectRoot
  }

  reload(): SkillLoadResult {
    const result = loadSkills(this.projectRoot)
    this.skills = result.skills
    this.diagnostics = result.diagnostics
    return result
  }

  list(): SkillDefinition[] {
    if (this.skills.length === 0) this.reload()
    return [...this.skills]
  }

  diagnosticsView(): SkillLoadResult['diagnostics'] {
    return [...this.diagnostics]
  }

  match(query: string, threshold = DEFAULT_THRESHOLD): SkillMatch[] {
    const text = query.trim()
    if (!text) return []
    return this.list()
      .map((skill) => scoreSkill(skill, text))
      .filter((match) => match.score >= threshold)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, 10)
  }

  exportSkill(skillId: string): string | null {
    const skill = this.list().find((item) => item.id === skillId)
    return skill ? serializeSkill(skill) : null
  }
}

export function scoreSkill(skill: SkillDefinition, query: string): SkillMatch {
  const queryTokens = tokenize(query)
  const haystackTokens = tokenize(
    [skill.name, skill.description, skill.trigger, skill.tags.join(' '), skill.body].filter(Boolean).join(' ')
  )
  const haystack = new Set(haystackTokens)
  const matched = queryTokens.filter((token) => haystack.has(token))
  const exactName = includesNormalized(query, skill.name)
  const triggerHit = skill.trigger ? includesNormalized(query, skill.trigger) || includesNormalized(skill.trigger, query) : false
  const tagHits = skill.tags.filter((tag) => includesNormalized(query, tag)).length
  const base = queryTokens.length === 0 ? 0 : matched.length / queryTokens.length
  const boosted = Math.min(1, base * 0.62 + (exactName ? 0.32 : 0) + (triggerHit ? 0.24 : 0) + Math.min(0.18, tagHits * 0.06))
  return {
    skill,
    score: Number(boosted.toFixed(3)),
    reasons: [
      exactName ? '名称命中' : '',
      triggerHit ? '触发词命中' : '',
      matched.length > 0 ? `关键词 ${matched.slice(0, 5).join(', ')}` : '',
      tagHits > 0 ? `标签命中 ${tagHits}` : ''
    ].filter(Boolean)
  }
}

function tokenize(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  if (!normalized) return []
  const words = normalized.split(/\s+/).filter((item) => item.length > 1)
  const chinese = Array.from(normalized.matchAll(/[\u4e00-\u9fa5]{2,}/g)).flatMap((match) => ngrams(match[0], 2, 4))
  return [...new Set([...words, ...chinese])]
}

function ngrams(value: string, min: number, max: number): string[] {
  const out: string[] = []
  for (let size = min; size <= max; size++) {
    for (let i = 0; i + size <= value.length; i++) out.push(value.slice(i, i + size))
  }
  return out
}

function includesNormalized(left: string, right: string): boolean {
  const a = left.toLowerCase().replace(/\s+/g, '')
  const b = right.toLowerCase().replace(/\s+/g, '')
  return Boolean(a && b && (a.includes(b) || b.includes(a)))
}
