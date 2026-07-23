import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactRecord,
  WorkflowEventRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceRecord,
  WorkflowGoalRecord,
  WorkflowLedgerExportScope,
  WorkflowRunRecord,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import {
  readAcceptances,
  readAndVerifyEvents,
  readArtifacts,
  readEvidenceLinks,
  readGoals,
  readRuns,
  readWorkItems
} from './workflow-ledger-query'
import { selectTaskEvidence, type TaskEvidenceRecord } from './task-evidence-store'
import { readAllWorkflowEvidenceForIntegrity } from './workflow-evidence-store'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'

export interface WorkflowLedgerClosedSelection {
  goals: WorkflowGoalRecord[]
  workItems: WorkflowWorkItemRecord[]
  runs: WorkflowRunRecord[]
  artifacts: WorkflowArtifactRecord[]
  acceptances: WorkflowAcceptanceRecord[]
  evidenceLinks: WorkflowEvidenceLinkRecord[]
  events: WorkflowEventRecord[]
  taskEvidence: TaskEvidenceRecord[]
  workflowEvidence: WorkflowEvidenceRecord[]
}

type CandidateRecordMap = {
  goals: WorkflowGoalRecord
  workItems: WorkflowWorkItemRecord
  runs: WorkflowRunRecord
  artifacts: WorkflowArtifactRecord
  acceptances: WorkflowAcceptanceRecord
  evidenceLinks: WorkflowEvidenceLinkRecord
  events: WorkflowEventRecord
  taskEvidence: TaskEvidenceRecord
  workflowEvidence: WorkflowEvidenceRecord
}

type CandidateKind = keyof CandidateRecordMap
type CandidateCollections = { [K in CandidateKind]: CandidateRecordMap[K][] }
type SelectedSets = { [K in CandidateKind]: Set<string> }

const TARGET_KEYS = [
  'goalId', 'workItemId', 'runId', 'sessionId', 'entityType', 'entityId',
  'eventKind', 'artifactId', 'acceptanceId'
] as const

/**
 * Select a scope as a closed, relation-aware subgraph. The ordinary query
 * selectors intentionally filter each table independently; an export needs a
 * stronger contract so an artifact/acceptance/event seed does not accidentally
 * return every unrelated projection from the same database.
 */
export function selectClosedWorkflowLedger(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerExportScope
): WorkflowLedgerClosedSelection {
  const candidates = readCandidates(db)
  const selected = seedSelection(candidates, scope)
  expandSelection(candidates, selected, scope)
  return materializeSelection(candidates, selected)
}

function readCandidates(db: WorkflowLedgerDatabase): CandidateCollections {
  return {
    goals: readGoals(db),
    workItems: readWorkItems(db),
    runs: readRuns(db),
    artifacts: readArtifacts(db),
    acceptances: readAcceptances(db),
    evidenceLinks: readEvidenceLinks(db),
    events: readAndVerifyEvents(db),
    taskEvidence: selectTaskEvidence(db),
    workflowEvidence: readAllWorkflowEvidenceForIntegrity(db)
  }
}

function seedSelection(
  candidates: CandidateCollections,
  scope: WorkflowLedgerExportScope
): SelectedSets {
  const selected = emptySelection()
  for (const kind of Object.keys(candidates) as CandidateKind[]) {
    for (const record of candidates[kind]) {
      if (matchesDirectScope(kind, record, scope, candidates)) {
        selected[kind].add(candidateId(kind, record))
      }
    }
  }
  return selected
}

function matchesDirectScope<K extends CandidateKind>(
  kind: K,
  record: CandidateRecordMap[K],
  scope: WorkflowLedgerExportScope,
  candidates: CandidateCollections
): boolean {
  if (!projectAllowed(kind, record, scope, candidates)) return false
  const targetKeys = applicableTargetKeys(kind)
  if (!hasTargetSelector(scope)) return true
  const presentKeys = targetKeys.filter((key) => scope[key] !== undefined)
  const requestedKeys = TARGET_KEYS.filter((key) => scope[key] !== undefined)
  // A selector is a conjunction, not a union of per-table seeds. A record
  // that cannot satisfy one requested dimension must not seed the closure.
  return requestedKeys.every((key) =>
    presentKeys.includes(key) && matchesScopeKey(kind, record, key, scope, candidates)
  )
}

function hasTargetSelector(scope: WorkflowLedgerExportScope): boolean {
  return TARGET_KEYS.some((key) => scope[key] !== undefined)
}

function applicableTargetKeys(kind: CandidateKind): readonly (typeof TARGET_KEYS[number])[] {
  switch (kind) {
    case 'goals': return ['goalId']
    case 'workItems': return ['goalId', 'workItemId']
    case 'runs': return ['goalId', 'workItemId', 'runId', 'sessionId']
    case 'artifacts': return ['goalId', 'workItemId', 'runId', 'artifactId']
    case 'acceptances': return ['goalId', 'workItemId', 'acceptanceId']
    case 'evidenceLinks': return ['runId', 'artifactId', 'acceptanceId']
    case 'events': return [
      'goalId', 'workItemId', 'runId', 'sessionId', 'entityType', 'entityId',
      'eventKind', 'artifactId', 'acceptanceId'
    ]
    case 'taskEvidence': return ['runId', 'sessionId']
    case 'workflowEvidence': return ['goalId', 'workItemId', 'runId', 'artifactId']
  }
}

function matchesScopeKey<K extends CandidateKind>(
  kind: K,
  record: CandidateRecordMap[K],
  key: typeof TARGET_KEYS[number],
  scope: WorkflowLedgerExportScope,
  candidates: CandidateCollections
): boolean {
  const expected = scope[key]
  if (expected === undefined) return true
  const value = record as unknown as Record<string, unknown>
  if (key === 'entityType') return kind === 'events' && value.entityType === expected
  if (key === 'eventKind') return kind === 'events' && value.kind === expected
  if (key === 'entityId') return kind === 'events' && value.entityId === expected
  if (key === 'artifactId') return artifactScopeMatch(kind, record, expected)
  if (key === 'acceptanceId') return acceptanceScopeMatch(kind, record, expected)
  return ownershipScopeMatch(kind, record, key, expected, candidates)
}

function ownershipScopeMatch<K extends CandidateKind>(
  kind: K,
  record: CandidateRecordMap[K],
  key: 'goalId' | 'workItemId' | 'runId' | 'sessionId',
  expected: string,
  candidates: CandidateCollections
): boolean {
  switch (kind) {
    case 'goals': return matchGoalOwnership(record as WorkflowGoalRecord, key, expected)
    case 'workItems': return matchWorkItemOwnership(record as WorkflowWorkItemRecord, key, expected)
    case 'runs': return matchRunOwnership(record as WorkflowRunRecord, key, expected)
    case 'artifacts': return matchArtifactOwnership(record as WorkflowArtifactRecord, key, expected, candidates)
    case 'acceptances': return matchAcceptanceOwnership(record as WorkflowAcceptanceRecord, key, expected, candidates)
    case 'evidenceLinks': return key === 'runId' && (record as WorkflowEvidenceLinkRecord).runId === expected
    case 'taskEvidence': return matchEvidenceOwnership(record as TaskEvidenceRecord, key, expected)
    case 'workflowEvidence': return matchWorkflowEvidenceOwnership(
      record as WorkflowEvidenceRecord, key, expected
    )
    case 'events': return matchEventOwnership(record as WorkflowEventRecord, key, expected)
  }
}

function matchGoalOwnership(record: WorkflowGoalRecord, key: string, expected: string): boolean {
  return key === 'goalId' && record.id === expected
}

function matchWorkItemOwnership(record: WorkflowWorkItemRecord, key: string, expected: string): boolean {
  if (key === 'goalId') return record.goalId === expected
  return key === 'workItemId' && record.id === expected
}

function matchRunOwnership(record: WorkflowRunRecord, key: string, expected: string): boolean {
  const values: Record<string, string | undefined> = {
    goalId: record.goalId,
    workItemId: record.workItemId,
    runId: record.id,
    sessionId: record.sessionId
  }
  return values[key] === expected
}

function matchArtifactOwnership(
  record: WorkflowArtifactRecord,
  key: string,
  expected: string,
  candidates: CandidateCollections
): boolean {
  const values: Record<string, string | undefined> = {
    goalId: record.goalId,
    workItemId: record.workItemId,
    runId: record.runId
  }
  if (!values[key] && key === 'goalId' && record.workItemId) {
    values.goalId = candidates.workItems.find((item) => item.id === record.workItemId)?.goalId
  }
  if (!values[key] && key === 'goalId' && record.runId) {
    values.goalId = candidates.runs.find((run) => run.id === record.runId)?.goalId
  }
  if (!values[key] && key === 'workItemId' && record.runId) {
    values.workItemId = candidates.runs.find((run) => run.id === record.runId)?.workItemId
  }
  return values[key] === expected
}

function matchAcceptanceOwnership(
  record: WorkflowAcceptanceRecord,
  key: string,
  expected: string,
  candidates: CandidateCollections
): boolean {
  const values: Record<string, string | undefined> = {
    goalId: record.goalId,
    workItemId: record.workItemId
  }
  if (!values[key] && key === 'goalId' && record.workItemId) {
    values.goalId = candidates.workItems.find((item) => item.id === record.workItemId)?.goalId
  }
  return values[key] === expected
}

function matchEvidenceOwnership(record: TaskEvidenceRecord, key: string, expected: string): boolean {
  const values: Record<string, string | undefined> = {
    runId: record.runId,
    sessionId: record.sessionId
  }
  return values[key] === expected
}

function matchWorkflowEvidenceOwnership(
  record: WorkflowEvidenceRecord,
  key: string,
  expected: string
): boolean {
  const values: Record<string, string | undefined> = {
    goalId: record.goalId,
    workItemId: record.workItemId,
    runId: record.runId,
    artifactId: record.artifactId
  }
  return values[key] === expected
}

function matchEventOwnership(record: WorkflowEventRecord, key: string, expected: string): boolean {
  const values: Record<string, string | undefined> = {
    goalId: record.goalId ?? payloadString(record, 'goalId'),
    workItemId: record.workItemId ?? payloadString(record, 'workItemId'),
    runId: record.runId ?? payloadString(record, 'runId'),
    sessionId: record.sessionId ?? payloadString(record, 'sessionId')
  }
  return values[key] === expected
}

function artifactScopeMatch<K extends CandidateKind>(
  kind: K,
  record: CandidateRecordMap[K],
  expected: string
): boolean {
  const value = record as unknown as Record<string, unknown>
  if (kind === 'artifacts') return value.id === expected
  if (kind === 'evidenceLinks') return value.artifactId === expected
  if (kind === 'workflowEvidence') return value.artifactId === expected
  if (kind !== 'events') return false
  const event = record as WorkflowEventRecord
  return event.entityType === 'artifact' && event.entityId === expected ||
    payloadString(event, 'artifactId') === expected ||
    payloadString(event, 'fromArtifactId') === expected ||
    payloadString(event, 'toArtifactId') === expected
}

function acceptanceScopeMatch<K extends CandidateKind>(
  kind: K,
  record: CandidateRecordMap[K],
  expected: string
): boolean {
  const value = record as unknown as Record<string, unknown>
  if (kind === 'acceptances') return value.id === expected
  if (kind === 'evidenceLinks') return value.acceptanceId === expected
  if (kind !== 'events') return false
  const event = record as WorkflowEventRecord
  return event.entityType === 'acceptance' && event.entityId === expected ||
    payloadString(event, 'acceptanceId') === expected
}

function projectAllowed<K extends CandidateKind>(
  kind: K,
  record: CandidateRecordMap[K],
  scope: WorkflowLedgerExportScope,
  candidates: CandidateCollections
): boolean {
  if (!scope.projectId) return true
  const value = record as unknown as Record<string, unknown>
  if (value.projectId === scope.projectId) return true
  if (value.projectId !== undefined) return false
  if (kind === 'taskEvidence') {
    return candidates.runs.some((run) => run.id === value.runId && run.projectId === scope.projectId)
  }
  if (kind === 'events') {
    const event = record as WorkflowEventRecord
    const payloadRunId = payloadString(event, 'runId')
    const payloadSessionId = payloadString(event, 'sessionId')
    const runId = event.runId ?? payloadRunId
    const sessionId = event.sessionId ?? payloadSessionId
    const ownerRuns = runId
      ? candidates.runs.filter((run) => run.id === runId)
      : sessionId
        ? candidates.runs.filter((run) => run.sessionId === sessionId)
        : []
    // Session-only/system events have no project column. They are safe to
    // retain only when every resolved session owner belongs to this project.
    return ownerRuns.length > 0 && ownerRuns.every((run) => run.projectId === scope.projectId)
  }
  return false
}

function emptySelection(): SelectedSets {
  return {
    goals: new Set(),
    workItems: new Set(),
    runs: new Set(),
    artifacts: new Set(),
    acceptances: new Set(),
    evidenceLinks: new Set(),
    events: new Set(),
    taskEvidence: new Set(),
    workflowEvidence: new Set()
  }
}

function expandSelection(
  candidates: CandidateCollections,
  selected: SelectedSets,
  scope: WorkflowLedgerExportScope
): void {
  let changed = true
  while (changed) {
    changed = false
    changed = expandGoals(candidates, selected, scope) || changed
    changed = expandWorkItems(candidates, selected, scope) || changed
    changed = expandRuns(candidates, selected, scope) || changed
    changed = expandArtifacts(candidates, selected, scope) || changed
    changed = expandAcceptances(candidates, selected, scope) || changed
    changed = expandEvidenceLinks(candidates, selected, scope) || changed
    changed = expandTaskEvidence(candidates, selected, scope) || changed
    changed = expandWorkflowEvidence(candidates, selected, scope) || changed
    changed = expandEvents(candidates, selected, scope) || changed
  }
}

function expandGoals(candidates: CandidateCollections, selected: SelectedSets, scope: WorkflowLedgerExportScope): boolean {
  // Goal ownership is an upward terminal relation. Descendants are seeded
  // directly when goalId is requested; adding them here would turn a narrow
  // artifact/run/acceptance export into the entire Goal subtree.
  return false
}

function expandWorkItems(candidates: CandidateCollections, selected: SelectedSets, scope: WorkflowLedgerExportScope): boolean {
  let changed = false
  for (const item of candidates.workItems) {
    if (!selected.workItems.has(item.id)) continue
    if (item.goalId) changed = addSelected('goals', item.goalId, candidates, selected, scope) || changed
    if (item.parentId) changed = addSelected('workItems', item.parentId, candidates, selected, scope) || changed
    for (const runId of item.runIds) {
      changed = addSelected('runs', runId, candidates, selected, scope) || changed
    }
  }
  return changed
}

function expandRuns(candidates: CandidateCollections, selected: SelectedSets, scope: WorkflowLedgerExportScope): boolean {
  let changed = false
  for (const run of candidates.runs) {
    if (!selected.runs.has(run.id)) continue
    changed = addSelected('workItems', run.workItemId, candidates, selected, scope) || changed
    if (run.goalId) changed = addSelected('goals', run.goalId, candidates, selected, scope) || changed
    // A direct Run/session/owner selector includes that Run's Artifacts.
    // Runs reached only as an owner of a narrow Artifact/Acceptance seed must
    // not fan out to every sibling Artifact.
    if (matchesDirectScope('runs', run, scope, candidates)) {
      for (const artifact of candidates.artifacts.filter((candidate) => candidate.runId === run.id)) {
        changed = addSelected('artifacts', artifact.id, candidates, selected, scope) || changed
      }
    }
  }
  return changed
}

function expandArtifacts(candidates: CandidateCollections, selected: SelectedSets, scope: WorkflowLedgerExportScope): boolean {
  let changed = false
  for (const artifact of candidates.artifacts) {
    if (!selected.artifacts.has(artifact.id)) continue
    if (artifact.workItemId) changed = addSelected('workItems', artifact.workItemId, candidates, selected, scope) || changed
    if (artifact.goalId) changed = addSelected('goals', artifact.goalId, candidates, selected, scope) || changed
    if (artifact.runId) changed = addSelected('runs', artifact.runId, candidates, selected, scope) || changed
    if (artifact.supersedesId) changed = addSelected('artifacts', artifact.supersedesId, candidates, selected, scope) || changed
  }
  return changed
}

function expandAcceptances(candidates: CandidateCollections, selected: SelectedSets, scope: WorkflowLedgerExportScope): boolean {
  let changed = false
  for (const acceptance of candidates.acceptances) {
    if (!selected.acceptances.has(acceptance.id)) continue
    if (acceptance.workItemId) changed = addSelected('workItems', acceptance.workItemId, candidates, selected, scope) || changed
    if (acceptance.goalId) changed = addSelected('goals', acceptance.goalId, candidates, selected, scope) || changed
    for (const link of candidates.evidenceLinks.filter((candidate) =>
      candidate.acceptanceId === acceptance.id ||
      (!candidate.acceptanceId && acceptance.evidenceRefs.includes(candidate.evidenceId))
    )) {
      changed = addSelected('evidenceLinks', link.id, candidates, selected, scope) || changed
    }
  }
  return changed
}

function expandEvidenceLinks(candidates: CandidateCollections, selected: SelectedSets, scope: WorkflowLedgerExportScope): boolean {
  let changed = false
  for (const link of candidates.evidenceLinks) {
    if (selected.evidenceLinks.has(link.id)) {
      if (link.runId) changed = addSelected('runs', link.runId, candidates, selected, scope) || changed
      if (link.artifactId) changed = addSelected('artifacts', link.artifactId, candidates, selected, scope) || changed
      if (link.acceptanceId) changed = addSelected('acceptances', link.acceptanceId, candidates, selected, scope) || changed
      const evidenceKind = link.evidenceOrigin === 'workflow' ? 'workflowEvidence' : 'taskEvidence'
      changed = addSelected(evidenceKind, link.evidenceId, candidates, selected, scope) || changed
    }
  }
  return changed
}

function expandTaskEvidence(candidates: CandidateCollections, selected: SelectedSets, scope: WorkflowLedgerExportScope): boolean {
  let changed = false
  for (const evidence of candidates.taskEvidence) {
    if (!selected.taskEvidence.has(evidence.evidenceId)) continue
    changed = addSelected('runs', evidence.runId, candidates, selected, scope) || changed
  }
  return changed
}

function expandWorkflowEvidence(
  candidates: CandidateCollections,
  selected: SelectedSets,
  scope: WorkflowLedgerExportScope
): boolean {
  let changed = false
  for (const evidence of candidates.workflowEvidence) {
    if (!selected.workflowEvidence.has(evidence.evidenceId)) continue
    changed = addOptionalSelected('goals', evidence.goalId, candidates, selected, scope) || changed
    changed = addOptionalSelected('workItems', evidence.workItemId, candidates, selected, scope) || changed
    changed = addOptionalSelected('runs', evidence.runId, candidates, selected, scope) || changed
    changed = addOptionalSelected('artifacts', evidence.artifactId, candidates, selected, scope) || changed
  }
  return changed
}

function expandEvents(candidates: CandidateCollections, selected: SelectedSets, scope: WorkflowLedgerExportScope): boolean {
  let changed = false
  for (const event of candidates.events) {
    if (eventTouchesSelection(event, candidates, selected)) {
      changed = addSelected('events', event.eventId, candidates, selected, scope) || changed
      changed = expandEventReferences(event, candidates, selected, scope) || changed
    }
  }
  for (const link of candidates.evidenceLinks) {
    if (linkTouchesSelection(link, selected)) {
      changed = addSelected('evidenceLinks', link.id, candidates, selected, scope) || changed
    }
  }
  for (const evidence of candidates.taskEvidence) {
    if (evidenceTouchesSelection(evidence, candidates, selected)) {
      changed = addSelected('taskEvidence', evidence.evidenceId, candidates, selected, scope) || changed
    }
  }
  for (const evidence of candidates.workflowEvidence) {
    if (workflowEvidenceTouchesSelection(evidence, candidates, selected)) {
      changed = addSelected('workflowEvidence', evidence.evidenceId, candidates, selected, scope) || changed
    }
  }
  return changed
}

function expandEventReferences(
  event: WorkflowEventRecord,
  candidates: CandidateCollections,
  selected: SelectedSets,
  scope: WorkflowLedgerExportScope
): boolean {
  return expandEventOwnerReferences(event, candidates, selected, scope) ||
    expandEventEntityReference(event, candidates, selected, scope) ||
    expandEventPayloadReferences(event, candidates, selected, scope)
}

function expandEventOwnerReferences(
  event: WorkflowEventRecord,
  candidates: CandidateCollections,
  selected: SelectedSets,
  scope: WorkflowLedgerExportScope
): boolean {
  return addOptionalSelected('goals', event.goalId, candidates, selected, scope) ||
    addOptionalSelected('workItems', event.workItemId, candidates, selected, scope) ||
    addOptionalSelected('runs', event.runId, candidates, selected, scope)
}

function expandEventEntityReference(
  event: WorkflowEventRecord,
  candidates: CandidateCollections,
  selected: SelectedSets,
  scope: WorkflowLedgerExportScope
): boolean {
  const targets: Partial<Record<WorkflowEventRecord['entityType'], CandidateKind>> = {
    goal: 'goals',
    work_item: 'workItems',
    run: 'runs',
    artifact: 'artifacts',
    acceptance: 'acceptances'
  }
  const kind = targets[event.entityType]
  return kind ? addSelected(kind, event.entityId, candidates, selected, scope) : false
}

function expandEventPayloadReferences(
  event: WorkflowEventRecord,
  candidates: CandidateCollections,
  selected: SelectedSets,
  scope: WorkflowLedgerExportScope
): boolean {
  const payloadTargets: Array<[string, CandidateKind]> = [
    ['goalId', 'goals'],
    ['workItemId', 'workItems'],
    ['runId', 'runs'],
    ['artifactId', 'artifacts'],
    ['fromArtifactId', 'artifacts'],
    ['toArtifactId', 'artifacts'],
    ['acceptanceId', 'acceptances']
  ]
  return payloadTargets.some(([key, kind]) =>
    addOptionalSelected(kind, payloadString(event, key), candidates, selected, scope)
  ) || expandEventEvidenceReference(event, candidates, selected, scope)
}

function expandEventEvidenceReference(
  event: WorkflowEventRecord,
  candidates: CandidateCollections,
  selected: SelectedSets,
  scope: WorkflowLedgerExportScope
): boolean {
  const evidenceId = payloadString(event, 'evidenceId')
  if (!evidenceId) return false
  if (event.kind === 'workflow.effect.evidence') {
    return addSelected('taskEvidence', evidenceId, candidates, selected, scope)
  }
  if (event.kind === 'workflow.evidence.recorded') {
    return addSelected('workflowEvidence', evidenceId, candidates, selected, scope)
  }
  return false
}

function addOptionalSelected<K extends CandidateKind>(
  kind: K,
  id: string | undefined,
  candidates: CandidateCollections,
  selected: SelectedSets,
  scope: WorkflowLedgerExportScope
): boolean {
  return id ? addSelected(kind, id, candidates, selected, scope) : false
}

function eventTouchesSelection(
  event: WorkflowEventRecord,
  candidates: CandidateCollections,
  selected: SelectedSets
): boolean {
  return selected.events.has(event.eventId) ||
    eventScopeTouchesSelection(event, candidates, selected) ||
    eventEntityTouchesSelection(event, selected) ||
    eventPayloadTouchesSelection(event, selected) ||
    eventLinkTouchesSelection(event, candidates, selected)
}

function eventScopeTouchesSelection(
  event: WorkflowEventRecord,
  candidates: CandidateCollections,
  selected: SelectedSets
): boolean {
  // Projection events are selected through their entity or explicit payload
  // reference. Matching their owner scope here would pull sibling entities
  // whenever an owner was reached indirectly from a narrow seed. System and
  // session-only events have no projection entity, so retain their ownership
  // scope as the intended relation.
  if (event.entityType !== 'system') return false
  const specificPayloadMatch = eventSpecificPayloadMatch(event, selected)
  if (specificPayloadMatch !== undefined) return specificPayloadMatch
  return Boolean(
    (event.goalId && selected.goals.has(event.goalId)) ||
    (event.workItemId && selected.workItems.has(event.workItemId)) ||
    (event.runId && selected.runs.has(event.runId)) ||
    (event.sessionId && candidates.runs.some((run) => selected.runs.has(run.id) && run.sessionId === event.sessionId))
  )
}

function eventSpecificPayloadMatch(
  event: WorkflowEventRecord,
  selected: SelectedSets
): boolean | undefined {
  const targetPairs: Array<[string | undefined, Set<string>]> = [
    [payloadString(event, 'acceptanceId'), selected.acceptances],
    [payloadString(event, 'artifactId'), selected.artifacts],
    [payloadString(event, 'fromArtifactId'), selected.artifacts],
    [payloadString(event, 'toArtifactId'), selected.artifacts]
  ]
  if (event.kind === 'workflow.effect.evidence') {
    targetPairs.push([payloadString(event, 'evidenceId'), selected.taskEvidence])
  } else if (event.kind === 'workflow.evidence.recorded') {
    targetPairs.push([payloadString(event, 'evidenceId'), selected.workflowEvidence])
  }
  const presentTargets = targetPairs.filter(([id]) => id !== undefined)
  return presentTargets.length > 0
    ? presentTargets.some(([id, ids]) => ids.has(id!))
    : undefined
}

function eventEntityTouchesSelection(event: WorkflowEventRecord, selected: SelectedSets): boolean {
  const targets: Partial<Record<WorkflowEventRecord['entityType'], Set<string>>> = {
    goal: selected.goals,
    work_item: selected.workItems,
    run: selected.runs,
    artifact: selected.artifacts,
    acceptance: selected.acceptances
  }
  return Boolean(targets[event.entityType]?.has(event.entityId))
}

function eventPayloadTouchesSelection(event: WorkflowEventRecord, selected: SelectedSets): boolean {
  const specificPayloadMatch = eventSpecificPayloadMatch(event, selected)
  if (specificPayloadMatch !== undefined) return specificPayloadMatch
  if (event.entityType !== 'system') return false
  const ownerPayloadTargets: Array<[string, Set<string>]> = [
    ['goalId', selected.goals],
    ['workItemId', selected.workItems],
    ['runId', selected.runs]
  ]
  return ownerPayloadTargets.some(([key, ids]) => payloadSelected(event, key, ids))
}

function eventLinkTouchesSelection(
  event: WorkflowEventRecord,
  candidates: CandidateCollections,
  selected: SelectedSets
): boolean {
  const linkId = payloadString(event, 'id')
  return Boolean(linkId && candidates.evidenceLinks.some((link) =>
    link.id === linkId && selected.evidenceLinks.has(link.id)
  ))
}

function linkTouchesSelection(link: WorkflowEvidenceLinkRecord, selected: SelectedSets): boolean {
  if (selected.evidenceLinks.has(link.id)) return true
  if (link.acceptanceId) return selected.acceptances.has(link.acceptanceId)
  if (link.artifactId) return selected.artifacts.has(link.artifactId)
  return Boolean(link.runId && selected.runs.has(link.runId))
}

function evidenceTouchesSelection(
  evidence: TaskEvidenceRecord,
  candidates: CandidateCollections,
  selected: SelectedSets
): boolean {
  if (selected.taskEvidence.has(evidence.evidenceId) || selected.runs.has(evidence.runId)) return true
  return candidates.events.some((event) =>
    selected.events.has(event.eventId) && event.kind === 'workflow.effect.evidence' &&
    payloadString(event, 'evidenceId') === evidence.evidenceId
  )
}

function workflowEvidenceTouchesSelection(
  evidence: WorkflowEvidenceRecord,
  candidates: CandidateCollections,
  selected: SelectedSets
): boolean {
  if (selected.workflowEvidence.has(evidence.evidenceId)) return true
  if (candidates.events.some((event) =>
    selected.events.has(event.eventId) && event.kind === 'workflow.evidence.recorded' &&
    payloadString(event, 'evidenceId') === evidence.evidenceId
  )) return true
  // Prefer the most specific persisted owner. A Run reached only as the owner
  // of Artifact A must not pull Artifact B's evidence into A's narrow export.
  if (evidence.artifactId) return selected.artifacts.has(evidence.artifactId)
  if (evidence.runId) return selected.runs.has(evidence.runId)
  if (evidence.workItemId) return selected.workItems.has(evidence.workItemId)
  return Boolean(evidence.goalId && selected.goals.has(evidence.goalId))
}

function payloadSelected(event: WorkflowEventRecord, key: string, selected: Set<string>): boolean {
  const value = payloadString(event, key)
  return Boolean(value && selected.has(value))
}

function payloadString(event: WorkflowEventRecord, key: string): string | undefined {
  const value = event.payload[key]
  return typeof value === 'string' && value ? value : undefined
}

function addSelected<K extends CandidateKind>(
  kind: K,
  id: string,
  candidates: CandidateCollections,
  selected: SelectedSets,
  scope: WorkflowLedgerExportScope
): boolean {
  const record = candidates[kind].find((candidate) => candidateId(kind, candidate) === id)
  if (!record || !projectAllowed(kind, record, scope, candidates)) return false
  if (selected[kind].has(id)) return false
  selected[kind].add(id)
  return true
}

function candidateId<K extends CandidateKind>(kind: K, record: CandidateRecordMap[K]): string {
  if (kind === 'events') return (record as WorkflowEventRecord).eventId
  if (kind === 'taskEvidence') return (record as TaskEvidenceRecord).evidenceId
  if (kind === 'workflowEvidence') return (record as WorkflowEvidenceRecord).evidenceId
  return (record as { id: string }).id
}

function materializeSelection(
  candidates: CandidateCollections,
  selected: SelectedSets
): WorkflowLedgerClosedSelection {
  return {
    goals: candidates.goals.filter((record) => selected.goals.has(record.id)),
    workItems: candidates.workItems.filter((record) => selected.workItems.has(record.id)),
    runs: candidates.runs.filter((record) => selected.runs.has(record.id)),
    artifacts: candidates.artifacts.filter((record) => selected.artifacts.has(record.id)),
    acceptances: candidates.acceptances.filter((record) => selected.acceptances.has(record.id)),
    evidenceLinks: candidates.evidenceLinks.filter((record) => selected.evidenceLinks.has(record.id)),
    events: candidates.events.filter((record) => selected.events.has(record.eventId)),
    taskEvidence: candidates.taskEvidence.filter((record) => selected.taskEvidence.has(record.evidenceId)),
    workflowEvidence: candidates.workflowEvidence.filter((record) => selected.workflowEvidence.has(record.evidenceId))
  }
}
