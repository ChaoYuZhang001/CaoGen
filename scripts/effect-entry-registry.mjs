function entries(ids, contract) {
  return ids.map((id) => ({ id, ...contract }))
}

function tools(names) {
  return names.map((name) => `tool:${name}`)
}

function ipc(channels) {
  return channels.map((channel) => `ipc:${channel}`)
}

function actions(channel, names) {
  return names.map((name) => `ipc-action:${channel}#${name}`)
}

function contract(access, effectPolicy, replayPolicy, owner, rationale, extra = {}) {
  return { access, effectPolicy, replayPolicy, owner, rationale, ...extra }
}

const readOnlyTool = contract(
  'read_only', 'none', 'not_applicable',
  'src/main/task/tool-idempotency.ts',
  'The runtime permission contract classifies this tool as observation-only.'
)
const readOnlyIpc = contract(
  'read_only', 'none', 'not_applicable',
  'src/main/ipc.ts and registered IPC modules',
  'The handler returns inspection data without committing a domain or external mutation.'
)
const opaqueTool = contract(
  'mutation', 'opaque', 'manual_only',
  'src/main/task/effect-target-builder.ts',
  'The tool can mutate state but has no universal read-only query contract, so uncertain recovery stops.'
)
const opaqueIpc = contract(
  'mutation', 'opaque', 'manual_only',
  'registered IPC handler owner',
  'The IPC can cross a process or external boundary and has no safe automatic replay contract.'
)
const durableTool = contract(
  'mutation', 'durable_local', 'idempotent_resume',
  'src/main/project-workspace/store.ts',
  'The local domain store owns deterministic identity, atomic persistence, and idempotent recovery.'
)
const durableIpc = contract(
  'mutation', 'durable_local', 'idempotent_resume',
  'registered durable domain store owner',
  'The local owner provides revision checks, atomic persistence, and deterministic recovery.'
)
const ephemeralIpc = contract(
  'mutation', 'none', 'not_applicable',
  'registered window or process lifecycle owner',
  'The mutation is process-local presentation state and is never replayed after restart.',
  { boundary: 'ephemeral_local' }
)
const blockedIpc = contract(
  'mutation', 'none', 'not_applicable',
  'src/main/ipc/workflow-ledger-handlers.ts',
  'The compatibility channel authenticates the caller and rejects before executing a write.',
  { boundary: 'blocked_before_execution' }
)
const queryable = (effectTargets, owner) => contract(
  'mutation', 'queryable', 'reconcile_before_retry', owner,
  'A frozen EffectTarget has a read-only Reconciler; any retry remains explicitly authorized.',
  { effectTargets }
)

const readOnlyToolNames = [
  'browser_automation_status', 'browser_screenshot', 'browser_wait_for', 'china_notify',
  'draft_skill', 'find_file', 'genesis_orchestrate', 'get_dependencies', 'git_diff',
  'git_status', 'gitee_prepare', 'gui_list_windows', 'gui_screenshot', 'list_dir',
  'list_skills', 'load_skill', 'memory_search', 'read_file', 'route_model', 'run_skill',
  'search_code', 'search_symbol', 'task_decompose', 'view'
]

const opaqueToolNames = [
  'bash', 'browser_click', 'browser_evaluate', 'browser_navigate', 'browser_type',
  'gui_activate_window', 'gui_click', 'gui_hotkey', 'gui_scroll', 'gui_type',
  'mcp_builtin_servers', 'mcp_call_tool', 'mcp_discover', 'mcp_import_claude_desktop',
  'memory_add', 'optimize_skill', 'send_notification'
]

const durableToolNames = [
  'task_decompose_and_dispatch_dag', 'task_dispatch_dag', 'work_item_comment'
]

const readOnlyIpcChannels = [
  'attachments:ocr', 'browser:listAnnotations', 'browser:observe', 'dialog:pickDirectory',
  'engines:list', 'files:list', 'files:read', 'git:status', 'history:list', 'learning:list',
  'memory:layeredExport', 'memory:layeredList', 'memory:layeredSearch', 'memory:read',
  'migration:scan', 'modelAttempts:listReconciliations', 'notificationConnectors:list',
  'plugins:reveal', 'plugins:scan', 'preview:listAnnotations', 'projectContext:read',
  'projectContext:template', 'projects:list', 'providers:fetchModels', 'providers:health',
  'providers:list', 'quickbar:getState', 'quickbar:getWindowContext', 'quickbar:pickFiles',
  'quickbar:readClipboard', 'routines:list', 'routines:listRuns', 'routines:listTemplates',
  'sessions:list', 'sessions:outboundContextPreview', 'sessions:pendingPermissions',
  'sessions:suggestFiles', 'sessions:transcript', 'settings:get', 'startSuggestions:get',
  'taskSnapshots:list', 'terminals:list', 'transcripts:search', 'workflowLedger:diagnose',
  'workflowLedger:export', 'workflowLedger:list', 'workflowLedger:listArtifactEdges',
  'workflowLedger:listArtifactLocations', 'workflowLedger:listEvidence',
  'workflowLedger:queryArtifactGraph', 'workflowLedger:queryEvidence',
  'workflowLedger:repairPlan', 'workflowLedger:verify',
  'workflowLedger:verifyArtifactGraph', 'workflowLedger:verifyEvidence', 'workspace:diff',
  'worktrees:applyCheck', 'worktrees:conflictFiles', 'worktrees:mergeInspect',
  'worktrees:mergeReceipts', 'worktrees:summary'
]

const durableIpcChannels = [
  'appFeatures:invoke', 'attachments:copyImage', 'attachments:saveImageBytes',
  'browser:captureAnnotation', 'browser:captureElementAnnotation', 'digitalWorker:invoke',
  'history:delete', 'history:rename', 'history:setArchived', 'history:setPinned',
  'learning:approve', 'learning:delete', 'learning:reject', 'learning:revoke',
  'learning:rollback', 'memory:accept', 'memory:delete', 'memory:layeredArchive',
  'memory:layeredDelete', 'memory:layeredUpdate', 'memory:propose', 'migration:apply',
  'migration:rollback', 'modelAttempts:resolveReconciliation',
  'notificationConnectors:create', 'notificationConnectors:delete',
  'notificationConnectors:setDefault', 'preview:prepare', 'preview:prepareVisual',
  'preview:saveAnnotation', 'projectContext:write', 'projects:delete', 'projects:update',
  'projectWorkspace:invoke', 'providers:activateLocalCompute', 'providers:create',
  'providers:delete', 'providers:update', 'routines:create', 'routines:delete',
  'routines:markRun', 'routines:reviewRun', 'routines:update', 'sessions:close',
  'sessions:create', 'sessions:rename', 'sessions:setModel', 'sessions:setPermissionMode',
  'settings:update', 'supervisor:invoke', 'taskSnapshots:delete', 'taskSnapshots:recover',
  'taskSnapshots:resolveDagFinalization', 'taskSnapshots:resolveEffect',
  'workflowLedger:createArtifact', 'workflowLedger:createArtifactEdge',
  'workflowLedger:createArtifactLocation', 'workflowLedger:createEvidence',
  'workflowLedger:createEvidenceLink', 'workflowLedger:reviewAcceptance',
  'workflowLedger:saveAcceptance',
  'worktrees:exportPatch', 'worktrees:mergePatch'
]

const opaqueIpcChannels = [
  'browser:back', 'browser:close', 'browser:forward', 'browser:navigate', 'browser:open',
  'browser:pickElement', 'browser:reload', 'migration:import', 'plugins:installLocal', 'plugins:probeMcp',
  'plugins:setEnabled', 'plugins:uninstall', 'quickbar:captureScreenshot',
  'quickbar:prepareFiles', 'routines:runNow', 'sessions:decomposeTask',
  'sessions:dispatchSubagents', 'sessions:dispatchTaskDag', 'sessions:interrupt',
  'sessions:permission', 'sessions:restoreCheckpoint', 'sessions:rewindFiles',
  'sessions:send', 'terminals:close', 'terminals:start', 'terminals:write'
]

const ephemeralIpcChannels = ['browser:bounds', 'quickbar:setVisible', 'terminals:resize']
const blockedIpcChannels = [
  'workflowLedger:createGoal', 'workflowLedger:createWorkItem', 'workflowLedger:transitionWorkItem'
]

const readOnlyDigitalWorkerActions = [
  'getDigitalWorker', 'getDigitalWorkerAssignment', 'getDigitalWorkerAssignmentOwnerJournal',
  'getDigitalWorkerLease', 'getDigitalWorkerRoleTemplate', 'getDigitalWorkerStoreSnapshot',
  'listDigitalWorkerAssignmentHistory', 'listDigitalWorkerAssignmentOwnerAudit',
  'listDigitalWorkerAssignments', 'listDigitalWorkerAuditEvents', 'listDigitalWorkerLeases',
  'listDigitalWorkerRoleTemplates', 'listDigitalWorkers', 'verifyDigitalWorkerStore'
]
const durableDigitalWorkerActions = [
  'acquireDigitalWorkerLease', 'activateDigitalWorker', 'coordinateDigitalWorkerAssignmentOwner',
  'createDigitalWorker', 'createDigitalWorkerAssignment', 'createDigitalWorkerRoleTemplate',
  'deleteDigitalWorker', 'deleteDigitalWorkerRoleTemplate', 'heartbeatDigitalWorkerLease',
  'pauseDigitalWorker', 'reassignDigitalWorkerAssignment', 'recoverDigitalWorkerAssignmentOwners',
  'releaseDigitalWorkerAssignment', 'releaseDigitalWorkerLease', 'resumeDigitalWorker',
  'retireDigitalWorker', 'updateDigitalWorker', 'updateDigitalWorkerRoleTemplate'
]

const readOnlyProjectWorkspaceActions = [
  'comments:list', 'comments:listProject', 'get', 'goals:get', 'goals:list', 'list',
  'squads:get', 'squads:list', 'workItems:get', 'workItems:list'
]
const durableProjectWorkspaceActions = [
  'archive', 'comments:create', 'comments:delete', 'comments:update', 'create', 'delete',
  'export', 'export:data', 'goals:acceptance', 'goals:archive', 'goals:create',
  'goals:restore', 'goals:transition', 'goals:update', 'goalTask:create', 'import:data',
  'purge', 'restore', 'squads:archive', 'squads:create', 'squads:members:add',
  'squads:members:remove', 'squads:restore', 'squads:update', 'update',
  'workItems:acceptance', 'workItems:create', 'workItems:lease:acquire',
  'workItems:lease:release', 'workItems:lease:renew', 'workItems:reorder',
  'workItems:transfer', 'workItems:transition', 'workItems:update'
]

const readOnlySupervisorActions = ['events', 'get', 'list']
const durableSupervisorActions = [
  'approval:request', 'approval:resolve', 'block', 'cancel', 'complete', 'create', 'fail',
  'lease:acquire', 'lease:heartbeat', 'lease:reassign', 'lease:release', 'pause',
  'reconcile', 'recover', 'resume', 'retry', 'start'
]

const readOnlyAppFeatureActions = [
  'provider-profile/backups', 'provider-profile/preview', 'studio-result/export',
  'studio-result/audit', 'studio-result/get', 'task-plan/get'
]
const durableAppFeatureActions = [
  'provider-profile/apply', 'provider-profile/export', 'provider-profile/rollback',
  'studio-result/save', 'task-plan/approve', 'task-plan/create-version',
  'task-plan/revoke', 'task-plan/strategy'
]

export const EFFECT_ENTRY_REGISTRY = [
  ...entries(tools(readOnlyToolNames), readOnlyTool),
  ...entries(tools(opaqueToolNames), opaqueTool),
  ...entries(tools(durableToolNames), durableTool),
  ...entries(tools(['write_file', 'search_replace', 'edit_file']),
    queryable(['file_content'], 'src/main/task/effect-target-builder.ts')),
  ...entries(tools(['create_document', 'create_pdf', 'create_presentation', 'create_spreadsheet']),
    queryable(['office_artifact'], 'src/main/agent/tools/office-artifact.ts')),
  ...entries(tools(['git_stage', 'git_stage_all']),
    queryable(['git_index_update'], 'src/main/git/git-index-effect.ts')),
  ...entries(tools(['git_commit']), queryable(['git_commit'], 'src/main/task/effect-reconciler.ts')),
  ...entries(tools(['git_merge']), queryable(['git_merge'], 'src/main/task/effect-reconciler.ts')),
  ...entries(tools(['git_push']), queryable(['git_push'], 'src/main/task/effect-reconciler.ts')),
  ...entries(tools(['git_create_pr']),
    queryable(['pull_request_create'], 'src/main/git/pull-request-effect.ts')),
  ...entries(tools(['git_create_issue']),
    queryable(['issue_create'], 'src/main/git/pull-request-effect.ts')),
  ...entries(tools(['code_forge_delivery']),
    queryable(['code_forge_patch'], 'src/main/code-forge/patch-effect.ts')),

  ...entries(ipc(readOnlyIpcChannels), readOnlyIpc),
  ...entries(ipc(durableIpcChannels), durableIpc),
  ...entries(ipc(opaqueIpcChannels), opaqueIpc),
  ...entries(ipc(ephemeralIpcChannels), ephemeralIpc),
  ...entries(ipc(blockedIpcChannels), blockedIpc),
  ...entries(ipc(['files:write']), queryable(['file_content'], 'src/main/ipc/renderer-mutation-handlers.ts')),
  ...entries(ipc(['git:commit']), queryable(['git_commit'], 'src/main/ipc/renderer-mutation-handlers.ts')),
  ...entries(ipc(['git:stage', 'git:stageAll', 'git:unstage', 'workspace:applyHunk']),
    queryable(['git_index_update'], 'src/main/ipc/renderer-mutation-handlers.ts')),
  ...entries(ipc(['workspace:discardHunk']),
    queryable(['file_content'], 'src/main/ipc/renderer-mutation-handlers.ts')),
  ...entries(ipc(['worktrees:applyPatch']),
    queryable(['worktree_patch_apply'], 'src/main/ipc/worktree-operation-handlers.ts')),
  ...entries(ipc(['worktrees:createPr']),
    queryable(['pull_request_create'], 'src/main/ipc/worktree-operation-handlers.ts')),
  ...entries(ipc(['worktrees:remove']),
    queryable(['git_worktree_remove'], 'src/main/ipc/worktree-operation-handlers.ts')),

  ...entries(actions('digitalWorker:invoke', readOnlyDigitalWorkerActions), readOnlyIpc),
  ...entries(actions('digitalWorker:invoke', durableDigitalWorkerActions), durableIpc),
  ...entries(actions('projectWorkspace:invoke', readOnlyProjectWorkspaceActions), readOnlyIpc),
  ...entries(actions('projectWorkspace:invoke', durableProjectWorkspaceActions), durableIpc),
  ...entries(actions('supervisor:invoke', readOnlySupervisorActions), readOnlyIpc),
  ...entries(actions('supervisor:invoke', durableSupervisorActions), durableIpc),
  ...entries(actions('appFeatures:invoke', readOnlyAppFeatureActions), readOnlyIpc),
  ...entries(actions('appFeatures:invoke', durableAppFeatureActions), durableIpc),

  ...entries(['external:connector:pull-request-create'],
    queryable(['pull_request_create'], 'src/main/git/pull-request-effect.ts')),
  ...entries(['external:connector:issue-create'],
    queryable(['issue_create'], 'src/main/git/pull-request-effect.ts')),
  ...entries([
    'external:connector:mcp-tool-call', 'external:connector:notification-send',
    'external:provider:anthropic-model-request', 'external:provider:openai-model-request'
  ], opaqueIpc)
]
