export const PROJECT_RULE_SECTIONS = [
  { key: 'prompt', title: '项目提示词' },
  { key: 'background', title: '项目背景' },
  { key: 'techStack', title: '技术栈与架构' },
  { key: 'commands', title: '常用命令' },
  { key: 'testCommands', title: '测试命令' },
  { key: 'buildCommands', title: '构建命令' },
  { key: 'forbiddenPaths', title: '禁止修改目录' },
  { key: 'isolation', title: '工作区隔离策略' },
  { key: 'modelDispatch', title: '模型调度策略' },
  { key: 'memory', title: '项目记忆' },
  { key: 'decisions', title: '历史决策' },
  { key: 'acceptance', title: '交付验收' }
] as const

export type ProjectRuleSectionKey = (typeof PROJECT_RULE_SECTIONS)[number]['key']
export type ProjectRuleDraft = Record<ProjectRuleSectionKey, string>

interface Segment {
  title?: string
  lines: string[]
}

export function emptyProjectRuleDraft(): ProjectRuleDraft {
  return Object.fromEntries(PROJECT_RULE_SECTIONS.map((section) => [section.key, ''])) as ProjectRuleDraft
}

export function parseProjectRuleDraft(content: string): ProjectRuleDraft {
  const draft = emptyProjectRuleDraft()
  const byTitle = new Map(splitProjectRuleSegments(content).flatMap((segment) =>
    segment.title ? [[normalizeTitle(segment.title), segmentBody(segment)]] : []
  ))
  for (const section of PROJECT_RULE_SECTIONS) {
    draft[section.key] = byTitle.get(normalizeTitle(section.title)) ?? ''
  }
  return draft
}

export function mergeProjectRuleDraft(content: string, draft: Partial<ProjectRuleDraft>): string {
  const segments = splitProjectRuleSegments(content)
  const usedKeys = new Set<ProjectRuleSectionKey>()
  const sectionByTitle = new Map(PROJECT_RULE_SECTIONS.map((section) => [normalizeTitle(section.title), section]))
  const nextSegments = segments.map((segment) => {
    if (!segment.title) return segment
    const section = sectionByTitle.get(normalizeTitle(segment.title))
    if (!section || draft[section.key] === undefined) return segment
    usedKeys.add(section.key)
    return sectionSegment(section.title, draft[section.key] ?? '')
  })

  for (const section of PROJECT_RULE_SECTIONS) {
    if (draft[section.key] === undefined || usedKeys.has(section.key)) continue
    nextSegments.push(sectionSegment(section.title, draft[section.key] ?? ''))
  }

  return normalizeTrailingNewline(
    nextSegments
      .flatMap((segment, index) => {
        const lines = [...segment.lines]
        if (index > 0 && lines[0] !== '') return ['', ...lines]
        return lines
      })
      .join('\n')
  )
}

function splitProjectRuleSegments(content: string): Segment[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const segments: Segment[] = []
  let current: Segment = { lines: [] }
  for (const line of lines) {
    const heading = /^#\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (current.lines.length > 0) segments.push(current)
      current = { title: heading[1], lines: [line] }
      continue
    }
    current.lines.push(line)
  }
  if (current.lines.length > 0 || segments.length === 0) segments.push(current)
  return segments
}

function segmentBody(segment: Segment): string {
  return segment.lines.slice(segment.title ? 1 : 0).join('\n').trim()
}

function sectionSegment(title: string, body: string): Segment {
  const normalizedBody = body.replace(/\r\n?/g, '\n').trim()
  return {
    title,
    lines: normalizedBody ? [`# ${title}`, ...normalizedBody.split('\n')] : [`# ${title}`, '- ']
  }
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, '')
}

function normalizeTrailingNewline(value: string): string {
  return `${value.replace(/\s+$/g, '')}\n`
}
