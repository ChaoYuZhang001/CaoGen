export const COMMUNITY_RESPONSE_SLA_HOURS = 48

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const RESPONSE_STATUSES = [
  'maintainer_authored',
  'pending',
  'overdue',
  'responded_on_time',
  'responded_late'
]

export function isMaintainerAssociation(value) {
  return MAINTAINER_ASSOCIATIONS.has(String(value || '').toUpperCase())
}

export function expandDiscussionFeedback(node) {
  const comments = node.comments?.nodes || []
  const discussion = {
    kind: 'discussion',
    number: node.number,
    title: node.title,
    url: node.url,
    createdAt: node.createdAt,
    authorAssociation: node.authorAssociation,
    responses: comments.flatMap((comment) => [comment, ...(comment.replies?.nodes || [])])
  }

  if (!isMaintainerAssociation(node.authorAssociation)) return [discussion]

  const externalCommentThreads = comments
    .filter((comment) => !isMaintainerAssociation(comment.authorAssociation))
    .map((comment) => ({
      kind: 'discussion_comment',
      number: node.number,
      title: `External comment on: ${node.title}`,
      url: comment.url || node.url,
      createdAt: comment.createdAt,
      authorAssociation: comment.authorAssociation,
      responses: comment.replies?.nodes || []
    }))

  return [discussion, ...externalCommentThreads]
}

export function classifyCommunityFeedback(item, options = {}) {
  const nowMs = parseTimestamp(options.now ?? Date.now(), 'now')
  const slaHours = options.slaHours ?? COMMUNITY_RESPONSE_SLA_HOURS
  if (!Number.isFinite(slaHours) || slaHours <= 0) throw new Error('slaHours must be greater than zero')

  const createdAtMs = parseTimestamp(item.createdAt, 'createdAt')
  const deadlineMs = createdAtMs + slaHours * 60 * 60 * 1000
  const firstResponseMs = firstMaintainerResponse(item.responses, createdAtMs)
  const status = responseStatus(item.authorAssociation, firstResponseMs, deadlineMs, nowMs)

  return {
    kind: item.kind,
    number: item.number,
    title: item.title,
    url: item.url,
    status,
    createdAt: new Date(createdAtMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    firstMaintainerResponseAt: firstResponseMs === undefined ? null : new Date(firstResponseMs).toISOString(),
    ageHours: roundHours(nowMs - createdAtMs)
  }
}

function firstMaintainerResponse(responses, createdAtMs) {
  return (responses || [])
    .filter((response) => isMaintainerAssociation(response.authorAssociation))
    .map((response) => parseTimestamp(response.createdAt, 'response.createdAt'))
    .filter((timestamp) => timestamp >= createdAtMs)
    .sort((left, right) => left - right)
    .at(0)
}

function responseStatus(authorAssociation, firstResponseMs, deadlineMs, nowMs) {
  if (isMaintainerAssociation(authorAssociation)) return 'maintainer_authored'
  if (firstResponseMs !== undefined) return firstResponseMs <= deadlineMs ? 'responded_on_time' : 'responded_late'
  return nowMs > deadlineMs ? 'overdue' : 'pending'
}

export function summarizeCommunityFeedback(items, options = {}) {
  const classified = items.map((item) => classifyCommunityFeedback(item, options))
  const counts = Object.fromEntries(RESPONSE_STATUSES.map((status) => [status, 0]))
  for (const item of classified) counts[item.status] += 1
  return { counts: { total: classified.length, ...counts }, items: classified }
}

function parseTimestamp(value, label) {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid timestamp`)
  return timestamp
}

function roundHours(milliseconds) {
  return Math.round((milliseconds / (60 * 60 * 1000)) * 100) / 100
}
