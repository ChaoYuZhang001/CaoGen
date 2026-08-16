import { parseRequirements } from './product-acceptance-map.mjs'

const statusDatePattern = /^> 更新:\s*(\d{4}-\d{2}-\d{2})/m

const classifyPublicStatus = (status) => {
  if (status === '当前已验证') return 'verified'
  if (status.startsWith('当前已验证（基础')) return 'foundation'
  if (status.startsWith('当前已验证（')) return 'partial'
  if (status.startsWith('部分完成')) return 'partial'
  if (status === '条件可用') return 'conditional'
  if (status === '立项目标') return 'targets'
  return 'unclassified'
}

const projectPriority = (requirements, priority) => {
  const selected = requirements.filter((requirement) => requirement.priority === priority)
  const projection = {
    total: selected.length,
    verified: 0,
    partial: 0,
    conditional: 0,
    targets: 0,
    foundation: 0,
    open: 0
  }
  const unclassified = []

  for (const requirement of selected) {
    const bucket = classifyPublicStatus(requirement.status)
    if (bucket === 'unclassified') {
      unclassified.push({ id: requirement.id, status: requirement.status })
      continue
    }
    projection[bucket] += 1
  }

  if (unclassified.length > 0) {
    throw new Error(`unclassified ${priority} public statuses: ${JSON.stringify(unclassified)}`)
  }

  projection.open = projection.total - projection.verified
  if (Object.values(projection).slice(1, 6).reduce((sum, value) => sum + value, 0) !== projection.total) {
    throw new Error(`public ${priority} projection does not cover ${projection.total} requirements`)
  }
  return projection
}

export const derivePublicStatus = ({ productRequirements, statusDocument }) => {
  const requirements = parseRequirements(productRequirements)
  const snapshotDate = statusDocument.match(statusDatePattern)?.[1]

  if (!snapshotDate) throw new Error('STATUS.md must expose an update date')

  const p0 = projectPriority(requirements, 'P0')
  const p1 = projectPriority(requirements, 'P1')

  return {
    schemaVersion: 1,
    snapshotDate,
    source: {
      status: 'STATUS.md',
      requirements: 'docs/PRODUCT-REQUIREMENTS.md',
      acceptanceMatrix: 'docs/1.0-ACCEPTANCE-MATRIX.md'
    },
    classification: {
      verified: 'Only the exact status 当前已验证 is counted as verified.',
      partial: '部分完成 and qualified 当前已验证 statuses are conservatively grouped as partial.',
      foundation: 'Statuses beginning 当前已验证（基础 remain open foundation-only rows.'
    },
    p0,
    p1
  }
}

export const publicStatusParagraph = (status, locale = 'zh-CN') => {
  const { snapshotDate, p0 } = status
  if (locale === 'en') {
    return `As of ${snapshotDate}, the public projection of ${p0.total} PRD P0 requirements is ${p0.verified} strictly verified, ${p0.partial} partially complete or qualified, ${p0.targets} project targets, and ${p0.foundation} foundation-only; ${p0.open} remain open.`
  }
  return `截至 ${snapshotDate}，PRD ${p0.total} 个 P0 的公共投影为：${p0.verified} 个严格“当前已验证”、${p0.partial} 个“部分完成或资格受限”、${p0.targets} 个立项目标、${p0.foundation} 个仅达到基础；共 ${p0.open} 项仍开放。`
}
