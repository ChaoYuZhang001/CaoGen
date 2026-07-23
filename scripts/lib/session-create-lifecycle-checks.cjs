const fs = require('node:fs')
const path = require('node:path')

function createManagedWorktreeLifecycleCheck({ M, mkRepo, sh, assert, eq, tmpRoot }) {
  return async function managedWorktreeLifecycleCheck() {
    const worktrees = M('main/worktrees.js')
    const gateway = M('main/task/operation-effect-gateway.js')
    const handlers = M('main/ipc/worktree-operation-handlers.js')
    const repoDir = mkRepo('repo1')
    const plan = worktrees.prepareManagedWorktreeCreateEffect({
      sessionId: 'sess-wt-1',
      cwd: repoDir,
      isolated: true
    })
    assert(plan.ok && plan.isolated && plan.plan, `prepare managed worktree plan 失败:${plan.error || ''}`)
    const prepared = await handlers.executeManagedWorktreeCreateEffect(
      plan.plan,
      undefined,
      gateway.executeInteractiveOperationEffect
    )
    assert(prepared.ok && prepared.isolated, `durable create worktree 失败:${prepared.error || ''}`)
    const record = prepared.record
    assert(fs.existsSync(record.worktreePath), 'worktree 目录不存在')
    eq(sh(record.worktreePath, 'git', ['branch', '--show-current']).trim(), 'caogen/sess-wt-1', '分支名')

    fs.writeFileSync(path.join(record.worktreePath, 'src', 'app.ts'), 'export const a = 42\n')
    sh(record.worktreePath, 'git', ['add', '-A'])
    sh(record.worktreePath, 'git', ['commit', '-qm', 'change in wt'])
    eq(sh(repoDir, 'git', ['status', '--porcelain']).trim(), '', '主工作区被污染')
    const summary = worktrees.getManagedWorktreeSummary('sess-wt-1')
    assert(summary.ok && summary.changedFiles === 1 && summary.dirty, `summary 异常:${JSON.stringify(summary)}`)
    const patch = worktrees.exportManagedWorktreePatch('sess-wt-1')
    assert(patch.ok && fs.existsSync(patch.path), `patch 导出失败:${patch.error || ''}`)
    sh(repoDir, 'git', ['apply', '--check', patch.path])

    const existing = worktrees.prepareManagedWorktreeCreateEffect({
      sessionId: 'sess-wt-1',
      cwd: repoDir,
      isolated: true
    })
    eq(existing.record.worktreePath, record.worktreePath, '重复 prepare 未复用')
    const removed = await handlers.executeInteractiveOperationEffectRemoveWorktree(
      'sess-wt-1',
      { force: true },
      gateway.executeInteractiveOperationEffect
    )
    assert(removed.ok, `移除失败:${removed.error || ''}`)
    assert(!fs.existsSync(record.worktreePath), '移除后目录仍在')

    const plain = path.join(tmpRoot, 'plain')
    fs.mkdirSync(plain, { recursive: true })
    const automatic = worktrees.prepareWorktree({ sessionId: 'sess-wt-2', cwd: plain })
    assert(automatic.ok && !automatic.isolated, '非 git 目录应降级为直跑')
    const forced = worktrees.prepareWorktree({ sessionId: 'sess-wt-3', cwd: plain, isolated: true })
    assert(!forced.ok, '非 git 强制隔离应报错')
  }
}

function createUnknownSessionLifecycleCheck({ M, mkRepo, assert, eq }) {
  return async function unknownSessionLifecycleCheck() {
    const manager = M('main/sessionManager.js').sessionManager
    const handlers = M('main/ipc/worktree-operation-handlers.js')
    const journal = M('main/session-creation-journal.js')
    const originalCreateEffect = handlers.executeManagedWorktreeCreateEffect
    const repoDir = mkRepo('managed-session-unknown')
    const sessionsBefore = manager.list().length
    const journalBefore = new Set(
      journal.listPendingSessionCreations().map((draft) => draft.baseMeta.id)
    )
    handlers.executeManagedWorktreeCreateEffect = async (plan) => unknownCreateResult(plan)
    try {
      const failure = await captureFailure(() => manager.createManaged({
        cwd: repoDir,
        isolated: true,
        engine: 'claude',
        providerId: 'prov-b',
        model: 'm-b',
        title: 'unknown create must not start'
      }))
      assert(failure, 'unknown managed create should reject session creation')
      eq(failure.snapshotId, 'operation:managed-session-unknown-operation', 'unknown error snapshot id')
      eq(manager.list().length, sessionsBefore, 'unknown managed create must not register or start an Engine')
    } finally {
      handlers.executeManagedWorktreeCreateEffect = originalCreateEffect
      cleanupNewJournalEntries(journal, journalBefore)
    }
  }
}

function createActivationFailureLifecycleCheck({ M, mkRepo, assert, eq }) {
  return async function activationFailureLifecycleCheck() {
    const manager = M('main/sessionManager.js').sessionManager
    const journal = M('main/session-creation-journal.js')
    const worktrees = M('main/worktrees.js')
    const handlers = M('main/ipc/worktree-operation-handlers.js')
    const gateway = M('main/task/operation-effect-gateway.js')
    const originalWriteTaskSnapshot = manager.writeTaskSnapshot
    const journalBefore = new Set(
      journal.listPendingSessionCreations().map((draft) => draft.baseMeta.id)
    )
    const sessionsBefore = manager.list().length
    let failure
    manager.writeTaskSnapshot = async function (...args) {
      if (args[1] === 'created' && args[5] === true) {
        throw new Error('simulated strict activation snapshot failure')
      }
      return originalWriteTaskSnapshot.apply(this, args)
    }
    try {
      failure = await captureFailure(() => manager.createManaged({
        cwd: mkRepo('managed-session-activation-failure'),
        isolated: true,
        engine: 'claude',
        providerId: 'prov-b',
        model: 'm-b',
        title: 'activation failure must freeze session id'
      }))
      assert(failure, 'post-placement activation failure should reject session creation')
      eq(failure.nonRetryable, true, 'activation failure must be non-retryable')
      eq(failure.requiresReconciliation, true, 'activation failure must require reconciliation')
      eq(failure.sessionCreationJournalPending, true, 'activation failure must expose journal recovery')
      assert(typeof failure.sessionId === 'string' && failure.sessionId, 'activation failure must expose frozen session id')
      eq(manager.list().length, sessionsBefore, 'failed activation must not leave an active Engine')
      assert(
        journal.listPendingSessionCreations().some((draft) => draft.baseMeta.id === failure.sessionId),
        'failed activation must retain the frozen session journal'
      )
      assert(
        worktrees.managedWorktreeRecordForSession(failure.sessionId),
        'failed activation must retain the confirmed worktree record for reconciliation'
      )
    } finally {
      manager.writeTaskSnapshot = originalWriteTaskSnapshot
      if (failure?.sessionId) {
        const record = worktrees.managedWorktreeRecordForSession(failure.sessionId)
        if (record && record.state !== 'removed') {
          await handlers.executeInteractiveOperationEffectRemoveWorktree(
            failure.sessionId,
            { force: true, deleteBranch: true },
            gateway.executeInteractiveOperationEffect
          )
        }
      }
      cleanupNewJournalEntries(journal, journalBefore)
    }
  }
}

function createRecoverableSnapshotPrecedenceCheck(deps) {
  return async function recoverableSnapshotPrecedenceCheck() {
    await checkRicherSnapshotBlocksReplacement(deps)
    await checkOrchestratedDraftRequiresParentEvidence(deps)
    await checkNewestTerminalDagStatusWins(deps)
  }
}

async function checkRicherSnapshotBlocksReplacement({ M, mkRepo, assert, eq }) {
  const manager = M('main/sessionManager.js').sessionManager
  const journal = M('main/session-creation-journal.js')
  const lifecycle = M('main/session-create-lifecycle.js')
  const { TaskDagScheduler } = M('main/agent/dag-scheduler.js')
  const journalBefore = currentJournalIds(journal)
  const parentSessionId = 'parent-richer-snapshot'
  const dag = singleTaskDag('dag-richer-snapshot', 'frozen-child')
  const draft = lifecycle.prepareSessionCreationDraft({
    ...managedDraftOptions(mkRepo('managed-session-richer-snapshot')),
    title: 'recoverable snapshot must outrank journal draft',
    parentSessionId,
    orchestrationId: dag.id,
    childTaskId: dag.tasks[0].id,
    childRole: dag.tasks[0].role
  })
  const execution = singleTaskExecution(dag, parentSessionId, 'waiting', [], 0)
  saveUnscopedDraft(journal, draft)
  const sessionsBefore = manager.list().length
  try {
    await manager.restorePendingSessionCreations([
      { sessionId: draft.baseMeta.id, dagExecutions: [], execution: {}, updatedAt: 10 },
      { sessionId: parentSessionId, dagExecutions: [execution], execution: {}, updatedAt: 20 }
    ])
    eq(manager.list().length, sessionsBefore, 'journal must not activate over a richer task snapshot')
    assert(!manager.get(draft.baseMeta.id), 'richer task snapshot session must remain inactive')
    assert(hasJournal(journal, draft.baseMeta.id), 'skipped journal must remain as crash evidence')
    let replacementCalls = 0
    const scheduler = new TaskDagScheduler(parentSessionId, { dag, isolated: true }, {
      runTask() {
        replacementCalls += 1
        throw new Error('replacement child must not be provisioned')
      },
      onUpdate() {}
    })
    manager.blockRecoveredPendingDagSessions(scheduler, execution)
    await scheduler.resume()
    eq(replacementCalls, 0, 'waiting parent task must not replace a frozen child')
    eq(scheduler.view().status, 'failed', 'waiting parent task must be recovery-blocked')
    eq(scheduler.view().tasks[0].sessionIds[0], draft.baseMeta.id, 'blocked task must retain child id')
  } finally {
    manager.blockedPendingDagSessions.delete(draft.baseMeta.id)
    cleanupNewJournalEntries(journal, journalBefore)
  }
}

async function checkOrchestratedDraftRequiresParentEvidence({ M, mkRepo, assert }) {
  const manager = M('main/sessionManager.js').sessionManager
  const journal = M('main/session-creation-journal.js')
  const lifecycle = M('main/session-create-lifecycle.js')
  const journalBefore = currentJournalIds(journal)
  const draft = lifecycle.prepareSessionCreationDraft({
    ...managedDraftOptions(mkRepo('managed-session-orphan-child')),
    title: 'orchestrated child without parent evidence',
    parentSessionId: 'missing-parent',
    orchestrationId: 'missing-dag',
    childTaskId: 'missing-task'
  })
  saveUnscopedDraft(journal, draft)
  try {
    await manager.restorePendingSessionCreations([])
    assert(!manager.get(draft.baseMeta.id), 'orchestrated draft without parent evidence must stay frozen')
    assert(hasJournal(journal, draft.baseMeta.id), 'orphan child journal must remain as recovery evidence')
  } finally {
    manager.blockedPendingDagSessions.delete(draft.baseMeta.id)
    cleanupNewJournalEntries(journal, journalBefore)
  }
}

async function checkNewestTerminalDagStatusWins({ M, mkRepo, assert }) {
  const manager = M('main/sessionManager.js').sessionManager
  const journal = M('main/session-creation-journal.js')
  const lifecycle = M('main/session-create-lifecycle.js')
  const journalBefore = currentJournalIds(journal)
  const parentSessionId = 'parent-terminal-journal'
  const dag = singleTaskDag('dag-terminal-journal', 'terminal-child')
  const draft = lifecycle.prepareSessionCreationDraft({
    ...managedDraftOptions(mkRepo('managed-session-terminal-journal')),
    title: 'newest terminal parent status wins',
    parentSessionId,
    orchestrationId: dag.id,
    childTaskId: dag.tasks[0].id
  })
  saveUnscopedDraft(journal, draft)
  const terminal = singleTaskExecution(dag, parentSessionId, 'success', [draft.baseMeta.id], 1)
  const staleRunning = singleTaskExecution(dag, parentSessionId, 'running', [draft.baseMeta.id], 1)
  try {
    await manager.restorePendingSessionCreations([
      { sessionId: parentSessionId, dagExecutions: [terminal], execution: {}, updatedAt: 200 },
      { sessionId: draft.baseMeta.id, dagExecutions: [staleRunning], execution: {}, updatedAt: 100 }
    ])
    assert(!hasJournal(journal, draft.baseMeta.id), 'newest terminal parent status must acknowledge journal')
    assert(!manager.get(draft.baseMeta.id), 'terminal journal must not reactivate a child')
    assert(!manager.blockedPendingDagSessions.has(draft.baseMeta.id), 'terminal journal must not stay blocked')
  } finally {
    manager.blockedPendingDagSessions.delete(draft.baseMeta.id)
    cleanupNewJournalEntries(journal, journalBefore)
  }
}

function createSameProcessResolutionLifecycleCheck({ M, mkRepo, assert, eq }) {
  return async function sameProcessResolutionLifecycleCheck() {
    const manager = M('main/sessionManager.js').sessionManager
    const journal = M('main/session-creation-journal.js')
    const lifecycle = M('main/session-create-lifecycle.js')
    const worktrees = M('main/worktrees.js')
    const handlers = M('main/ipc/worktree-operation-handlers.js')
    const gateway = M('main/task/operation-effect-gateway.js')
    const effectRuntime = M('main/task/effect-runtime.js')
    const originalResolve = effectRuntime.resolvePersistedTaskEffect
    const journalBefore = new Set(
      journal.listPendingSessionCreations().map((draft) => draft.baseMeta.id)
    )
    const draft = lifecycle.prepareSessionCreationDraft({
      cwd: mkRepo('managed-session-same-process-resolution'),
      isolated: true,
      engine: 'claude',
      providerId: 'prov-b',
      model: 'm-b',
      title: 'same-process resolved create'
    })
    const abandonedDraft = lifecycle.prepareSessionCreationDraft({
      cwd: mkRepo('managed-session-not-applied-resolution'),
      isolated: true,
      engine: 'claude',
      providerId: 'prov-b',
      model: 'm-b',
      title: 'not-applied create must be abandoned'
    })
    saveUnscopedDraft(journal, draft)
    saveUnscopedDraft(journal, abandonedDraft)
    const plan = worktrees.prepareManagedWorktreeCreateEffect({
      sessionId: draft.baseMeta.id,
      cwd: draft.opts.cwd,
      isolated: true
    })
    assert(plan.ok && plan.isolated && plan.plan, `same-process worktree plan failed:${plan.error || ''}`)
    const created = await handlers.executeManagedWorktreeCreateEffect(
      plan.plan,
      draft.baseMeta.projectId,
      gateway.executeInteractiveOperationEffect
    )
    assert(created.ok && created.isolated, `same-process worktree create failed:${created.error || ''}`)
    const effectId = 'same-process-create-effect'
    installResolvedCreateEffectMock(effectRuntime, effectId, draft.baseMeta.id)
    try {
      await manager.resolveTaskEffect('operation:same-process-create', effectId, 1, 'confirmed_applied')
      assert(manager.get(draft.baseMeta.id), 'confirmed create resolution must activate frozen top-level session immediately')
      eq(
        manager.get(draft.baseMeta.id).meta.worktreePath,
        created.record.worktreePath,
        'same-process activation must reuse the confirmed worktree'
      )
      installResolvedCreateEffectMock(effectRuntime, effectId, abandonedDraft.baseMeta.id)
      await manager.resolveTaskEffect('operation:not-applied-create', effectId, 1, 'confirmed_not_applied')
      assert(!manager.get(abandonedDraft.baseMeta.id), 'not-applied create must not activate a session')
      assert(
        !journal.listPendingSessionCreations().some((entry) => entry.baseMeta.id === abandonedDraft.baseMeta.id),
        'not-applied create must abandon its frozen journal before the user retries'
      )
    } finally {
      effectRuntime.resolvePersistedTaskEffect = originalResolve
      if (manager.get(draft.baseMeta.id)) await manager.close(draft.baseMeta.id)
      const record = worktrees.managedWorktreeRecordForSession(draft.baseMeta.id)
      if (record && record.state !== 'removed') {
        await handlers.executeInteractiveOperationEffectRemoveWorktree(
          draft.baseMeta.id,
          { force: true, deleteBranch: true },
          gateway.executeInteractiveOperationEffect
        )
      }
      cleanupNewJournalEntries(journal, journalBefore)
    }
  }
}

function createStartupPendingRecoveryCheck({ M, mkRepo, assert }) {
  return async function startupPendingRecoveryCheck() {
    const manager = M('main/sessionManager.js').sessionManager
    const journal = M('main/session-creation-journal.js')
    const lifecycle = M('main/session-create-lifecycle.js')
    const worktrees = M('main/worktrees.js')
    const handlers = M('main/ipc/worktree-operation-handlers.js')
    const gateway = M('main/task/operation-effect-gateway.js')
    const journalBefore = currentJournalIds(journal)
    const draft = lifecycle.prepareSessionCreationDraft({
      ...managedDraftOptions(mkRepo('managed-session-startup-pending')),
      title: 'startup pending session must disclose prompt loss'
    })
    const events = []
    const unsubscribe = manager.subscribe((payload) => {
      if (payload.sessionId === draft.baseMeta.id) events.push(payload.event)
    })
    saveUnscopedDraft(journal, draft)
    try {
      await manager.restorePendingSessionCreations([])
      await waitForCondition(
        () => events.some((event) => event.kind === 'hook-event' && event.event === 'session-create-recovered'),
        3000
      )
      const notice = events.find(
        (event) => event.kind === 'hook-event' && event.event === 'session-create-recovered'
      )
      assert(/original prompt was not stored/.test(notice.detail), 'startup recovery must disclose prompt loss')
      assert(/send the request again/.test(notice.detail), 'startup recovery must require an explicit resend')
    } finally {
      unsubscribe()
      if (manager.get(draft.baseMeta.id)) await manager.close(draft.baseMeta.id)
      const record = worktrees.managedWorktreeRecordForSession(draft.baseMeta.id)
      if (record && record.state !== 'removed') {
        await handlers.executeInteractiveOperationEffectRemoveWorktree(
          draft.baseMeta.id,
          { force: true, deleteBranch: true },
          gateway.executeInteractiveOperationEffect
        )
      }
      cleanupNewJournalEntries(journal, journalBefore)
    }
  }
}

function createNotAppliedPersistenceCrashCheck({ M, mkRepo, assert }) {
  return async function notAppliedPersistenceCrashCheck() {
    const manager = M('main/sessionManager.js').sessionManager
    const journal = M('main/session-creation-journal.js')
    const lifecycle = M('main/session-create-lifecycle.js')
    const effectRuntime = M('main/task/effect-runtime.js')
    const originalResolve = effectRuntime.resolvePersistedTaskEffect
    const journalBefore = currentJournalIds(journal)
    const draft = lifecycle.prepareSessionCreationDraft({
      ...managedDraftOptions(mkRepo('managed-session-not-applied-crash')),
      title: 'not-applied barrier survives persistence crash'
    })
    const effectId = 'not-applied-persist-crash'
    saveUnscopedDraft(journal, draft)
    installResolvedCreateEffectMock(
      effectRuntime,
      effectId,
      draft.baseMeta.id,
      'simulated crash after journal barrier before effect persistence'
    )
    try {
      const failure = await captureFailure(() => manager.resolveTaskEffect(
        'operation:not-applied-persist-crash', effectId, 1, 'confirmed_not_applied'
      ))
      assert(failure, 'simulated post-barrier persistence crash must reject resolution')
      assert(!hasJournal(journal, draft.baseMeta.id), 'journal must be gone before effect persistence starts')
      await manager.restorePendingSessionCreations([])
      assert(!manager.get(draft.baseMeta.id), 'restart recovery must not recreate an abandoned session')
      const strictFailure = await captureFailure(() => manager.writeTaskSnapshot(
        'missing-parent-strict-barrier', 'important-event', 0, undefined, undefined, true
      ))
      assert(/lost active session/.test(strictFailure?.message), 'strict snapshot barrier must reject a missing parent')
    } finally {
      effectRuntime.resolvePersistedTaskEffect = originalResolve
      cleanupNewJournalEntries(journal, journalBefore)
    }
  }
}

function createTerminalAppliedChildRecoveryCheck({ M, mkRepo, assert }) {
  return async function terminalAppliedChildRecoveryCheck() {
    const manager = M('main/sessionManager.js').sessionManager
    const journal = M('main/session-creation-journal.js')
    const lifecycle = M('main/session-create-lifecycle.js')
    const worktrees = M('main/worktrees.js')
    const handlers = M('main/ipc/worktree-operation-handlers.js')
    const gateway = M('main/task/operation-effect-gateway.js')
    const journalBefore = currentJournalIds(journal)
    const parentSessionId = 'parent-terminal-applied-child'
    const dag = singleTaskDag('dag-terminal-applied-child', 'applied-child')
    const draft = lifecycle.prepareSessionCreationDraft({
      ...managedDraftOptions(mkRepo('managed-session-terminal-applied-child')),
      title: 'confirmed child must remain visible after terminal parent crash',
      parentSessionId,
      orchestrationId: dag.id,
      childTaskId: dag.tasks[0].id
    })
    saveUnscopedDraft(journal, draft)
    const plan = worktrees.prepareManagedWorktreeCreateEffect({
      sessionId: draft.baseMeta.id,
      cwd: draft.opts.cwd,
      isolated: true
    })
    const created = await handlers.executeManagedWorktreeCreateEffect(
      plan.plan,
      draft.baseMeta.projectId,
      gateway.executeInteractiveOperationEffect
    )
    assert(created.ok, `terminal child worktree setup failed:${created.error || ''}`)
    const terminal = singleTaskExecution(dag, parentSessionId, 'failed', [], 1)
    try {
      await manager.restorePendingSessionCreations([
        { sessionId: parentSessionId, dagExecutions: [terminal], execution: {}, updatedAt: 100 }
      ])
      assert(manager.get(draft.baseMeta.id), 'confirmed child worktree must be surfaced as a recoverable session')
      assert(
        manager.get(draft.baseMeta.id).meta.worktreePath === created.record.worktreePath,
        'terminal child recovery must reuse the confirmed worktree'
      )
    } finally {
      if (manager.get(draft.baseMeta.id)) await manager.close(draft.baseMeta.id)
      const record = worktrees.managedWorktreeRecordForSession(draft.baseMeta.id)
      if (record && record.state !== 'removed') {
        await handlers.executeInteractiveOperationEffectRemoveWorktree(
          draft.baseMeta.id,
          { force: true, deleteBranch: true },
          gateway.executeInteractiveOperationEffect
        )
      }
      cleanupNewJournalEntries(journal, journalBefore)
    }
  }
}

function createRemovedRegistryRecoveryCheck({ M, mkRepo, assert, eq, tmpRoot }) {
  return async function removedRegistryRecoveryCheck() {
    const manager = M('main/sessionManager.js').sessionManager
    const handlers = M('main/ipc/worktree-operation-handlers.js')
    const gateway = M('main/task/operation-effect-gateway.js')
    const recovery = M('main/session-creation-recovery.js')
    const sessionLifecycle = M('main/session-create-lifecycle.js')
    const meta = await manager.createManaged({
      cwd: mkRepo('managed-session-removed-registry-recovery'),
      isolated: true,
      engine: 'claude',
      providerId: 'prov-b',
      model: 'm-b',
      title: 'removed worktree registry must outrank stale active session'
    })
    await waitForCondition(() => manager.get(meta.id)?.meta.sdkSessionId, 3000)
    const session = manager.get(meta.id)
    assert(session, 'removed-registry setup must create an active session')
    const staleRecord = { ...session.meta, worktreeState: 'active' }
    const managedRecord = M('main/worktrees.js').managedWorktreeRecordForSession(meta.id)
    assert(managedRecord, 'managed worktree setup record must exist')
    manager.sessions.delete(meta.id)
    await session.dispose()
    const activeFile = path.join(tmpRoot, 'userData', 'active-sessions.json')
    writeStaleActiveRecord(activeFile, staleRecord)
    const operationBlocks = recovery.activeSessionRecoveryBlocks([{
      sessionId: 'operation:remove-waiting-reconciliation',
      dagExecutions: [],
      run: {
        operation: { sourceSessionId: meta.id },
        effects: [{ target: { kind: 'git_worktree_remove', sessionId: meta.id } }]
      }
    }])
    assert(operationBlocks.has(meta.id), 'operation source and managed target must block active-session restore')
    manager.restoreActiveSessions(operationBlocks)
    assert(!manager.get(meta.id), 'waiting worktree operation must keep the original Engine stopped')
    const displacedPath = `${meta.worktreePath}.identity-test`
    fs.renameSync(meta.worktreePath, displacedPath)
    fs.mkdirSync(meta.worktreePath, { recursive: true })
    try {
      manager.restoreActiveSessions(new Set())
      assert(!manager.get(meta.id), 'replaced managed path must never restore an Engine')
      assert(
        !JSON.parse(fs.readFileSync(activeFile, 'utf8')).some((record) => record.id === meta.id),
        'identity mismatch must quarantine stale active-session metadata'
      )
      const placementFailure = await captureFailure(async () => sessionLifecycle.sessionMetaForPlacement(
        { baseMeta: staleRecord, opts: { cwd: staleRecord.sourceCwd } },
        { isolated: true, cwd: managedRecord.cwd, record: managedRecord }
      ))
      assert(/placement identity mismatch/.test(placementFailure?.message),
        'journal/manual placement recovery must share the managed topology gate')
    } finally {
      fs.rmSync(meta.worktreePath, { recursive: true, force: true })
      fs.renameSync(displacedPath, meta.worktreePath)
    }
    writeStaleActiveRecord(activeFile, staleRecord)
    const removed = await handlers.executeInteractiveOperationEffectRemoveWorktree(
      meta.id,
      { force: true, deleteBranch: true },
      gateway.executeInteractiveOperationEffect
    )
    assert(removed.ok, `removed-registry setup failed:${removed.error || ''}`)
    const stale = JSON.parse(fs.readFileSync(activeFile, 'utf8'))
    assert(stale.some((record) => record.id === meta.id), 'test must retain stale active-session metadata')
    manager.restoreActiveSessions(new Set())
    assert(!manager.get(meta.id), 'removed managed worktree must never restore an Engine')
    const reconciled = JSON.parse(fs.readFileSync(activeFile, 'utf8'))
    assert(
      !reconciled.some((record) => record.id === meta.id),
      'startup reconciliation must remove stale active-session metadata for removed worktrees'
    )
    try {
      await manager.deleteTaskSnapshot(meta.id)
    } catch {
      // A terminal close may already have removed the setup snapshot.
    }
    eq(manager.list().some((record) => record.id === meta.id), false, 'removed session must stay absent')
  }
}

function createManagedRecoveryGateCheck({ M, mkRepo, sh, assert, eq, tmpRoot }) {
  return async function managedRecoveryGateCheck() {
    const context = await setupManagedRecoveryGate({ M, mkRepo, sh, assert, eq, tmpRoot })
    await checkManagedSnapshotAndActiveRecovery(context)
    checkCorruptRegistryJournalBarrier(context)
    checkMissingRegistryEntryJournalBarrier(context)
    await checkManagedHistoryRecovery(context)
  }
}

async function setupManagedRecoveryGate({ M, mkRepo, sh, assert, eq, tmpRoot }) {
  const manager = M('main/sessionManager.js').sessionManager
  const history = M('main/history.js')
  const sourceCwd = mkRepo('managed-session-recovery-gate')
  const meta = await manager.createManaged({
    ...managedDraftOptions(sourceCwd),
    title: 'managed recovery gate'
  })
  await waitForCondition(() => manager.get(meta.id)?.meta.sdkSessionId, 3000)
  const session = manager.get(meta.id)
  assert(session, 'managed recovery gate setup must create a session')
  const staleRecord = { ...session.meta }
  const sdkSessionId = staleRecord.sdkSessionId
  assert(sdkSessionId, 'managed recovery gate setup must persist an sdk session id')
  assert(
    history.listHistory().some((entry) => entry.id === meta.id && entry.sdkSessionId === sdkSessionId),
    'managed recovery gate setup must persist history identity'
  )
  const worktrees = M('main/worktrees.js')
  const managedRecord = worktrees.managedWorktreeRecordForSession(meta.id)
  assert(managedRecord, 'managed recovery gate setup record must exist')
  const activeFile = path.join(tmpRoot, 'userData', 'active-sessions.json')
  const registryFile = path.join(tmpRoot, 'userData', 'worktrees', 'index.json')
  const registryRaw = fs.readFileSync(registryFile, 'utf8')
  manager.sessions.delete(meta.id)
  return {
    M, sh, assert, eq, tmpRoot, manager, history, sourceCwd, meta, session, staleRecord,
    sdkSessionId, managedRecord, activeFile, registryFile, registryRaw
  }
}

async function checkManagedSnapshotAndActiveRecovery(context) {
  const { assert, manager, meta, session, staleRecord, managedRecord } = context
  const { activeFile, registryFile, registryRaw } = context
  const displacedPath = `${managedRecord.worktreePath}.snapshot-recovery-test`
  fs.renameSync(managedRecord.worktreePath, displacedPath)
  fs.mkdirSync(managedRecord.worktreePath, { recursive: true })
  try {
    const failure = await captureFailure(() => manager.recoverTaskSnapshot(meta.id))
    assert(/managed worktree recovery identity mismatch/.test(failure?.message),
      'task snapshot recovery must reject a replaced managed worktree path')
    assert(!manager.get(meta.id), 'rejected task snapshot recovery must not create an Engine')
  } finally {
    fs.rmSync(managedRecord.worktreePath, { recursive: true, force: true })
    fs.renameSync(displacedPath, managedRecord.worktreePath)
  }
  await session.dispose()
  writeStaleActiveRecord(activeFile, staleRecord)
  fs.unlinkSync(registryFile)
  manager.restoreActiveSessions(new Set())
  assertQuarantinedActiveSession(context, 'missing managed registry')
  fs.writeFileSync(registryFile, registryRaw)
  writeStaleActiveRecord(activeFile, staleRecord)
  fs.writeFileSync(registryFile, '{broken registry')
  manager.restoreActiveSessions(new Set())
  assertQuarantinedActiveSession(context, 'corrupt managed registry')
}

function assertQuarantinedActiveSession(context, reason) {
  const { assert, manager, meta, activeFile } = context
  assert(!manager.get(meta.id), `${reason} must block active-session recovery`)
  assert(
    !JSON.parse(fs.readFileSync(activeFile, 'utf8')).some((record) => record.id === meta.id),
    `${reason} must quarantine stale active-session metadata`
  )
}

function checkCorruptRegistryJournalBarrier(context) {
  const { M, assert, eq, sourceCwd, registryFile, registryRaw } = context
  const lifecycle = M('main/session-create-lifecycle.js')
  const recovery = M('main/session-creation-recovery.js')
  const journal = M('main/session-creation-journal.js')
  const dag = singleTaskDag('dag-corrupt-registry-journal', 'terminal-child')
  const parentSessionId = 'parent-corrupt-registry-journal'
  const draft = lifecycle.prepareSessionCreationDraft({
    ...managedDraftOptions(sourceCwd),
    title: 'corrupt registry must retain terminal child journal',
    parentSessionId,
    orchestrationId: dag.id,
    childTaskId: dag.tasks[0].id,
    childRole: dag.tasks[0].role
  })
  const journalBefore = currentJournalIds(journal)
  saveUnscopedDraft(journal, draft)
  try {
    const execution = singleTaskExecution(dag, parentSessionId, 'failed', [], 1)
    const plan = recovery.planPendingSessionCreations([{
      sessionId: parentSessionId, dagExecutions: [execution], execution: {}, updatedAt: 100
    }]).find((candidate) => candidate.draft.baseMeta.id === draft.baseMeta.id)
    eq(plan?.kind, 'block', 'corrupt registry must block terminal child journal acknowledgement')
    assert(hasJournal(journal, draft.baseMeta.id), 'blocked terminal child journal must remain durable')
  } finally {
    cleanupNewJournalEntries(journal, journalBefore)
    fs.writeFileSync(registryFile, registryRaw)
  }
}

function checkMissingRegistryEntryJournalBarrier(context) {
  const { M, sh, assert, eq, sourceCwd, tmpRoot } = context
  const lifecycle = M('main/session-create-lifecycle.js')
  const recovery = M('main/session-creation-recovery.js')
  const journal = M('main/session-creation-journal.js')
  const dag = singleTaskDag('dag-missing-registry-entry', 'terminal-orphan-child')
  const parentSessionId = 'parent-missing-registry-entry'
  const draft = lifecycle.prepareSessionCreationDraft({
    ...managedDraftOptions(sourceCwd),
    parentSessionId,
    orchestrationId: dag.id,
    childTaskId: dag.tasks[0].id,
    childRole: dag.tasks[0].role
  })
  const journalBefore = currentJournalIds(journal)
  const branch = `caogen/${draft.baseMeta.id}`
  const orphanPath = path.join(tmpRoot, 'userData', 'worktrees', draft.baseMeta.id)
  let branchDeleted = false
  saveUnscopedDraft(journal, draft)
  sh(sourceCwd, 'git', ['worktree', 'add', '-b', branch, orphanPath])
  try {
    const execution = singleTaskExecution(dag, parentSessionId, 'failed', [], 1)
    eq(pendingDraftPlan(recovery, draft, parentSessionId, execution)?.kind, 'block',
      'terminal child with an orphaned Git worktree must retain its journal')
    sh(sourceCwd, 'git', ['worktree', 'remove', '--force', orphanPath])
    sh(sourceCwd, 'git', ['branch', '-D', branch])
    branchDeleted = true
    eq(pendingDraftPlan(recovery, draft, parentSessionId, execution)?.kind, 'acknowledge',
      'terminal child may acknowledge only after worktree and branch absence is proven')
  } finally {
    if (fs.existsSync(orphanPath)) sh(sourceCwd, 'git', ['worktree', 'remove', '--force', orphanPath])
    if (!branchDeleted) sh(sourceCwd, 'git', ['branch', '-D', branch])
    cleanupNewJournalEntries(journal, journalBefore)
  }
}

function pendingDraftPlan(recovery, draft, parentSessionId, execution) {
  return recovery.planPendingSessionCreations([{
    sessionId: parentSessionId, dagExecutions: [execution], execution: {}, updatedAt: 100
  }]).find((candidate) => candidate.draft.baseMeta.id === draft.baseMeta.id)
}

async function checkManagedHistoryRecovery(context) {
  const { M, assert, eq, tmpRoot, manager, history, meta } = context
  const { sdkSessionId, managedRecord, staleRecord } = context
  const lifecycle = M('main/session-create-lifecycle.js')
  const persisted = history.listHistory().find((entry) => entry.id === meta.id)
  assert(persisted, 'managed recovery gate history record must remain available')
  const savedHistory = { ...persisted }
  for (const field of managedHistoryIdentityFields()) delete persisted[field]
  const strippedFailure = await captureFailure(async () => lifecycle.prepareSessionCreationDraft({
    cwd: untrustedHistoryCwd(tmpRoot), resumeSdkSessionId: sdkSessionId
  }))
  assert(/managed worktree identity 与 registry 不一致/.test(strippedFailure?.message),
    'stripped managed history metadata must not downgrade to an ordinary cwd resume')
  Object.assign(persisted, savedHistory)
  await manager.deleteTaskSnapshot(meta.id)
  const untrustedCwd = untrustedHistoryCwd(tmpRoot)
  fs.mkdirSync(untrustedCwd, { recursive: true })
  await checkResumeActivationJournalBarrier(context, untrustedCwd)
  const resumed = await manager.createManaged({
    cwd: untrustedCwd, providerId: 'prov-a', model: 'untrusted-model',
    parentSessionId: 'untrusted-parent', orchestrationId: 'untrusted-orchestration',
    childTaskId: 'untrusted-task', childRole: 'untrusted-role', resumeSdkSessionId: sdkSessionId,
    title: 'resume must use persisted history identity'
  })
  eq(resumed.id, meta.id, 'history resume must retain the managed lifecycle session id')
  eq(resumed.cwd, managedRecord.cwd, 'history resume must ignore the renderer-supplied cwd')
  eq(resumed.worktreePath, managedRecord.worktreePath, 'history resume must retain the managed worktree')
  eq(resumed.providerId, staleRecord.providerId, 'history resume must use the persisted Provider identity')
  eq(resumed.model, staleRecord.model, 'history resume must use the persisted model identity')
  eq(resumed.parentSessionId, staleRecord.parentSessionId, 'history resume must not rebind parent session ownership')
  eq(resumed.orchestrationId, staleRecord.orchestrationId, 'history resume must not rebind orchestration ownership')
  eq(resumed.childTaskId, staleRecord.childTaskId, 'history resume must not rebind child task ownership')
  eq(resumed.childRole, staleRecord.childRole, 'history resume must not rebind child role ownership')
  await manager.close(resumed.id)
  await removeManagedRecoveryGateWorktree(context)
}

async function checkResumeActivationJournalBarrier(context, cwd) {
  const { M, assert, manager, meta, sdkSessionId } = context
  const journal = M('main/session-creation-journal.js')
  const originalWriteTaskSnapshot = manager.writeTaskSnapshot
  manager.writeTaskSnapshot = async function (...args) {
    if (args[1] === 'created' && args[5] === true) {
      throw new Error('simulated resume strict activation failure')
    }
    return originalWriteTaskSnapshot.apply(this, args)
  }
  let failure
  try {
    failure = await captureFailure(() => manager.createManaged({
      cwd, resumeSdkSessionId: sdkSessionId, title: 'resume activation barrier failure'
    }))
  } finally {
    manager.writeTaskSnapshot = originalWriteTaskSnapshot
  }
  assert(failure?.sessionCreationJournalPending === true,
    'resume strict activation failure must report a pending creation journal')
  assert(hasJournal(journal, meta.id), 'synchronous resume init must not acknowledge the journal early')
  assert(!manager.get(meta.id), 'failed resume activation must not leave an active Engine')
  const originalDeletePending = journal.deletePendingSessionCreation
  journal.deletePendingSessionCreation = (sessionId) => {
    if (sessionId === meta.id) throw new Error('simulated creation journal acknowledgement failure')
    return originalDeletePending(sessionId)
  }
  try {
    failure = await captureFailure(() => manager.createManaged({
      cwd, resumeSdkSessionId: sdkSessionId, title: 'resume acknowledgement barrier failure'
    }))
  } finally {
    journal.deletePendingSessionCreation = originalDeletePending
  }
  assert(failure?.sessionCreationJournalPending === true,
    'journal acknowledgement failure must preserve the activation recovery contract')
  assert(hasJournal(journal, meta.id), 'failed acknowledgement must retain the creation journal')
  assert(!manager.get(meta.id), 'failed acknowledgement must roll back the active Engine')
}

function managedHistoryIdentityFields() {
  return ['isolated', 'sourceCwd', 'repoRoot', 'worktreePath', 'branch', 'baseBranch', 'baseSha', 'worktreeState']
}

async function removeManagedRecoveryGateWorktree(context) {
  const { M, assert, meta } = context
  const handlers = M('main/ipc/worktree-operation-handlers.js')
  const gateway = M('main/task/operation-effect-gateway.js')
  const removed = await handlers.executeInteractiveOperationEffectRemoveWorktree(
    meta.id, { force: true, deleteBranch: true }, gateway.executeInteractiveOperationEffect
  )
  assert(removed.ok, `managed recovery gate cleanup failed:${removed.error || ''}`)
}

function untrustedHistoryCwd(tmpRoot) {
  return path.join(tmpRoot, 'history-resume-untrusted-cwd')
}

function unknownCreateResult(plan) {
  return {
    ok: false,
    isolated: true,
    cwd: plan.record.sourceCwd,
    error: 'simulated unknown managed worktree create',
    effectStatus: 'waiting_reconciliation',
    operationId: 'managed-session-unknown-operation',
    snapshotId: 'operation:managed-session-unknown-operation',
    recoverySnapshot: { id: 'operation:managed-session-unknown-operation' }
  }
}

function managedDraftOptions(cwd) {
  return { cwd, isolated: true, engine: 'claude', providerId: 'prov-b', model: 'm-b' }
}

function singleTaskDag(id, taskId) {
  return {
    id,
    title: 'Lifecycle recovery',
    source: 'integration smoke',
    complexity: 'single',
    createdAt: Date.now(),
    tasks: [{
      id: taskId,
      title: 'Frozen child',
      description: 'Must not be replaced',
      dependencies: [],
      role: 'backend',
      prompt: 'do not dispatch a replacement'
    }]
  }
}

function singleTaskExecution(dag, parentSessionId, status, sessionIds, attempts) {
  return {
    id: dag.id,
    parentSessionId,
    dag,
    status,
    maxRetries: 2,
    startedAt: dag.createdAt,
    layers: [[dag.tasks[0].id]],
    tasks: [{ task: dag.tasks[0], status, attempts, sessionIds }]
  }
}

function saveUnscopedDraft(journal, draft) {
  draft.baseMeta.digitalWorkerBinding ??= { kind: 'unscoped' }
  journal.savePendingSessionCreation(draft)
}

function currentJournalIds(journal) {
  return new Set(journal.listPendingSessionCreations().map((draft) => draft.baseMeta.id))
}

function hasJournal(journal, sessionId) {
  return journal.listPendingSessionCreations().some((draft) => draft.baseMeta.id === sessionId)
}

function installResolvedCreateEffectMock(effectRuntime, effectId, sessionId, persistError) {
  effectRuntime.resolvePersistedTaskEffect = async (...args) => {
    const effect = { id: effectId, target: { kind: 'git_worktree_create', sessionId } }
    await args[4]?.beforePersist?.(effect)
    if (persistError) throw new Error(persistError)
    return { run: { effects: [effect] } }
  }
}

function writeStaleActiveRecord(file, staleRecord) {
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
  fs.writeFileSync(
    file,
    JSON.stringify([...current.filter((record) => record.id !== staleRecord.id), staleRecord], null, 2)
  )
}

async function captureFailure(run) {
  try {
    await run()
    return undefined
  } catch (error) {
    return error
  }
}

function cleanupNewJournalEntries(journal, journalBefore) {
  for (const draft of journal.listPendingSessionCreations()) {
    if (!journalBefore.has(draft.baseMeta.id)) {
      journal.deletePendingSessionCreation(draft.baseMeta.id)
    }
  }
}

async function waitForCondition(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for lifecycle test condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

module.exports = {
  createActivationFailureLifecycleCheck,
  createManagedRecoveryGateCheck,
  createManagedWorktreeLifecycleCheck,
  createNotAppliedPersistenceCrashCheck,
  createRecoverableSnapshotPrecedenceCheck,
  createRemovedRegistryRecoveryCheck,
  createSameProcessResolutionLifecycleCheck,
  createStartupPendingRecoveryCheck,
  createTerminalAppliedChildRecoveryCheck,
  createUnknownSessionLifecycleCheck
}
