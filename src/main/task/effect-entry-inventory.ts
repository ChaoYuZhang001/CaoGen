export type EffectEntryImpact = 'read_only' | 'local' | 'external'
export type EffectEntryPolicyKind =
  | 'none'
  | 'queryable'
  | 'opaque'
  | 'conditional'
  | 'delegated'
  | 'direct_user'
export type EffectEntryReplayPolicy =
  | 'not_applicable'
  | 'reconcile_before_retry'
  | 'manual_reconciliation'
  | 'downstream_barrier'
  | 'never'

export interface EffectEntryPolicy {
  impact: EffectEntryImpact
  effect: EffectEntryPolicyKind
  replay: EffectEntryReplayPolicy
  evidence?: string
}

const READ_ONLY: EffectEntryPolicy = {
  impact: 'read_only', effect: 'none', replay: 'not_applicable'
}
const LOCAL: EffectEntryPolicy = {
  impact: 'local', effect: 'none', replay: 'not_applicable'
}
const QUERYABLE: EffectEntryPolicy = {
  impact: 'external', effect: 'queryable', replay: 'reconcile_before_retry'
}
const OPAQUE: EffectEntryPolicy = {
  impact: 'external', effect: 'opaque', replay: 'manual_reconciliation'
}
const CONDITIONAL: EffectEntryPolicy = {
  impact: 'external', effect: 'conditional', replay: 'reconcile_before_retry'
}
const DIRECT_USER: EffectEntryPolicy = {
  impact: 'external', effect: 'direct_user', replay: 'never'
}

export const EFFECT_ENTRY_INVENTORY_VERSION = 4

export const IPC_EFFECT_ENTRY_POLICIES = mergePolicyGroups(
  policyGroup([
    'attachments:ocr',
    'browser:listAnnotations', 'browser:observe', 'browser:pickElement',
    'engines:list',
    'files:list', 'files:read',
    'git:status',
    'history:list',
    'learning:list',
    'memory:layeredExport', 'memory:layeredList', 'memory:layeredSearch', 'memory:read',
    'migration:scan',
    'modelAttempts:listReconciliations',
    'plugins:scan',
    'preview:listAnnotations', 'preview:prepare', 'preview:prepareVisual',
    'projectContext:read', 'projectContext:template',
    'projects:list',
    'providers:fetchModels', 'providers:health', 'providers:list',
    'quickbar:getState', 'quickbar:getWindowContext', 'quickbar:readClipboard',
    'routines:list', 'routines:listRuns', 'routines:listTemplates',
    'sessions:decomposeTask', 'sessions:list', 'sessions:pendingPermissions',
    'sessions:suggestFiles', 'sessions:transcript',
    'settings:get',
    'startSuggestions:get',
    'taskSnapshots:list',
    'terminals:list',
    'transcripts:search',
    'workflowLedger:diagnose', 'workflowLedger:export', 'workflowLedger:list',
    'workflowLedger:listArtifactEdges', 'workflowLedger:listArtifactLocations',
    'workflowLedger:listEvidence', 'workflowLedger:queryArtifactGraph',
    'workflowLedger:queryEvidence', 'workflowLedger:repairPlan', 'workflowLedger:verify',
    'workflowLedger:verifyArtifactGraph', 'workflowLedger:verifyEvidence',
    'workspace:diff',
    'worktrees:applyCheck', 'worktrees:conflictFiles', 'worktrees:exportPatch',
    'worktrees:mergeInspect', 'worktrees:mergePatch', 'worktrees:mergeReceipts',
    'worktrees:summary'
  ], READ_ONLY),
  policyGroup([
    'browser:captureAnnotation', 'browser:captureElementAnnotation',
    'digitalWorker:invoke',
    'history:delete', 'history:rename', 'history:setArchived', 'history:setPinned',
    'learning:approve', 'learning:delete', 'learning:reject', 'learning:revoke', 'learning:rollback',
    'memory:accept', 'memory:delete', 'memory:layeredArchive', 'memory:layeredDelete',
    'memory:layeredUpdate', 'memory:propose',
    'modelAttempts:resolveReconciliation',
    'plugins:setEnabled',
    'preview:saveAnnotation',
    'projects:delete', 'projects:update',
    'projectWorkspace:invoke',
    'providers:create', 'providers:delete', 'providers:update',
    'quickbar:setVisible',
    'routines:create', 'routines:delete', 'routines:markRun', 'routines:update',
    'sessions:close', 'sessions:interrupt', 'sessions:permission', 'sessions:rename',
    'sessions:setModel', 'sessions:setPermissionMode',
    'settings:update',
    'supervisor:invoke',
    'taskSnapshots:delete', 'taskSnapshots:resolveDagFinalization', 'taskSnapshots:resolveEffect',
    'workflowLedger:createArtifact', 'workflowLedger:createArtifactEdge',
    'workflowLedger:createArtifactLocation', 'workflowLedger:createEvidence',
    'workflowLedger:createEvidenceLink', 'workflowLedger:createGoal',
    'workflowLedger:createWorkItem', 'workflowLedger:reviewAcceptance',
    'workflowLedger:saveAcceptance', 'workflowLedger:transitionWorkItem'
  ], LOCAL),
  policyGroup([
    'files:write',
    'git:commit', 'git:stage', 'git:stageAll', 'git:unstage',
    'projectContext:write',
    'workspace:applyHunk', 'workspace:discardHunk',
    'worktrees:applyPatch', 'worktrees:createPr', 'worktrees:remove'
  ], QUERYABLE),
  policyGroup([
    'attachments:copyImage', 'attachments:saveImageBytes',
    'plugins:probeMcp',
  ], OPAQUE),
  policyGroup([
    'browser:back', 'browser:bounds', 'browser:close', 'browser:forward',
    'browser:navigate', 'browser:open', 'browser:reload',
    'dialog:pickDirectory',
    'migration:import',
    'plugins:installLocal', 'plugins:reveal', 'plugins:uninstall',
    'quickbar:captureScreenshot', 'quickbar:pickFiles', 'quickbar:prepareFiles',
    'sessions:restoreCheckpoint', 'sessions:rewindFiles',
    'terminals:close', 'terminals:resize', 'terminals:start', 'terminals:write'
  ], DIRECT_USER),
  delegatedPolicyGroup({
    'routines:runNow': 'runRoutineNow',
    'sessions:create': 'sessionManager.create',
    'sessions:dispatchSubagents': 'sessionManager.dispatchSubagents',
    'sessions:dispatchTaskDag': 'sessionManager.dispatchTaskDag',
    'sessions:send': 'sessionManager.send',
    'taskSnapshots:recover': 'sessionManager.recoverTaskSnapshot'
  })
)

export const AGENT_TOOL_EFFECT_ENTRY_POLICIES = mergePolicyGroups(
  policyGroup([
    'browser_automation_status', 'browser_screenshot', 'browser_wait_for',
    'china_notify', 'draft_skill', 'find_file', 'genesis_orchestrate',
    'get_dependencies', 'git_diff', 'git_status', 'gitee_prepare',
    'gui_list_windows', 'gui_screenshot', 'list_dir', 'list_skills', 'load_skill',
    'memory_search', 'read_file', 'route_model', 'run_skill', 'search_code',
    'search_symbol', 'task_decompose', 'view'
  ], READ_ONLY),
  policyGroup([
    'edit_file', 'git_commit', 'git_create_pr', 'git_merge', 'git_push',
    'git_stage', 'git_stage_all', 'write_file'
  ], QUERYABLE),
  policyGroup(['code_forge_delivery', 'search_replace'], CONDITIONAL),
  policyGroup([
    'bash',
    'browser_click', 'browser_evaluate', 'browser_navigate', 'browser_type',
    'gui_activate_window', 'gui_click', 'gui_hotkey', 'gui_scroll', 'gui_type',
    'mcp_builtin_servers', 'mcp_call_tool', 'mcp_discover', 'mcp_import_claude_desktop',
    'memory_add', 'optimize_skill',
    'task_decompose_and_dispatch_dag', 'task_dispatch_dag'
  ], OPAQUE)
)

export const GATEWAY_ACTION_EFFECT_ENTRY_POLICIES = {
  'projectWorkspace:invoke': mergePolicyGroups(
    policyGroup([
      'get', 'goals:get', 'goals:list', 'list', 'workItems:get', 'workItems:list'
    ], READ_ONLY),
    policyGroup([
      'archive', 'create', 'delete', 'goals:acceptance', 'goals:archive', 'goals:create',
      'goals:restore', 'goals:transition', 'goals:update', 'purge', 'restore', 'update',
      'workItems:acceptance', 'workItems:create', 'workItems:lease:acquire',
      'workItems:lease:release', 'workItems:lease:renew', 'workItems:reorder',
      'workItems:transition', 'workItems:update'
    ], LOCAL),
    policyGroup(['export'], DIRECT_USER)
  ),
  'digitalWorker:invoke': mergePolicyGroups(
    policyGroup([
      'getDigitalWorker', 'getDigitalWorkerAssignment', 'getDigitalWorkerAssignmentOwnerJournal',
      'getDigitalWorkerLease', 'getDigitalWorkerRoleTemplate', 'getDigitalWorkerStoreSnapshot',
      'listDigitalWorkerAssignmentHistory', 'listDigitalWorkerAssignmentOwnerAudit',
      'listDigitalWorkerAssignments', 'listDigitalWorkerAuditEvents', 'listDigitalWorkerLeases',
      'listDigitalWorkerRoleTemplates', 'listDigitalWorkers', 'verifyDigitalWorkerStore'
    ], READ_ONLY),
    policyGroup([
      'acquireDigitalWorkerLease', 'activateDigitalWorker',
      'coordinateDigitalWorkerAssignmentOwner', 'createDigitalWorker',
      'createDigitalWorkerAssignment', 'createDigitalWorkerRoleTemplate',
      'deleteDigitalWorker', 'deleteDigitalWorkerRoleTemplate',
      'heartbeatDigitalWorkerLease', 'pauseDigitalWorker',
      'reassignDigitalWorkerAssignment', 'recoverDigitalWorkerAssignmentOwners',
      'releaseDigitalWorkerAssignment', 'releaseDigitalWorkerLease',
      'resumeDigitalWorker', 'retireDigitalWorker', 'updateDigitalWorker',
      'updateDigitalWorkerRoleTemplate'
    ], LOCAL)
  ),
  'supervisor:invoke': mergePolicyGroups(
    policyGroup(['events', 'get', 'list'], READ_ONLY),
    policyGroup([
      'approval:request', 'approval:resolve', 'block', 'cancel', 'complete', 'create',
      'fail', 'lease:acquire', 'lease:heartbeat', 'lease:reassign', 'lease:release',
      'pause', 'reconcile', 'recover', 'resume', 'retry', 'start'
    ], LOCAL)
  )
} as const

export const EFFECT_FREE_AGENT_TOOL_NAMES = Object.freeze(
  Object.entries(AGENT_TOOL_EFFECT_ENTRY_POLICIES)
    .filter(([, policy]) => policy.impact === 'read_only')
    .map(([name]) => name)
)

function policyGroup(ids: readonly string[], policy: EffectEntryPolicy): Record<string, EffectEntryPolicy> {
  return Object.fromEntries(ids.map((id) => [id, policy]))
}

function delegatedPolicyGroup(entries: Record<string, string>): Record<string, EffectEntryPolicy> {
  return Object.fromEntries(Object.entries(entries).map(([id, evidence]) => [id, {
    impact: 'external', effect: 'delegated', replay: 'downstream_barrier', evidence
  } satisfies EffectEntryPolicy]))
}

function mergePolicyGroups(...groups: Array<Record<string, EffectEntryPolicy>>): Record<string, EffectEntryPolicy> {
  const result: Record<string, EffectEntryPolicy> = {}
  for (const group of groups) {
    for (const [id, policy] of Object.entries(group)) {
      if (result[id]) throw new Error(`Effect entry policy declared twice: ${id}`)
      result[id] = Object.freeze({ ...policy })
    }
  }
  return Object.freeze(result)
}
