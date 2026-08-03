export const PROJECT_ID = 'verified-delivery-project'
export const GOAL_ID = 'verified-delivery-goal'
export const REPORT_GENERATED_AT = 1_800_000_000_000
export const REVIEW_FAILURE_CANARY =
  'VERIFIED_DELIVERY_RAW_REVIEW_FAILURE_CANARY_9A3E6B7D'
export const OWNER = Object.freeze({
  type: 'digital_worker',
  id: 'verified-delivery-agent',
  displayName: 'Verified delivery agent'
})

export const STAGES = Object.freeze([
  stage('research', 'research', 'report', [], 'passed'),
  stage('requirements', 'planning', 'requirement', ['research'], 'waived'),
  stage('design', 'design', 'design', ['requirements'], 'passed'),
  stage('implementation', 'coding', 'code', ['design'], 'passed'),
  stage('review', 'review', 'report', ['implementation'], 'failed'),
  stage('test', 'testing', 'test_report', ['review'], 'passed'),
  stage('delivery', 'delivery', 'release_package', ['test'], 'passed')
])

export const FLOW_ORDER = Object.freeze([
  'research',
  'requirements',
  'design',
  'implementation',
  'review',
  'repair',
  'test',
  'delivery'
])

export const REVIEW_V2 = Object.freeze({
  artifactId: 'verified-artifact-review-v2',
  runId: 'verified-run-review-repair-v2',
  sessionId: 'verified-session-review-repair-v2',
  evidenceId: 'verified-evidence-review-v2',
  version: 2,
  content: 'review report v2: repaired implementation satisfies the delivery contract\n'
})

export function stageByName(name) {
  const result = STAGES.find((candidate) => candidate.name === name)
  if (!result) throw new Error(`unknown verified-delivery stage: ${String(name)}`)
  return result
}

export function workItemId(name) {
  return `verified-work-${name}`
}

export function runId(name) {
  return `verified-run-${name}-v1`
}

export function sessionId(name) {
  return `verified-session-${name}-v1`
}

export function artifactId(name) {
  return `verified-artifact-${name}-v1`
}

export function evidenceId(name) {
  return `verified-evidence-${name}-v1`
}

export function acceptanceId(name) {
  return `verified-acceptance-${name}`
}

export function evidenceLinkId(name, version = 1) {
  return `verified-link-${name}-v${version}`
}

function stage(name, type, artifactKind, dependencies, decision) {
  return Object.freeze({
    name,
    type,
    artifactKind,
    decision,
    workItemId: workItemId(name),
    runId: runId(name),
    sessionId: sessionId(name),
    artifactId: artifactId(name),
    evidenceId: evidenceId(name),
    acceptanceId: acceptanceId(name),
    evidenceLinkId: evidenceLinkId(name),
    lineageId: `verified-lineage-${name}`,
    title: `${capitalize(name)} stage`,
    artifactTitle: `${capitalize(name)} deliverable`,
    criterion: `${name} deliverable is fit for downstream use`,
    content: `${name} artifact v1: canonical verified-delivery fixture\n`,
    dependencyIds: dependencies.map(workItemId)
  })
}

function capitalize(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}
