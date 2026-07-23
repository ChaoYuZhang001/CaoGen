import assert from 'node:assert/strict'

const PROJECT_ID = 'project-a'

export async function assertAcceptanceCriterionPolicies(context) {
  await assertPolicyStructures(context)
  await assertPolicyPasses(context)
  await assertPolicyIsImmutable(context)
  await assertPolicyMismatches(context)
  await assertLegacyAcceptance(context)
}

async function assertPolicyStructures({ api, userData }) {
  const structureItem = await createItem(api, userData, 'criterion-policy-structure')
  const malformedPolicies = [
    {
      label: 'partial',
      criteria: ['first criterion', 'second criterion'],
      policies: [policy('criterion-policy-partial-1', 0)]
    },
    {
      label: 'duplicate',
      criteria: ['first criterion', 'second criterion'],
      policies: [
        policy('criterion-policy-duplicate', 0),
        policy('criterion-policy-duplicate', 1)
      ]
    },
    {
      label: 'invalid',
      criteria: ['invalid policy is rejected'],
      policies: [{
        ...policy('criterion-policy-invalid', 0),
        allowedSources: []
      }]
    }
  ]
  for (const fixture of malformedPolicies) {
    await expectPolicyCorruption(
      api.saveWorkflowAcceptance({
        id: `acceptance-criterion-policy-${fixture.label}`,
        projectId: PROJECT_ID,
        workItemId: structureItem.id,
        criteria: fixture.criteria,
        criterionPolicies: fixture.policies
      }, userData),
      `criterion policy ${fixture.label} shape must fail closed`
    )
  }
}

async function assertPolicyPasses({ api, handlers, saveAcceptanceIpc, trustedEvent, userData }) {
  const passItem = await createItem(api, userData, 'criterion-policy-pass')
  const passPolicy = [policy('criterion-policy-pass', 0)]
  const passPending = await saveAcceptanceIpc(trustedEvent, {
    id: 'acceptance-criterion-policy-pass',
    projectId: PROJECT_ID,
    workItemId: passItem.id,
    criteria: ['runtime test result verifies the criterion'],
    criterionPolicies: passPolicy
  })
  assert.deepEqual(passPending.criterionPolicies, passPolicy, 'typed policy must survive renderer ingress')
  const passEvidence = await createEvidence(api, userData, passItem, {
    id: 'evidence-criterion-policy-pass',
    kind: 'test_result',
    source: 'runtime',
    digest: '1'
  })
  const passResult = await review(handlers, userData, passPending.id, passEvidence.evidenceId, 'passed', 10_100)
  assert.equal(passResult.acceptance.status, 'passed')
  assert.deepEqual(passResult.acceptance.criterionPolicies, passPolicy, 'passed review must retain typed policy')
  assert.deepEqual(passResult.acceptance.criterionEvidence, [{
    criterionId: passPolicy[0].criterionId,
    criterionIndex: 0,
    evidenceRefs: [passEvidence.evidenceId]
  }], 'review must derive criterion identity from the typed policy')
}

async function assertPolicyIsImmutable({ api, userData }) {
  const rewriteItem = await createItem(api, userData, 'criterion-policy-rewrite')
  const rewritePending = await api.saveWorkflowAcceptance({
    id: 'acceptance-criterion-policy-rewrite',
    projectId: PROJECT_ID,
    workItemId: rewriteItem.id,
    criteria: ['policy remains immutable'],
    criterionPolicies: [policy('criterion-policy-rewrite', 0)]
  }, userData)
  await expectPolicyCorruption(
    api.saveWorkflowAcceptance({
      ...rewritePending,
      criterionPolicies: [policy('criterion-policy-rewrite', 0, ['human'])],
      revision: rewritePending.revision + 1
    }, userData),
    'criterion policy rewrite must fail the immutable contract'
  )
}

async function assertPolicyMismatches(context) {
  await assertKindAndSourceMismatches(context)
  await assertCriterionIdMismatch(context)
  await assertEvidenceOriginMismatch(context)
}

async function assertKindAndSourceMismatches({ api, handlers, userData }) {
  const kindItem = await createItem(api, userData, 'criterion-policy-kind-mismatch')
  const kindPending = await typedAcceptance(api, userData, kindItem, 'kind-mismatch')
  const wrongKindEvidence = await createEvidence(api, userData, kindItem, {
    id: 'evidence-criterion-policy-kind-mismatch',
    kind: 'observation',
    source: 'runtime',
    digest: '2'
  })
  await expectPolicyGate(
    review(handlers, userData, kindPending.id, wrongKindEvidence.evidenceId, 'passed', 10_200),
    'criterion_policy_kind_mismatch',
    'typed policy must reject a mismatched evidence kind'
  )

  const sourceItem = await createItem(api, userData, 'criterion-policy-source-mismatch')
  const sourcePending = await typedAcceptance(api, userData, sourceItem, 'source-mismatch')
  const wrongSourceEvidence = await createEvidence(api, userData, sourceItem, {
    id: 'evidence-criterion-policy-source-mismatch',
    kind: 'test_result',
    source: 'imported',
    digest: '3'
  })
  await expectPolicyGate(
    review(handlers, userData, sourcePending.id, wrongSourceEvidence.evidenceId, 'passed', 10_300),
    'criterion_policy_source_mismatch',
    'typed policy must reject a mismatched evidence source'
  )
}

async function assertCriterionIdMismatch({ api, userData }) {
  const idItem = await createItem(api, userData, 'criterion-policy-id-mismatch')
  const idPending = await typedAcceptance(api, userData, idItem, 'id-mismatch')
  const idEvidence = await createEvidence(api, userData, idItem, {
    id: 'evidence-criterion-policy-id-mismatch',
    kind: 'test_result',
    source: 'runtime',
    digest: '4'
  })
  await expectPolicyGate((async () => {
    const link = await api.createWorkflowEvidenceLink({
      id: 'link-criterion-policy-id-mismatch',
      evidenceId: idEvidence.evidenceId,
      evidenceOrigin: 'workflow',
      projectId: PROJECT_ID,
      acceptanceId: idPending.id,
      criterionId: 'criterion-policy-wrong-id',
      relation: 'verifies'
    }, userData)
    const checking = await api.saveWorkflowAcceptance({
      ...idPending,
      status: 'verifying',
      evidenceRefs: [link.evidenceId],
      criterionEvidence: [{
        criterionId: 'criterion-policy-wrong-id',
        criterionIndex: 0,
        evidenceRefs: [link.evidenceId]
      }],
      revision: idPending.revision + 1
    }, userData)
    return api.saveWorkflowAcceptance({
      ...checking,
      status: 'passed',
      verifier: 'criterion-policy-smoke',
      verifiedAt: 10_400,
      revision: checking.revision + 1
    }, userData)
  })(), 'criterion_policy_id_mismatch', 'typed policy must reject a mismatched criterion id')
}

async function assertEvidenceOriginMismatch({ api, taskEvidence, userData }) {
  const originAcceptance = await api.saveWorkflowAcceptance({
    id: 'acceptance-criterion-policy-origin-mismatch',
    projectId: PROJECT_ID,
    workItemId: taskEvidence.workItemId,
    criteria: ['only Workflow evidence may satisfy a typed policy'],
    criterionPolicies: [policy('criterion-policy-origin-mismatch', 0)]
  }, userData)
  await expectPolicyGate((async () => {
    const link = await api.createWorkflowEvidenceLink({
      id: 'link-criterion-policy-origin-mismatch',
      evidenceId: taskEvidence.evidenceId,
      evidenceOrigin: 'task_effect',
      projectId: PROJECT_ID,
      runId: taskEvidence.runId,
      acceptanceId: originAcceptance.id,
      criterionId: 'criterion-policy-origin-mismatch',
      relation: 'verifies'
    }, userData)
    const checking = await api.saveWorkflowAcceptance({
      ...originAcceptance,
      status: 'verifying',
      evidenceRefs: [link.evidenceId],
      criterionEvidence: [{
        criterionId: 'criterion-policy-origin-mismatch',
        criterionIndex: 0,
        evidenceRefs: [link.evidenceId]
      }],
      revision: originAcceptance.revision + 1
    }, userData)
    return api.saveWorkflowAcceptance({
      ...checking,
      status: 'passed',
      verifier: 'criterion-policy-smoke',
      verifiedAt: 10_500,
      revision: checking.revision + 1
    }, userData)
  })(), 'criterion_policy_origin_mismatch', 'typed policy must reject TaskRun Effect evidence')
}

async function assertLegacyAcceptance({ api, handlers, userData }) {
  const legacyItem = await createItem(api, userData, 'criterion-policy-legacy')
  const legacyPending = await api.saveWorkflowAcceptance({
    id: 'acceptance-criterion-policy-legacy',
    projectId: PROJECT_ID,
    workItemId: legacyItem.id,
    criteria: ['legacy acceptance remains compatible']
  }, userData)
  const legacyEvidence = await createEvidence(api, userData, legacyItem, {
    id: 'evidence-criterion-policy-legacy',
    kind: 'observation',
    source: 'imported',
    digest: '5'
  })
  const legacyResult = await review(
    handlers,
    userData,
    legacyPending.id,
    legacyEvidence.evidenceId,
    'passed',
    10_600
  )
  assert.equal(legacyResult.acceptance.status, 'passed')
  assert.equal(legacyResult.acceptance.criterionPolicies, undefined, 'legacy Acceptance must not gain a policy')
}

function policy(criterionId, criterionIndex, allowedSources = ['runtime']) {
  return { criterionId, criterionIndex, evidenceKind: 'test_result', allowedSources }
}

async function createItem(api, userData, suffix) {
  return api.createWorkflowWorkItem({
    id: `work-${suffix}`,
    projectId: PROJECT_ID,
    title: suffix,
    type: 'testing',
    status: 'verifying'
  }, userData)
}

function typedAcceptance(api, userData, item, suffix) {
  return api.saveWorkflowAcceptance({
    id: `acceptance-criterion-policy-${suffix}`,
    projectId: PROJECT_ID,
    workItemId: item.id,
    criteria: [`${suffix} policy is enforced`],
    criterionPolicies: [policy(`criterion-policy-${suffix}`, 0)]
  }, userData)
}

function createEvidence(api, userData, item, fixture) {
  return api.createWorkflowEvidence({
    evidenceId: fixture.id,
    projectId: PROJECT_ID,
    workItemId: item.id,
    kind: fixture.kind,
    title: fixture.id,
    contentDigest: fixture.digest.repeat(64)
  }, userData, {
    source: fixture.source,
    verifier: 'criterion-policy-smoke',
    observedAt: 10_000
  })
}

function review(handlers, userData, acceptanceId, evidenceId, decision, reviewedAt) {
  return handlers.reviewWorkflowAcceptance({
    acceptanceId,
    criterionEvidence: [{ criterionIndex: 0, evidenceRefs: [evidenceId] }],
    decision
  }, {
    actorId: 'criterion-policy-reviewer',
    verifier: 'criterion-policy-reviewer',
    reviewedAt
  }, userData)
}

async function expectPolicyGate(promise, reason, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, 'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID', `${message} (code)`)
    assert.equal(error?.details?.reason, reason, `${message} (reason)`)
    return true
  })
}

async function expectPolicyCorruption(promise, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, 'WORKFLOW_LEDGER_CORRUPTION', `${message} (code)`)
    assert.match(String(error?.message), /criterion ?polic|immutable contract/i, `${message} (message)`)
    return true
  })
}
