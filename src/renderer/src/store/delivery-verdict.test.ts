import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StudioResultSnapshot } from '../../../shared/studio-result-types'
import { deriveDeliveryVerdict, canMarkGoalComplete } from './delivery-verdict.ts'

type AcceptanceStub = Pick<StudioResultSnapshot['acceptances'][number], 'status'>
type RunStub = Pick<StudioResultSnapshot['runs'][number], 'status'>
type GoalStub = Pick<NonNullable<StudioResultSnapshot['goal']>, 'status'>
type SnapshotOverrides = {
  acceptances?: AcceptanceStub[]
  runs?: RunStub[]
  goal?: GoalStub
}

function makeSnapshot(over: SnapshotOverrides = {}): StudioResultSnapshot {
  const acceptances = (over.acceptances ?? []).map((acceptance, index) => ({
    id: `acceptance-${index}`,
    status: acceptance.status,
    criteria: [],
    coveredCriteria: 0,
    evidenceRefs: [],
    revision: 1,
    updatedAt: 0
  }))
  const runs = (over.runs ?? []).map((run, index) => ({
    id: `run-${index}`,
    sessionId: 's',
    workItemId: 'work-item',
    status: run.status,
    attempt: 1,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    taskRunDigest: ''
  }))
  const goal = over.goal
    ? {
        id: 'goal',
        title: 'Goal',
        objective: 'Verify delivery verdict',
        status: over.goal.status,
        riskLevel: 'low' as const,
        constraints: [],
        successCriteria: [],
        revision: 1
      }
    : undefined
  return {
    schemaVersion: 1,
    format: 'caogen.studio-result.v1',
    state: 'ready',
    generatedAt: 0,
    scope: { sessionId: 's', level: 'conversation' },
    workItems: [],
    runs,
    artifacts: [],
    evidence: [],
    acceptances,
    tests: [],
    risks: [],
    openItems: [],
    approvals: [],
    timeline: [],
    cost: { knownUsd: 0, knownRunCount: 0, totalRunCount: 0, coverage: 'unavailable' },
    summary: {
      runs: 0, artifacts: 0, availableArtifacts: 0, evidence: 0, acceptances: 0,
      passedAcceptances: 0, tests: 0, changes: 0, openItems: 0, approvals: 0, risks: 0
    },
    verification: { canonicalAggregateVerified: true, sanitized: true as const, resultDigest: '' },
    goal
  }
}

test('deriveDeliveryVerdict: 全 passed → verifiable', () => {
  const d = deriveDeliveryVerdict(makeSnapshot({
    acceptances: [{ status: 'passed' }, { status: 'passed' }]
  }))
  assert.equal(d.verdict, 'verifiable')
  assert.equal(d.total, 2)
  assert.equal(d.passed, 2)
  assert.equal(d.failed, 0)
})

test('deriveDeliveryVerdict: 全 waived → verifiable', () => {
  const d = deriveDeliveryVerdict(makeSnapshot({
    acceptances: [{ status: 'waived' }, { status: 'waived' }]
  }))
  assert.equal(d.verdict, 'verifiable')
  assert.equal(d.waived, 2)
})

test('deriveDeliveryVerdict: passed + waived 混合 → verifiable', () => {
  const d = deriveDeliveryVerdict(makeSnapshot({
    acceptances: [{ status: 'passed' }, { status: 'waived' }]
  }))
  assert.equal(d.verdict, 'verifiable')
})

test('deriveDeliveryVerdict: 含 failed → not_done', () => {
  const d = deriveDeliveryVerdict(makeSnapshot({
    acceptances: [{ status: 'passed' }, { status: 'failed' }]
  }))
  assert.equal(d.verdict, 'not_done')
  assert.equal(d.failed, 1)
})

test('deriveDeliveryVerdict: 含 pending → not_done', () => {
  const d = deriveDeliveryVerdict(makeSnapshot({
    acceptances: [{ status: 'pending' }]
  }))
  assert.equal(d.verdict, 'not_done')
  assert.equal(d.pending, 1)
})

test('deriveDeliveryVerdict: 含 verifying → not_done', () => {
  const d = deriveDeliveryVerdict(makeSnapshot({
    acceptances: [{ status: 'verifying' }]
  }))
  assert.equal(d.verdict, 'not_done')
  assert.equal(d.verifying, 1)
})

test('deriveDeliveryVerdict: 空 acceptances 按字面 → verifiable(架构 §8.1 默认)', () => {
  const d = deriveDeliveryVerdict(makeSnapshot({ acceptances: [] }))
  assert.equal(d.verdict, 'verifiable')
  assert.equal(d.total, 0)
})

test('deriveDeliveryVerdict: Run completed 但 Acceptance failed → not_done(AC-1)', () => {
  const d = deriveDeliveryVerdict(makeSnapshot({
    acceptances: [{ status: 'failed' }],
    runs: [{ status: 'completed' }],
    goal: { status: 'completed' }
  }))
  assert.equal(d.verdict, 'not_done')
  // modelReportedDone 仅辅助展示,不参与判定
  assert.equal(d.modelReportedDone, true)
})

test('deriveDeliveryVerdict: modelReportedDone 仅来自 goal/run(不反推 verdict)', () => {
  const d = deriveDeliveryVerdict(makeSnapshot({
    acceptances: [{ status: 'passed' }],
    runs: [{ status: 'completed' }],
    goal: { status: 'completed' }
  }))
  assert.equal(d.verdict, 'verifiable')
  assert.equal(d.modelReportedDone, true)
})

test('deriveDeliveryVerdict: 只读 acceptances 判定,不受 goal/run 干扰', () => {
  const d = deriveDeliveryVerdict(makeSnapshot({
    acceptances: [{ status: 'pending' }],
    runs: [{ status: 'failed' }],
    goal: { status: 'failed' }
  }))
  assert.equal(d.verdict, 'not_done')
  assert.equal(d.modelReportedDone, false)
})

test('canMarkGoalComplete: verifiable 放行 / not_done 阻断(AC-3)', () => {
  assert.equal(canMarkGoalComplete('verifiable'), true)
  assert.equal(canMarkGoalComplete('not_done'), false)
})
