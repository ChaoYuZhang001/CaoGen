import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export async function runManagedWorktreeOperationChecks({
  tempRoot,
  userData,
  gateway,
  snapshotStore,
  effectRuntime,
  worktrees,
  managedWorktreeEffect,
  worktreeHandlers,
  git,
  initRepo
}) {
  const repo = path.join(tempRoot, 'managed-worktree-create-repo')
  initRepo(repo)
  writeFileSync(path.join(repo, 'README.md'), 'base\n', 'utf8')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'base'])

  const confirmedPlan = worktrees.prepareManagedWorktreeCreateEffect({
    sessionId: 'managed-create-confirmed',
    cwd: repo,
    isolated: true
  })
  assert(confirmedPlan.ok && confirmedPlan.isolated && confirmedPlan.plan, JSON.stringify(confirmedPlan))
  let confirmedCreateCallbackCount = 0
  const exactCreateAcknowledgementLoss = (spec) => gateway.executeInteractiveOperationEffect({
    ...spec,
    execute: async (effect) => {
      confirmedCreateCallbackCount += 1
      const value = await spec.execute(effect)
      assert(value.ok, JSON.stringify(value))
      return { ok: false, error: 'simulated exact create acknowledgement loss' }
    }
  })
  const confirmed = await worktreeHandlers.executeManagedWorktreeCreateEffect(
    confirmedPlan.plan,
    undefined,
    exactCreateAcknowledgementLoss
  )
  assert(confirmed.ok, JSON.stringify(confirmed))
  assertEqual(confirmed.effectStatus, 'confirmed')
  assertEqual(confirmedCreateCallbackCount, 1, 'exact create acknowledgement loss must not replay the callback')
  assert(existsSync(confirmed.record.worktreePath), 'confirmed create must materialize the managed worktree')
  assert(
    worktrees.listManagedWorktrees().some((record) => record.sessionId === confirmed.record.sessionId),
    'registry projection must happen after confirmed create'
  )
  await unknownManagedWorktreeRemoveCase({
    repo,
    gateway,
    snapshotStore,
    worktrees,
    managedWorktreeEffect,
    sessionId: confirmed.record.sessionId,
    git
  })
  await managedWorktreeProjectionFailureCase({
    repo,
    userData,
    gateway,
    snapshotStore,
    effectRuntime,
    worktrees,
    managedWorktreeEffect
  })

  const unknownPlan = worktrees.prepareManagedWorktreeCreateEffect({
    sessionId: 'managed-create-unknown',
    cwd: repo,
    isolated: true
  })
  assert(unknownPlan.ok && unknownPlan.isolated && unknownPlan.plan, JSON.stringify(unknownPlan))
  const acknowledgementLossGateway = (spec) => gateway.executeInteractiveOperationEffect({
    ...spec,
    execute: async (effect) => {
      const value = await spec.execute(effect)
      assert(value.ok, JSON.stringify(value))
      writeFileSync(path.join(unknownPlan.plan.record.worktreePath, 'ack-loss.txt'), 'advanced after create\n', 'utf8')
      git(unknownPlan.plan.record.worktreePath, ['add', 'ack-loss.txt'])
      git(unknownPlan.plan.record.worktreePath, ['commit', '-m', 'advance after acknowledgement loss'])
      return { ok: false, error: 'simulated acknowledgement loss after state drift' }
    }
  })
  const unknown = await worktreeHandlers.executeManagedWorktreeCreateEffect(
    unknownPlan.plan,
    undefined,
    acknowledgementLossGateway
  )
  assertEqual(unknown.ok, false)
  assertEqual(unknown.effectStatus, 'waiting_reconciliation')
  assert(unknown.snapshotId, 'unknown create must expose its recovery snapshot id')
  assert(unknown.recoverySnapshot, 'unknown create must return the persisted recovery snapshot')
  assertEqual(unknown.recoverySnapshot.id, unknown.snapshotId)
  assert(
    !worktrees.listManagedWorktrees().some((record) => record.sessionId === unknownPlan.plan.record.sessionId),
    'unknown create must not project an active managed worktree registry record'
  )
  assert(await snapshotStore.getTaskSnapshot(unknown.snapshotId), 'unknown create recovery snapshot must remain durable')
  await tamperedManagedWorktreeProjectionCase({
    gateway,
    snapshotStore,
    effectRuntime,
    worktrees,
    unknown,
    plan: unknownPlan.plan,
    git
  })

  git(repo, ['worktree', 'remove', '--force', unknownPlan.plan.record.worktreePath])
  git(repo, ['branch', '-D', unknownPlan.plan.record.branch])
}

async function tamperedManagedWorktreeProjectionCase({
  gateway,
  snapshotStore,
  effectRuntime,
  worktrees,
  unknown,
  plan,
  git
}) {
  const snapshot = await snapshotStore.getTaskSnapshot(unknown.snapshotId)
  assert(snapshot?.run, 'unknown create snapshot must exist before tamper regression')
  const effect = snapshot.run.effects[0]
  assert(effect?.target.kind === 'git_worktree_create')
  const advancedHead = git(plan.record.worktreePath, ['rev-parse', 'HEAD']).trim()
  const tamperedEffect = {
    ...effect,
    updatedAt: effect.updatedAt + 1,
    target: {
      ...effect.target,
      baseSha: advancedHead,
      registryRecord: { ...effect.target.registryRecord, baseSha: advancedHead }
    }
  }
  const tampered = await snapshotStore.saveTaskSnapshot({
    ...snapshot,
    updatedAt: snapshot.updatedAt + 1,
    run: {
      ...snapshot.run,
      updatedAt: snapshot.run.updatedAt + 1,
      effects: snapshot.run.effects.map((item) => item.id === effect.id ? tamperedEffect : item)
    }
  })
  const retained = await gateway.settleStoppedInteractiveOperationSnapshot(tampered)
  assert(retained?.run, 'tampered lifecycle target must retain the recovery snapshot')
  assertEqual(retained.run.status, 'waiting_reconciliation')
  assert(
    retained.run.error?.includes('摘要校验失败'),
    `tampered projection must expose an integrity error, got ${retained.run.error}`
  )
  assert(
    !worktrees.listManagedWorktrees().some((record) => record.sessionId === plan.record.sessionId),
    'tampered lifecycle target must never project registry state'
  )
  const retainedEffect = retained.run.effects[0]
  for (const resolution of ['confirmed_applied', 'confirmed_not_applied']) {
    await assertRejects(
      effectRuntime.resolvePersistedTaskEffect(
        retained.id,
        retainedEffect.id,
        retainedEffect.revision,
        resolution
      ),
      '摘要校验失败'
    )
  }
  assert(
    !worktrees.listManagedWorktrees().some((record) => record.sessionId === plan.record.sessionId),
    'manual confirmation must not bypass lifecycle Effect integrity'
  )
}

async function unknownManagedWorktreeRemoveCase({
  repo,
  gateway,
  snapshotStore,
  worktrees,
  managedWorktreeEffect,
  sessionId,
  git
}) {
  const prepared = worktrees.prepareManagedWorktreeRemoveEffect(sessionId, {
    force: true,
    deleteBranch: true
  })
  assert(prepared.ok && prepared.plan, JSON.stringify(prepared))
  const plan = prepared.plan
  const outcome = await gateway.executeInteractiveOperationEffect({
    operationId: 'managed-remove-unknown',
    kind: 'managed_worktree_remove',
    title: 'managed remove unknown probe',
    sourceSessionId: sessionId,
    cwd: plan.previousRecord.sourceCwd,
    toolName: 'managed_worktree_remove',
    toolInput: { ...plan.toolInput },
    execute: (effect) => {
      assertEqual(effect.target.kind, 'git_worktree_remove')
      const result = managedWorktreeEffect.executeManagedWorktreeRemoveTarget(effect.target)
      assert(result.ok, JSON.stringify(result))
      git(repo, ['update-ref', effect.target.branchRef, effect.target.branchSha])
      return { ok: false, error: 'simulated remove acknowledgement loss with ref drift' }
    },
    isSuccess: (result) => result.ok
  })
  assertEqual(outcome.status, 'waiting_reconciliation', JSON.stringify(outcome))
  assertEqual(outcome.effectStatus, 'waiting_reconciliation')
  const active = worktrees.listManagedWorktrees().find((record) => record.sessionId === sessionId)
  assertEqual(active?.state, 'active', 'unknown remove must not project the removed record')
  assertEqual(existsSync(plan.record.worktreePath), false)
  const waiting = await snapshotStore.getTaskSnapshot(outcome.snapshotId)
  assertEqual(waiting?.run?.effects?.[0]?.status, 'waiting_reconciliation')

  git(repo, ['update-ref', '-d', `refs/heads/${plan.record.branch}`, plan.previousRecord.baseSha])
  const settled = await gateway.settleStoppedInteractiveOperationSnapshot(waiting)
  assertEqual(settled, null)
  const removed = worktrees.listManagedWorktrees().find((record) => record.sessionId === sessionId)
  assertEqual(removed?.state, 'removed')
}

async function managedWorktreeProjectionFailureCase({
  repo,
  userData,
  gateway,
  snapshotStore,
  effectRuntime,
  worktrees,
  managedWorktreeEffect
}) {
  const sessionId = 'managed-create-projection-failure'
  const prepared = worktrees.prepareManagedWorktreeCreateEffect({ sessionId, cwd: repo, isolated: true })
  assert(prepared.ok && prepared.isolated && prepared.plan, JSON.stringify(prepared))
  const plan = prepared.plan
  const registryPath = path.join(userData, 'worktrees', 'index.json')
  const outcome = await gateway.executeInteractiveOperationEffect({
    operationId: 'managed-create-projection-failure',
    source: 'session_lifecycle',
    kind: 'managed_worktree_create',
    title: 'managed projection failure probe',
    sourceSessionId: sessionId,
    cwd: plan.record.sourceCwd,
    toolName: 'managed_worktree_create',
    toolInput: { ...plan.toolInput },
    execute: (effect) => {
      assertEqual(effect.target.kind, 'git_worktree_create')
      const result = managedWorktreeEffect.executeManagedWorktreeCreateTarget(effect.target)
      assert(result.ok, JSON.stringify(result))
      writeFileSync(registryPath, '{broken registry', 'utf8')
      return result
    },
    isSuccess: (result) => result.ok
  })
  assertEqual(outcome.status, 'waiting_reconciliation')
  assertEqual(outcome.effectStatus, 'waiting_reconciliation')
  assert(outcome.error, 'projection failure must return an actionable error')
  const waiting = await snapshotStore.getTaskSnapshot(outcome.snapshotId)
  const effect = waiting?.run?.effects?.find((item) => item.id === outcome.effectId)
  assertEqual(waiting?.run?.status, 'waiting_reconciliation')
  assertEqual(effect?.status, 'waiting_reconciliation')
  assert(effect?.error, 'projection failure must persist the Effect error')
  assertEqual(worktrees.listManagedWorktrees().length, 0, 'query reads may degrade on a corrupt registry')

  rmSync(registryPath, { force: true })
  await assertRejects(
    effectRuntime.resolvePersistedTaskEffect(
      waiting.id,
      effect.id,
      effect.revision + 1,
      'confirmed_applied'
    ),
    'stale_revision'
  )
  assert(
    !worktrees.listManagedWorktrees().some((record) => record.sessionId === sessionId),
    'stale manual resolution must not project registry state'
  )
  const resolved = await effectRuntime.resolvePersistedTaskEffect(
    waiting.id,
    effect.id,
    effect.revision,
    'confirmed_applied'
  )
  assertEqual(resolved.run.effects.find((item) => item.id === effect.id)?.status, 'confirmed')
  assertEqual(
    worktrees.listManagedWorktrees().find((record) => record.sessionId === sessionId)?.state,
    'active'
  )
  assertEqual(await gateway.settleStoppedInteractiveOperationSnapshot(resolved), null)

  const remove = worktrees.prepareManagedWorktreeRemoveEffect(sessionId, {
    force: true,
    deleteBranch: true
  })
  assert(remove.ok && remove.plan, JSON.stringify(remove))
  let removeCallbackCount = 0
  const removeOutcome = await gateway.executeInteractiveOperationEffect({
    operationId: 'managed-remove-exact-ack-loss',
    kind: 'managed_worktree_remove',
    title: 'managed exact remove acknowledgement loss',
    sourceSessionId: sessionId,
    cwd: remove.plan.previousRecord.sourceCwd,
    toolName: 'managed_worktree_remove',
    toolInput: { ...remove.plan.toolInput },
    execute: (effectRecord) => {
      removeCallbackCount += 1
      assertEqual(effectRecord.target.kind, 'git_worktree_remove')
      const result = managedWorktreeEffect.executeManagedWorktreeRemoveTarget(effectRecord.target)
      assert(result.ok, JSON.stringify(result))
      return { ok: false, error: 'simulated exact remove acknowledgement loss' }
    },
    isSuccess: (result) => result.ok
  })
  assertEqual(removeOutcome.status, 'completed')
  assertEqual(removeOutcome.effectStatus, 'confirmed')
  assertEqual(removeCallbackCount, 1, 'exact remove acknowledgement loss must not replay the callback')
  assertEqual(
    worktrees.listManagedWorktrees().find((record) => record.sessionId === sessionId)?.state,
    'removed'
  )
  assertEqual(await snapshotStore.getTaskSnapshot('operation:managed-remove-exact-ack-loss'), null)
}

async function assertRejects(promise, expectedMessage) {
  try {
    await promise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(message.includes(expectedMessage), `expected rejection containing ${expectedMessage}, got ${message}`)
    return
  }
  throw new Error(`expected rejection containing ${expectedMessage}`)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
