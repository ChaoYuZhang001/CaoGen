import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

const ipcSource = read('src/main/ipc.ts')
const attachmentMutationIpcSource = read('src/main/ipc/attachment-mutation-ipc.ts')
const projectContextMutationIpcSource = read('src/main/ipc/project-context-mutation-ipc.ts')
const mcpProbeIpcSource = read('src/main/ipc/mcp-probe-ipc.ts')
const pluginInstallIpcSource = read('src/main/ipc/plugin-install-ipc.ts')
const terminalMutationIpcSource = read('src/main/ipc/terminal-mutation-ipc.ts')
const browserMutationIpcSource = read('src/main/ipc/browser-mutation-ipc.ts')
const interactiveMutationSource = read('src/main/ipc/interactive-mutation-handlers.ts')
const unassignedSessionSource = read('src/main/ipc/unassigned-session.ts')
const ipcSources = [
  ipcSource,
  interactiveMutationSource,
  attachmentMutationIpcSource,
  projectContextMutationIpcSource,
  mcpProbeIpcSource,
  pluginInstallIpcSource,
  terminalMutationIpcSource,
  browserMutationIpcSource
]
const rendererMutationSource = read('src/main/ipc/renderer-mutation-handlers.ts')
const attachmentEffectSource = read('src/main/attachmentEffect.ts')
const projectContextEffectSource = read('src/main/projectContextEffect.ts')
const mcpProbeEffectSource = read('src/main/mcpProbeEffect.ts')
const pluginInstallEffectSource = read('src/main/pluginInstallEffect.ts')
const terminalEffectSource = read('src/main/terminalEffect.ts')
const browserEffectSource = read('src/main/browserEffect.ts')
const pluginTargetValidationSource = read('src/main/plugin/plugin-effect-target-validation.ts')
const attachmentOpsSource = read('src/main/attachmentOps.ts')
const effectTypesSource = read('src/shared/effect-types.ts')
const sharedTypesSource = read('src/shared/types.ts')
const reconcilerSource = read('src/main/task/effect-reconciler.ts')
const localReconcilerSource = read('src/main/task/effect-reconciler-local-targets.ts')
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
const terminalActionsSource = read('src/renderer/src/store/terminal-actions.ts')
const browserActionsSource = read('src/renderer/src/store/browser-actions.ts')
const operationGatewaySource = read('src/main/task/operation-effect-gateway.ts')
const taskRunSource = read('src/main/task/task-run.ts')
const effectRuntimeSource = read('src/main/task/effect-runtime.ts')
const worktreeOperationSource = read('src/main/ipc/worktree-operation-handlers.ts')
const electronSmokeSource = read('scripts/electron-smoke.cjs')
const composerSource = read('src/renderer/src/components/Composer.tsx')
const projectSettingsSource = read('src/renderer/src/pages/ProjectSettings.tsx')
const settingsModalSource = read('src/renderer/src/components/SettingsModal.tsx')
const taskRecoveryActionsSource = read('src/renderer/src/store/task-recovery-actions.ts')

assert(
  ipcSource.includes("from './ipc/interactive-mutation-handlers'") &&
    interactiveMutationSource.includes("from '../task/operation-effect-gateway'"),
  'Renderer delivery operations must import the durable Operation Effect Gateway'
)
assertHandlerUsesGateway('worktrees:applyPatch')
assertHandlerUsesGateway('worktrees:createPr')
assertHandlerUsesGateway('files:write')
assertHandlerUsesGateway('git:commit')
assertHandlerUsesGateway('workspace:discardHunk')
assertHandlerUsesGateway('attachments:copyImage')
assertHandlerUsesGateway('attachments:saveImageBytes')
assertHandlerUsesGateway('projectContext:write')
assertHandlerUsesGateway('plugins:probeMcp')
assertHandlerUsesGateway('terminals:start')
assertHandlerUsesGateway('terminals:write')
assertHandlerUsesGateway('terminals:resize')
assertHandlerUsesGateway('terminals:close')
assertHandlerUsesGateway('browser:open')
assertHandlerUsesGateway('browser:navigate')
assertHandlerUsesGateway('browser:back')
assertHandlerUsesGateway('browser:forward')
assertHandlerUsesGateway('browser:reload')
assertHandlerUsesBoundary('plugins:installLocal', 'installLocalPluginWithEffect')
assertHandlerUsesBoundary('plugins:uninstall', 'uninstallPluginWithEffect')
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
    effectTypesSource.includes("| 'attachment_write'") &&
    effectTypesSource.includes("| 'mcp_probe'") &&
    effectTypesSource.includes("| 'terminal_action'") &&
    effectTypesSource.includes("| 'browser_navigation'") &&
    effectTypesSource.includes("| 'plugin_install'") &&
    effectTypesSource.includes("| 'plugin_uninstall'") &&
    effectTypesSource.includes("| 'workspace_hunk_discard'") &&
    effectTypesSource.includes("| 'git_commit'") &&
    sharedTypesSource.includes('InteractiveOperationKind,') &&
    sharedTypesSource.includes("} from './effect-types'"),
  'Renderer file and commit operations need durable operation metadata kinds'
)
assert(
  terminalEffectSource.includes("start: 'terminal_start'") &&
    terminalEffectSource.includes("write: 'terminal_write'") &&
    terminalEffectSource.includes("resize: 'terminal_resize'") &&
    terminalEffectSource.includes("close: 'terminal_close'") &&
    terminalEffectSource.includes("dataSha256: createHash('sha256').update(data, 'utf8').digest('hex')") &&
    terminalEffectSource.includes("bytes: Buffer.byteLength(data, 'utf8')") &&
    terminalEffectSource.includes("effect.target.kind !== 'unsupported'") &&
    !terminalEffectSource.includes('toolInput: { data'),
  'terminal mutations must use opaque Effects with digest-only persisted command input'
)
assert(
  terminalActionsSource.includes("result.effectStatus === 'waiting_reconciliation'") &&
    terminalActionsSource.includes('window.agentDesk.writeTerminal') &&
    terminalActionsSource.includes('window.agentDesk.closeTerminal'),
  'unknown terminal outcomes must refresh the visible recovery surface'
)
assert(
  browserEffectSource.includes("open: 'browser_view_open'") &&
    browserEffectSource.includes("navigate: 'browser_view_navigate'") &&
    browserEffectSource.includes("back: 'browser_view_back'") &&
    browserEffectSource.includes("forward: 'browser_view_forward'") &&
    browserEffectSource.includes("reload: 'browser_view_reload'") &&
    browserEffectSource.includes('targetDigest: sha256(url)') &&
    browserEffectSource.includes('hostDigest: parsed.host ? sha256(parsed.host) : undefined') &&
    browserEffectSource.includes("effect.target.kind !== 'unsupported'") &&
    !browserEffectSource.includes('toolInput: { url'),
  'browser page mutations must use opaque Effects with digest-only persisted URL evidence'
)
assert(
  browserActionsSource.includes('window.agentDesk.openBrowser') &&
    browserActionsSource.includes('window.agentDesk.navigateBrowser') &&
    browserActionsSource.includes('window.agentDesk.browserGoBack') &&
    browserActionsSource.includes('window.agentDesk.browserGoForward') &&
    browserActionsSource.includes('window.agentDesk.reloadBrowser') &&
    browserActionsSource.includes("result.effectStatus === 'waiting_reconciliation'"),
  'unknown browser navigation outcomes must refresh the visible recovery surface'
)
assert(
  effectTypesSource.includes("kind: 'managed_plugin_install'") &&
    effectTypesSource.includes("kind: 'managed_plugin_uninstall'") &&
    targetBuilderSource.includes('isManagedPluginEffectToolName(toolName)') &&
    localReconcilerSource.includes('reconcileManagedPluginEffectTarget(target)') &&
    pluginTargetValidationSource.includes('isManagedPluginEffectTarget'),
  'plugin install and uninstall need strict queryable Effect targets'
)
assert(
  pluginInstallEffectSource.includes("toolName: 'managed_plugin_install'") &&
    pluginInstallEffectSource.includes("toolName: 'managed_plugin_uninstall'") &&
    pluginInstallEffectSource.includes('executeInteractiveOperationEffect') &&
    pluginInstallEffectSource.includes('pluginInstallToolInput(prepared)') &&
    pluginInstallEffectSource.includes('prepared.sourcePath'),
  'plugin IPC wrappers must persist frozen summaries and keep source paths execution-only'
)
assert(
  rendererStoreSource.match(/result\.effectStatus === 'waiting_reconciliation'/g)?.length >= 2 &&
    rendererStoreSource.includes('await get().refreshTaskSnapshots()'),
  'unknown plugin mutations must refresh the visible recovery surface'
)
assert(
  attachmentEffectSource.includes("toolName = source === 'user_file' ? 'attachment_copy_image' : 'attachment_save_image_bytes'") &&
    attachmentEffectSource.includes("kind: 'attachment_write'") &&
    attachmentEffectSource.includes("effect.target.kind !== 'unsupported'") &&
    attachmentEffectSource.includes('contentSha256: prepared.hash') &&
    !attachmentEffectSource.includes('toolInput: { data') &&
    !attachmentEffectSource.includes('sourcePath'),
  'attachment writes must use opaque Effects with digest-only persisted input'
)
assert(
  rendererMutationSource.indexOf('prepareImageAttachmentFile(sourcePath)') <
    rendererMutationSource.indexOf("'user_file',") &&
    rendererMutationSource.indexOf('prepareImageAttachmentBytes(data, { mime })') <
    rendererMutationSource.indexOf("'renderer_bytes',") &&
    attachmentOpsSource.includes('sha256(buffer) !== prepared.hash') &&
    attachmentOpsSource.includes('Buffer.from(new Uint8Array(input))'),
  'attachment payloads must be frozen and digest-checked before the durable mutation callback'
)
assert(
  composerSource.includes("result.effectStatus === 'waiting_reconciliation'") &&
    composerSource.includes('await useStore.getState().refreshTaskSnapshots()'),
  'opaque attachment outcomes must refresh the visible recovery surface'
)
assert(
  projectContextEffectSource.includes("toolName: 'write_file'") &&
    projectContextEffectSource.includes("toolInput: { path: 'caogen.md', content: safeContent }") &&
    projectContextEffectSource.includes("effect.target.relativePath !== 'caogen.md'") &&
    projectContextEffectSource.includes("writeTextFile(projectRoot, 'caogen.md', safeContent)") &&
    !projectContextEffectSource.includes('writeProjectContext('),
  'project context writes must reuse the atomic queryable file Effect target'
)
assert(
  projectSettingsSource.includes("result.effectStatus === 'waiting_reconciliation'") &&
    projectSettingsSource.includes('await useStore.getState().refreshTaskSnapshots()'),
  'unknown project context writes must refresh the visible recovery surface'
)
assert(
  mcpProbeEffectSource.includes("toolName: 'mcp_runtime_probe'") &&
    mcpProbeEffectSource.includes('configDigest: stableValueDigest(input.config)') &&
    mcpProbeEffectSource.includes("effect.target.kind !== 'unsupported'") &&
    !mcpProbeEffectSource.includes('toolInput: { inputs'),
  'MCP runtime probes must persist only opaque target summaries'
)
assert(
  electronSmokeSource.includes("invoke('plugins:probeMcp', [])") &&
    electronSmokeSource.includes("probe?.ok === true") &&
    electronSmokeSource.includes('probe.results.length === 0'),
  'real Electron smoke must prove the MCP probe IPC is registered and returns the operation envelope'
)
assert(
  taskRecoveryActionsSource.includes("outcome.effectStatus === 'waiting_reconciliation'") &&
    taskRecoveryActionsSource.includes('await refreshRecovery()') &&
    rendererStoreSource.includes('requireMcpProbeResults(await window.agentDesk.probeMcpServers') &&
    rendererStoreSource.includes('get().refreshTaskSnapshots') &&
    settingsModalSource.includes('requireMcpProbeResults(await window.agentDesk.probeMcpServers') &&
    settingsModalSource.includes('useStore.getState().refreshTaskSnapshots()'),
  'unknown MCP probe outcomes must refresh both visible recovery surfaces'
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
  ipcSource.includes('return sessionManager.createManaged({ ...opts, cwd })') &&
    ipcSource.includes('return sessionManager.createManaged(opts)') &&
    unassignedSessionSource.includes('return sessionManager.createManaged({ ...options, cwd, isolated: false, unassigned: true })') &&
    ideBridgeManagerSource.includes('sessionManager.createManaged(options)') &&
    ideBridgeSource.includes('const meta = await this.sessionPort.createSession(options)') &&
    routineExecutorSource.includes('await sessionManager.createManaged(') &&
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
    taskRunSource.includes("'plugin_install'") &&
    taskRunSource.includes("'plugin_uninstall'") &&
    taskRunSource.includes("'terminal_action'") &&
    taskRunSource.includes("'browser_navigation'") &&
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
  const handler = ipcSources.map((source) => handlerSource(source, channel)).find(Boolean)
  assert(handler, `${channel} handler missing`)
  assert(
    handler.includes('executeInteractiveOperationEffect'),
    `${channel} must cross a durable effect barrier before its external mutation`
  )
}

function assertHandlerUsesBoundary(channel, boundary) {
  const handler = ipcSources.map((source) => handlerSource(source, channel)).find(Boolean)
  assert(handler, `${channel} handler missing`)
  assert(handler.includes(boundary), `${channel} must cross ${boundary}`)
}

function handlerSource(source, channel) {
  const channelPosition = source.indexOf(`'${channel}'`)
  const start = channelPosition >= 0 ? source.lastIndexOf('ipcMain.handle(', channelPosition) : -1
  if (start < 0 || channelPosition <= start) return ''
  const next = source.indexOf('\n  ipcMain.handle(', start + 1)
  return source.slice(start, next >= 0 ? next : undefined)
}

function assertManagedSessionCreateBarrier() {
  const start = sessionManagerSource.indexOf('async createManaged(')
  const end = sessionManagerSource.indexOf('\n  private sessionCreationDraft(', start)
  assert(start >= 0 && end > start, 'SessionManager.createManaged implementation missing')
  const method = sessionManagerSource.slice(start, end)
  const journal = method.indexOf('savePendingSessionCreation(draft)')
  const placement = method.indexOf('placement = await managedSessionPlacement(draft)')
  const activation = method.indexOf('await this.activateManagedSessionCreation(draft, placement, lifecycle)')
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
