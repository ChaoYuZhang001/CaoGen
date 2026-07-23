export async function assertRendererCannotSelfAuthorize(input) {
  const projectId = 'project-renderer-authority'
  const workItemId = 'work-renderer-authority'
  const store = new input.projectStoreApi.ProjectWorkspaceStore(input.userData)
  await store.open()
  await store.createWorkspace({ id: projectId, name: 'Renderer authority project', kind: 'software' })
  const commands = input.projectCommandApi.createProjectWorkspaceCommandService(
    store,
    { rootDir: input.userData }
  )
  let item = await commands.createWorkItem({
    id: workItemId,
    projectId,
    title: 'Renderer cannot self-authorize',
    status: 'verifying'
  })
  item = await store.setWorkItemAcceptance(item.id, {
    status: 'passed',
    evidenceRefs: ['source-only-evidence'],
    verifiedBy: 'renderer-source-fixture',
    verifiedAt: Date.now()
  }, item.revision)

  const pending = await input.saveAcceptanceIpc(input.trustedEvent, {
    id: 'acceptance-renderer-authority',
    projectId,
    workItemId,
    criteria: ['Only main-process authority may pass this Acceptance']
  })
  const evidence = await input.createEvidenceIpc(input.trustedEvent, {
    evidenceId: 'evidence-renderer-authority',
    projectId,
    workItemId,
    kind: 'test_result',
    title: 'Renderer supplied non-human evidence',
    contentDigest: '9'.repeat(64)
  })
  assertEqual(evidence.source, 'runtime', 'renderer evidence must not claim human provenance')
  assertEqual(evidence.verifier, 'renderer-ipc', 'renderer evidence verifier must be non-human')
  const link = await input.createEvidenceLinkIpc(input.trustedEvent, {
    id: 'link-renderer-authority',
    evidenceId: evidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId,
    acceptanceId: pending.id,
    relation: 'verifies'
  })
  const verifying = await input.saveAcceptanceIpc(input.trustedEvent, {
    ...pending,
    status: 'verifying',
    evidenceRefs: [link.evidenceId],
    revision: pending.revision + 1
  })

  await assertAuthorityFieldsRejected(input, verifying)
  await assertTerminalStatusesRejected(input, verifying)
  await expectRejects(
    commands.transitionWorkItem(item.id, 'done', item.revision),
    (error) => error?.code === 'canonical_acceptance_required' && error.details?.sourceCommitted === false,
    'renderer evidence chain must not authorize ProjectWorkspace done'
  )
  const unchanged = await store.getWorkItem(item.id)
  assertEqual(unchanged.status, 'verifying', 'rejected ProjectWorkspace done must preserve status')
  assertEqual(unchanged.revision, item.revision, 'rejected ProjectWorkspace done must preserve revision')
}

async function assertAuthorityFieldsRejected(input, verifying) {
  for (const [field, value] of [
    ['verifier', 'renderer-self'],
    ['verifiedAt', Date.now()],
    ['waiverReason', 'renderer waiver'],
    ['waivedBy', 'renderer-self']
  ]) {
    await expectRejects(
      Promise.resolve().then(() => input.saveAcceptanceIpc(input.trustedEvent, {
        ...verifying,
        [field]: value
      })),
      (error) => String(error?.message).includes(field) && String(error?.message).includes('主进程授权'),
      `renderer Acceptance payload must not self-report ${field}`
    )
  }
}

async function assertTerminalStatusesRejected(input, verifying) {
  for (const status of ['passed', 'waived']) {
    await expectRejects(
      Promise.resolve().then(() => input.saveAcceptanceIpc(input.trustedEvent, {
        ...verifying,
        status,
        revision: verifying.revision + 1
      })),
      (error) => String(error?.message).includes('status') && String(error?.message).includes('终态授权结果'),
      `renderer Acceptance payload must not write ${status}`
    )
  }
}

async function expectRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected error ${error instanceof Error ? error.stack : String(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
