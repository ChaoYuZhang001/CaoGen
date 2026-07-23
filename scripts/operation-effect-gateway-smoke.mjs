import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

const ipcSource = read('src/main/ipc.ts')
const rendererMutationSource = read('src/main/ipc/renderer-mutation-handlers.ts')
const effectTypesSource = read('src/shared/effect-types.ts')
const sharedTypesSource = read('src/shared/types.ts')
const reconcilerSource = read('src/main/task/effect-reconciler.ts')
const targetBuilderSource = read('src/main/task/effect-target-builder.ts')
const gitToolsSource = read('src/main/agent/tools/git-tools.ts')
const gitDiffSource = read('src/main/gitDiff.ts')
const gitPatchInspectionSource = read('src/main/git/git-patch-inspection.ts')
const worktreeHunkEffectSource = read('src/main/git/worktree-hunk-effect.ts')
const fileEffectReconciliationSource = read('src/main/task/file-effect-reconciliation.ts')
const worktreesSource = read('src/main/worktrees.ts')
const sessionManagerSource = read('src/main/sessionManager.ts')
const sessionManagerSupportSource = read('src/main/session-manager-support.ts')
const sessionCreateLifecycleSource = read('src/main/session-create-lifecycle.ts')
const sessionCreationJournalSource = read('src/main/session-creation-journal.ts')
const dagSchedulerSource = read('src/main/agent/dag-scheduler.ts')
const ideBridgeSource = read('src/main/ide/ide-bridge.ts')
const ideBridgeManagerSource = read('src/main/ide/ide-bridge-manager.ts')
const routineExecutorSource = read('src/main/routines/routine-executor.ts')
const openaiToolsSource = read('src/main/openaiTools.ts')
const rendererStoreSource = read('src/renderer/src/store.ts')
const operationGatewaySource = read('src/main/task/operation-effect-gateway.ts')
const taskRunSource = read('src/main/task/task-run.ts')
const effectRuntimeSource = read('src/main/task/effect-runtime.ts')
const worktreeOperationSource = read('src/main/ipc/worktree-operation-handlers.ts')
const electronSmokeSource = read('scripts/electron-smoke.cjs')

assert(
  ipcSource.includes("from './task/operation-effect-gateway'"),
  'Renderer delivery operations must import the durable Operation Effect Gateway'
)
assertHandlerUsesGateway('worktrees:applyPatch')
assertHandlerUsesGateway('worktrees:createPr')
assertHandlerUsesGateway('files:write')
assertHandlerUsesGateway('git:commit')
assertHandlerUsesGateway('workspace:discardHunk')
assert(
  rendererMutationSource.includes("toolName: 'write_file'") &&
    rendererMutationSource.includes("toolName: 'git_commit'") &&
    rendererMutationSource.includes("toolName: 'workspace_discard_hunk'"),
  'Renderer file save, discard hunk and commit must reuse queryable Effect targets'
)
assert(
  rendererMutationSource.includes("from '../git/git-helper'") &&
    !ipcSource.includes('commit as gitCommit'),
  'Renderer commit must use the hook-disabled Git helper behind the Gateway'
)
assert(
  effectTypesSource.includes("| 'file_write'") &&
    effectTypesSource.includes("| 'workspace_hunk_discard'") &&
    effectTypesSource.includes("| 'git_commit'") &&
    sharedTypesSource.includes('InteractiveOperationKind,') &&
    sharedTypesSource.includes("} from './effect-types'"),
  'Renderer file and commit operations need durable operation metadata kinds'
)
assert(
  targetBuilderSource.includes("toolName === 'workspace_discard_hunk'") &&
    targetBuilderSource.includes('buildDiscardWorkspaceHunkEffectTarget') &&
    worktreeHunkEffectSource.includes("expectedState: plan.expectedState") &&
    fileEffectReconciliationSource.includes("expectedState === 'absent'"),
  'discard hunk must freeze and reconcile an exact file postcondition'
)
assert(
  sharedTypesSource.includes('export type WorkspaceHunkResult') &&
    sharedTypesSource.includes('snapshotId?: string') &&
    rendererStoreSource.includes("result.effectStatus === 'waiting_reconciliation' ? [get().refreshTaskSnapshots()]"),
  'discard hunk unknown outcomes must refresh the visible recovery entrypoint'
)
assert(
  effectTypesSource.includes("kind: 'worktree_patch_apply'"),
  'worktree patch application needs a dedicated queryable EffectTarget'
)
assert(
  effectTypesSource.includes("kind: 'pull_request_create'"),
  'pull request creation needs a dedicated queryable EffectTarget'
)
assert(
  targetBuilderSource.includes("toolName === 'git_create_pr'"),
  'git_create_pr must build a dedicated effect descriptor'
)
assert(
  reconcilerSource.includes("effect.target.kind === 'pull_request_create'"),
  'pull request effects must have a read-only reconciler'
)
assert(
  gitToolsSource.includes("context.effectTarget?.kind === 'pull_request_create'"),
  'git_create_pr execution must consume the frozen effect target and marker'
)
assert(
  gitToolsSource.includes('code_forge_delivery mode=commit') &&
    gitToolsSource.includes('code_forge_delivery mode=pr') &&
    gitToolsSource.includes('已阻止'),
  'unsplit code_forge_delivery commit/pr modes must fail closed'
)
assert(
  gitDiffSource.includes('inspectSingleFilePatch') &&
    gitPatchInspectionSource.includes("'apply', '--numstat', '-z'") &&
    gitPatchInspectionSource.includes('patchPaths.length !== 1 || patchPaths[0] !== declaredPath'),
  'hunk mutations must verify the patch path matches the Renderer-declared file'
)
assert(
  worktreesSource.includes('直接应用 worktree patch 的同步入口已禁用'),
  'legacy direct worktree patch entry must fail closed'
)
assert(
  worktreesSource.includes('直接 push 并创建 PR/MR 的复合入口已禁用'),
  'legacy compound push and PR entry must fail closed'
)
assert(
  sessionManagerSource.includes('isInteractiveOperationActive(snapshot)') &&
    sessionManagerSource.includes('交互操作快照只能进行效果对账'),
  'active operation snapshots must not be reconciled or resumed as Agent sessions'
)
assertManagedSessionCreateBarrier()
assert(
  ipcSource.includes('return await sessionManager.createManaged(opts)') &&
    ideBridgeManagerSource.includes('sessionManager.createManaged(options)') &&
    ideBridgeSource.includes('const meta = await this.sessionPort.createSession(options)') &&
    routineExecutorSource.includes('await sessionManager.createManaged({') &&
    openaiToolsSource.includes('const result = await manager.dispatchTaskDag(') &&
    openaiToolsSource.includes('const dispatch = await manager.dispatchTaskDag('),
  'IPC, IDE, Routine and OpenAI DAG entrypoints must await managed session creation transitively'
)
assert(
  dagSchedulerSource.includes('const run = await this.callbacks.runTask(state.task, context)') &&
    dagSchedulerSource.includes('await deferred.start?.()') &&
    dagSchedulerSource.includes('const deferredStarts: DeferredTaskStart[] = []') &&
    sessionManagerSource.includes('const launched = await scheduler.start()'),
  'DAG must provision the durable ready batch before starting child prompts'
)
assert(
  effectTypesSource.includes("'renderer' | 'dag' | 'session_lifecycle'") &&
    operationGatewaySource.includes('source?: InteractiveOperationSource') &&
    operationGatewaySource.includes("source: spec.source ?? 'renderer'") &&
    operationGatewaySource.includes('snapshot.run?.operation !== undefined'),
  'operation snapshots must persist renderer, DAG and session lifecycle ownership with a renderer default'
)
assert(
  taskRunSource.includes("'managed_worktree_create'") &&
    taskRunSource.includes("'managed_worktree_remove'") &&
    taskRunSource.includes("record.source === 'dag'") &&
    taskRunSource.includes("record.source === 'session_lifecycle'") &&
    effectRuntimeSource.includes('usesPreExecutionNativeToolGate(engine) || run.operation !== undefined') &&
    effectRuntimeSource.includes("return engine === 'openai' || engine === 'anthropic'"),
  'all operation sources and managed worktree kinds must survive validation and the prepared barrier'
)
assert(
  worktreeOperationSource.includes("source: 'dag'") &&
    worktreeOperationSource.includes("source: 'session_lifecycle'") &&
    electronSmokeSource.includes('filter((snapshot) => snapshot.run?.operation)'),
  'DAG/session lifecycle callers must be explicit and residue checks must cover every operation source'
)

console.log('operation effect gateway smoke: PASS')

function assertHandlerUsesGateway(channel) {
  const start = ipcSource.indexOf(`ipcMain.handle('${channel}'`)
  assert(start >= 0, `${channel} handler missing`)
  const next = ipcSource.indexOf('\n  ipcMain.handle(', start + 1)
  const handler = ipcSource.slice(start, next >= 0 ? next : undefined)
  assert(
    handler.includes('executeInteractiveOperationEffect'),
    `${channel} must cross a durable effect barrier before its external mutation`
  )
}

function assertManagedSessionCreateBarrier() {
  const start = sessionManagerSource.indexOf('async createManaged(')
  const end = sessionManagerSource.indexOf('\n  private sessionCreationDraft(', start)
  assert(start >= 0 && end > start, 'SessionManager.createManaged implementation missing')
  const method = sessionManagerSource.slice(start, end)
  const journal = method.indexOf('savePendingSessionCreation(draft)')
  const placement = method.indexOf('placement = await managedSessionPlacement(draft)')
  const activation = method.indexOf('await this.activateManagedSessionCreation(draft, placement)')
  assert(
    journal >= 0 && placement > journal && activation > placement,
    'SessionManager must journal, await managed placement, then durably activate in order'
  )
  const execute = sessionCreateLifecycleSource.indexOf('await executeManagedWorktreeCreateEffect(')
  const rejectUnknown = sessionCreateLifecycleSource.indexOf('if (!created.ok)', execute)
  const returnConfirmed = sessionCreateLifecycleSource.indexOf('return created', rejectUnknown)
  assert(
    execute >= 0 && rejectUnknown > execute && returnConfirmed > rejectUnknown,
    'managed placement must reject unknown outcomes before returning a worktree placement'
  )
  assert(
    sessionManagerSource.includes('const meta = await this.createManaged({'),
    'subagent and DAG session creation must await the managed lifecycle entrypoint'
  )
  assert(
    sessionManagerSource.includes('withSessionCreationJournalBarrier(') &&
      sessionManagerSource.includes('this.persistActiveSessions(true)') &&
      sessionManagerSource.includes("this.writeTaskSnapshot(prepared.meta.id, 'created', 0, undefined, undefined, true)") &&
      sessionManagerSource.includes('void prepared?.session.start()') &&
      sessionManagerSupportSource.includes('acknowledge()') &&
      sessionManagerSupportSource.indexOf('acknowledge()') <
        sessionManagerSupportSource.indexOf('retained.delete(sessionId)', sessionManagerSupportSource.indexOf('acknowledge()')) &&
      sessionManagerSupportSource.includes('await rollback()') &&
      sessionCreationJournalSource.includes('fsyncSync(descriptor)') &&
      sessionCreationJournalSource.includes('const { initialPrompt: _initialPrompt, ...opts } = draft.opts'),
    'activation must retain a secret-free fsynced journal through strict persistence and acknowledgement before start'
  )
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
