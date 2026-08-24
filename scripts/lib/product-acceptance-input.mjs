import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  PRODUCT_1_0_CRITICAL_RECOVERY_REQUIREMENT_IDS,
  PRODUCT_1_0_EXPECTED_COUNTS
} from './product-acceptance-map.mjs'

const CONTRACT_RELATIVE_PATH = 'scripts/contracts/product-1.0-acceptance-contract.json'
const REQUIRED_PACKAGE_SCRIPTS = [
  'test:1.0-acceptance-map',
  'test:1.0-acceptance-map:smoke',
  'test:1.0-acceptance-map:required',
  'test:product-1.0-acceptance',
  'test:product-1.0-acceptance:required',
  'test:critical-recovery-matrix:required'
]
const PUBLIC_GATE_BINDINGS = [
  { requirementId: 'WORK-002', script: 'test:workitem-board:required' }
]
const ADDITIONAL_RELEASE_SCOPE_IDS = [
  'SEARCH-001',
  'VID-MVP-001',
  'CRITICAL-RECOVERY-11',
  'CONTROL-ROOM-009'
]
const SEARCH_SCOPE_MODES = ['model_native', 'byok_search_adapter']
const SEARCH_SCOPE_GATES = [
  'assistant_first_task_without_project',
  'search_broker_success_citation',
  'search_broker_explicit_failure_states',
  'search_broker_restart_duplicate_recovery',
  'search_broker_artifact_evidence_binding'
]
const SEARCH_SCOPE_FAILURE_STATES = [
  'no_results',
  'timeout',
  'no_credentials',
  'egress_denied',
  'provider_failure',
  'unknown_result'
]
const SEARCH_SCOPE_EVIDENCE_FIELDS = [
  'url',
  'fetchedAt',
  'summary',
  'contentSha256',
  'citation',
  'projectId',
  'runId',
  'evidenceId'
]
const VIDEO_SCOPE_PIPELINE = [
  'script_or_outline',
  'editable_storyboard',
  'material_import_and_version',
  'decodable_non_empty_preview',
  'revision_and_reorder',
  'traceable_export'
]
const VIDEO_SCOPE_GATES = [
  'video_script_storyboard_edit',
  'video_material_version_binding',
  'video_preview_decode_non_empty',
  'video_revision_restore',
  'video_export_artifact_evidence_acceptance',
  'video_failure_cancel_restart_unknown_result'
]
const VIDEO_SCOPE_EXCLUSIONS = [
  'remote_video_generation',
  'professional_timeline',
  'media_provider_billing_reconciliation'
]
const RECOVERY_SCOPE_FAILURE_CLASSES = [
  'strong_kill',
  'network_unknown_result',
  'duplicate_idempotency',
  'out_of_order'
]
const RECOVERY_SCOPE_CONTINUITY_FIELDS = [
  'identity',
  'revision',
  'ownership',
  'effect',
  'artifact_evidence_acceptance',
  'replay_resend_count',
  'final_digest'
]
const RECOVERY_SCOPE_GATES = [
  'same_clean_candidate_sha',
  'no_dirty_or_contract_only_evidence',
  'per_requirement_fault_matrix'
]
const CONTROL_ROOM_SCOPE_GATES = [
  'office_nine_workstation_capacity',
  'office_tenth_session_overflow_list',
  'office_active_session_prioritized',
  'office_source_entry_return',
  'office_equivalent_list_view'
]
const CONTROL_ROOM_SCOPE_SEMANTICS = {
  stationRepresents: 'digital_employee_or_active_work',
  roleColorRepresents: 'job_role',
  providerBadgeRepresents: 'current_compute_source'
}
const HUMAN_EXPERIENCE_MEASUREMENT_FIELDS = [
  'elapsedMs',
  'clicks',
  'keyboardInputs',
  'requiredFields',
  'modeSwitches',
  'confirmationDialogs',
  'recoveryActions',
  'helpRequests',
  'errors',
  'completion',
  'blindScores'
]
const HUMAN_EXPERIENCE_TASKS = [
  {
    id: 'UX-GOLDEN-001',
    surface: 'assistant',
    title: 'Assistant 首次有用任务',
    comparatorCount: 1,
    timeLimitMinutes: 10,
    requiredFlow: [
      'open_app',
      'enter_goal_without_project_or_internal_entity',
      'search_or_execute',
      'receive_verifiable_result',
      'make_one_revision_or_follow_up',
      'copy_or_export_result'
    ]
  },
  {
    id: 'UX-GOLDEN-002',
    surface: 'project',
    title: 'Project 从目标到交付闭环',
    comparatorCount: 3,
    timeLimitMinutes: 30,
    requiredFlow: [
      'enter_one_sentence_goal',
      'review_automatic_plan_and_route',
      'approve_once',
      'inspect_worktree_and_hunk_diff',
      'run_test',
      'undo_one_change',
      'commit_and_deliver',
      'restart_and_recover'
    ]
  },
  {
    id: 'UX-GOLDEN-003',
    surface: 'video',
    title: '视频基础 MVP 链',
    comparatorCount: 2,
    timeLimitMinutes: 30,
    requiredFlow: [
      'enter_script_or_outline',
      'edit_storyboard',
      'import_or_bind_material_version',
      'produce_decodable_non_empty_preview',
      'revise_or_reorder',
      'export_traceable_artifact'
    ]
  },
  {
    id: 'UX-GOLDEN-004',
    surface: 'provider_configuration',
    title: 'Provider 配置、切换与故障恢复',
    comparatorCount: 1,
    timeLimitMinutes: 15,
    requiredFlow: [
      'import_or_add_profile',
      'discover_models',
      'run_health_check',
      'switch_default',
      'simulate_provider_failure_and_failover',
      'export_or_rollback_profile',
      'restart_and_verify_credential_reference_only'
    ]
  },
  {
    id: 'UX-GOLDEN-005',
    surface: 'cross_entry',
    title: '跨入口状态连续与结果返回',
    comparatorCount: 4,
    timeLimitMinutes: 20,
    requiredFlow: [
      'start_from_assistant',
      'continue_in_project_or_video',
      'observe_control_room_projection_without_new_workflow',
      'return_to_source_entry',
      'locate_current_result_and_audit_timeline',
      'recover_after_restart'
    ]
  }
]

export function loadProductAcceptanceInput({ repoRoot, environment = process.env, required = false }) {
  const contractPath = path.join(repoRoot, CONTRACT_RELATIVE_PATH)
  const contractResult = readContract(contractPath)
  const contract = contractResult.contract
  const contractFailures = [
    ...(contractResult.error ? [contractResult.error] : []),
    ...validateProductAcceptanceContract(contract)
  ]
  const requirements = resolvePrivateInput({
    repoRoot,
    environment,
    envName: contract?.privateInput?.requirementsEnv,
    defaultPath: contract?.privateInput?.defaultRequirementsPath
  })
  const matrix = resolvePrivateInput({
    repoRoot,
    environment,
    envName: contract?.privateInput?.matrixEnv,
    defaultPath: contract?.privateInput?.defaultMatrixPath
  })
  const privateInputsComplete = Boolean(requirements.markdown && matrix.markdown)
  const inputResolutionFailures = [
    ...(requirements.error ? [requirements.error] : []),
    ...(matrix.error ? [matrix.error] : []),
    ...((requirements.markdown && !matrix.markdown) || (!requirements.markdown && matrix.markdown)
      ? ['private acceptance input is incomplete; requirements and matrix must be provided together']
      : [])
  ]
  const closureInputFailures = [
    ...(required && !privateInputsComplete
      ? ['required acceptance closure needs both private requirements and matrix inputs']
      : [])
  ]
  const privateInputFailures = [...inputResolutionFailures, ...closureInputFailures]

  return {
    contract,
    contractPath: CONTRACT_RELATIVE_PATH,
    contractFailures,
    mode: privateInputsComplete ? 'private_ledger' : 'public_contract',
    privateInputsComplete,
    inputResolutionFailures,
    closureInputFailures,
    privateInputFailures,
    requirements,
    matrix
  }
}

export function validateProductAcceptanceContract(contract) {
  return [
    ...validateContractIdentity(contract),
    ...validateAdditionalReleaseBlockingScope(contract),
    ...validateHumanExperienceAcceptance(contract),
    ...validateContractTables(contract),
    ...validateClosurePolicy(contract),
    ...validatePrivateInputContract(contract)
  ]
}

function validateHumanExperienceAcceptance(contract) {
  const scope = contract?.humanExperienceAcceptance
  if (scope?.schemaVersion !== 1 || scope?.required !== true) {
    return ['human experience acceptance must be schemaVersion 1 and required']
  }
  return [
    ...validateHumanExperienceMetadata(scope),
    ...validateHumanExperienceTasks(scope)
  ]
}

function validateHumanExperienceMetadata(scope) {
  return [
    ...(scope.source === 'user-feedback-2026-08-24' ? [] : ['human experience acceptance source is invalid']),
    ...(scope.participantCount === 5 ? [] : ['human experience acceptance must require five participants']),
    ...(scope.runPolicy === 'each_participant_runs_all_tasks_without_product_instruction'
      ? []
      : ['human experience acceptance run policy is invalid']),
    ...(scope.comparisonRule === 'same_goal_same_dataset_same_machine_and_fixed_comparator_version; CaoGen_required_steps_must_not_exceed_the_best_comparator'
      ? []
      : ['human experience acceptance comparison rule is invalid']),
    ...(sameStrings(scope.measurementFields, HUMAN_EXPERIENCE_MEASUREMENT_FIELDS)
      ? []
      : ['human experience acceptance measurement fields are invalid'])
  ]
}

function validateHumanExperienceTasks(scope) {
  if (!Array.isArray(scope.tasks) || scope.tasks.length !== HUMAN_EXPERIENCE_TASKS.length) {
    return ['human experience acceptance must contain five golden tasks']
  }
  const failures = scope.tasks.flatMap((actual, index) => validateHumanExperienceTask(actual, HUMAN_EXPERIENCE_TASKS[index]))
  const video = scope.tasks[2]
  if (video?.qualityBoundary !== '1.0 verifies honest local usability and traceability; it does not claim remote generation quality parity') {
    failures.push('UX-GOLDEN-003 quality boundary is invalid')
  }
  return failures
}

function validateHumanExperienceTask(actual, expected) {
  return [
    ...(actual?.id === expected.id && actual?.surface === expected.surface && actual?.title === expected.title
      ? []
      : [`${expected.id} identity is invalid`]),
    ...(Array.isArray(actual?.comparators) && actual.comparators.length === expected.comparatorCount && actual.comparators.every(isString)
      ? []
      : [`${expected.id} comparators are invalid`]),
    ...(actual?.timeLimitMinutes === expected.timeLimitMinutes ? [] : [`${expected.id} time limit is invalid`]),
    ...(sameStrings(actual?.requiredFlow, expected.requiredFlow) ? [] : [`${expected.id} required flow is invalid`])
  ]
}

function validateAdditionalReleaseBlockingScope(contract) {
  const failures = []
  const scope = contract?.additionalReleaseBlockingScope
  if (scope?.schemaVersion !== 1 || scope?.required !== true) {
    failures.push('additional release blocking scope must be schemaVersion 1 and required')
    return failures
  }
  if (!Array.isArray(scope.items) || scope.items.length !== ADDITIONAL_RELEASE_SCOPE_IDS.length) {
    failures.push('additional release blocking scope must contain SEARCH-001, VID-MVP-001, CRITICAL-RECOVERY-11, and CONTROL-ROOM-009')
    return failures
  }
  if (!sameStrings(scope.items.map((item) => item?.id), ADDITIONAL_RELEASE_SCOPE_IDS)) {
    failures.push('additional release blocking scope IDs are invalid')
  }
  const search = scope.items[0]
  if (!sameStrings(search?.searchModes, SEARCH_SCOPE_MODES)) failures.push('SEARCH-001 search modes are invalid')
  if (!sameStrings(search?.requiredGates, SEARCH_SCOPE_GATES)) failures.push('SEARCH-001 required gates are invalid')
  if (!sameStrings(search?.failureStates, SEARCH_SCOPE_FAILURE_STATES)) failures.push('SEARCH-001 failure states are invalid')
  if (!sameStrings(search?.evidenceFields, SEARCH_SCOPE_EVIDENCE_FIELDS)) failures.push('SEARCH-001 evidence fields are invalid')
  const video = scope.items[1]
  if (!sameStrings(video?.pipeline, VIDEO_SCOPE_PIPELINE)) failures.push('VID-MVP-001 pipeline is invalid')
  if (!sameStrings(video?.requiredGates, VIDEO_SCOPE_GATES)) failures.push('VID-MVP-001 required gates are invalid')
  if (!sameStrings(video?.excludedFrom1_0P0, VIDEO_SCOPE_EXCLUSIONS)) failures.push('VID-MVP-001 exclusions are invalid')
  const recovery = scope.items[2]
  if (recovery?.itemCount !== PRODUCT_1_0_CRITICAL_RECOVERY_REQUIREMENT_IDS.length) {
    failures.push('CRITICAL-RECOVERY-11 itemCount must equal the fixed critical recovery list')
  }
  if (!sameStrings(recovery?.requirementIds, PRODUCT_1_0_CRITICAL_RECOVERY_REQUIREMENT_IDS)) {
    failures.push('CRITICAL-RECOVERY-11 requirement IDs must equal the fixed critical recovery list')
  }
  if (!sameStrings(recovery?.failureClasses, RECOVERY_SCOPE_FAILURE_CLASSES)) failures.push('CRITICAL-RECOVERY-11 failure classes are invalid')
  if (!sameStrings(recovery?.continuityFields, RECOVERY_SCOPE_CONTINUITY_FIELDS)) failures.push('CRITICAL-RECOVERY-11 continuity fields are invalid')
  if (!sameStrings(recovery?.requiredGates, RECOVERY_SCOPE_GATES)) failures.push('CRITICAL-RECOVERY-11 required gates are invalid')
  failures.push(...validateControlRoomScope(scope.items[3]))
  return failures
}

function validateControlRoomScope(controlRoom) {
  const failures = []
  if (controlRoom?.maxExpensiveWorkstations !== 9 || controlRoom?.overflowStartsAt !== 10) {
    failures.push('CONTROL-ROOM-009 must cap expensive workstations at 9 and start overflow at 10')
  }
  if (controlRoom?.overflowProjection !== 'equivalent_list_view') {
    failures.push('CONTROL-ROOM-009 overflow projection is invalid')
  }
  if (!sameStrings(controlRoom?.requiredGates, CONTROL_ROOM_SCOPE_GATES)) {
    failures.push('CONTROL-ROOM-009 required gates are invalid')
  }
  for (const [key, expected] of Object.entries(CONTROL_ROOM_SCOPE_SEMANTICS)) {
    if (controlRoom?.semantics?.[key] !== expected) failures.push(`CONTROL-ROOM-009 ${key} semantic is invalid`)
  }
  return failures
}

function validateContractIdentity(contract) {
  const failures = []
  if (contract?.schemaVersion !== 1) failures.push('acceptance contract schemaVersion must be 1')
  if (contract?.contractId !== 'caogen-product-1.0-acceptance') {
    failures.push('acceptance contractId must be caogen-product-1.0-acceptance')
  }
  if (
    contract?.inventory?.P0 !== PRODUCT_1_0_EXPECTED_COUNTS.P0 ||
    contract?.inventory?.P1 !== PRODUCT_1_0_EXPECTED_COUNTS.P1
  ) {
    failures.push('acceptance inventory must remain P0=64 and P1=38')
  }
  return failures
}

function validateContractTables(contract) {
  const failures = []
  if (!sameStrings(contract?.requirementsTable?.columns, ['id', 'priority', 'status', 'requirement'])) {
    failures.push('requirements table columns are invalid')
  }
  if (contract?.requirementsTable?.idPattern !== '^[A-Z][A-Z0-9-]+-\\d+$') {
    failures.push('requirements table ID pattern is invalid')
  }
  if (!sameStrings(contract?.requirementsTable?.priorities, ['P0', 'P1'])) {
    failures.push('requirements table priorities must remain P0 and P1')
  }
  if (!sameNumbers(contract?.matrixTable?.allowedColumnCounts, [7, 8])) {
    failures.push('matrix table must allow the 7-column legacy and 8-column selection forms')
  }
  if (!sameStrings(contract?.matrixTable?.columns, [
    'id', 'selection', 'status', 'evidence', 'owner', 'gateClass', 'gate', 'dependencies'
  ])) {
    failures.push('matrix table columns are invalid')
  }
  return failures
}

function validateClosurePolicy(contract) {
  const failures = []
  if (!sameStrings(contract?.closurePolicy?.requiredPrivateInputs, ['requirements', 'matrix'])) {
    failures.push('closure policy must require both private requirements and matrix inputs')
  }
  if (
    contract?.closurePolicy?.verifiedStatus !== '当前已验证' ||
    contract?.closurePolicy?.conditionalStatus !== '条件可用' ||
    contract?.closurePolicy?.openStatus !== '立项目标'
  ) {
    failures.push('closure policy statuses are invalid')
  }
  if (!sameStrings(contract?.closurePolicy?.requiredPackageScripts, REQUIRED_PACKAGE_SCRIPTS)) {
    failures.push('closure policy required package scripts are invalid')
  }
  if (!sameGateBindings(contract?.closurePolicy?.publicGateBindings, PUBLIC_GATE_BINDINGS)) {
    failures.push('closure policy public gate bindings are invalid')
  }
  const recoveryIds = contract?.closurePolicy?.criticalRecoveryRequirementIds
  if (!sameStrings(recoveryIds, PRODUCT_1_0_CRITICAL_RECOVERY_REQUIREMENT_IDS)) {
    failures.push('closure policy critical recovery requirement IDs are invalid')
  }
  const faultMatrix = contract?.closurePolicy?.criticalRecoveryFaultMatrix
  if (
    faultMatrix?.path !== 'scripts/contracts/critical-recovery-fault-matrix.json' ||
    faultMatrix?.gate !== 'test:critical-recovery-matrix:required' ||
    faultMatrix?.faultCellCount !== 44
  ) {
    failures.push('closure policy critical recovery fault matrix binding is invalid')
  }
  return failures
}

function validatePrivateInputContract(contract) {
  const failures = []
  const privateInput = contract?.privateInput
  if (privateInput?.requirementsEnv !== 'CAOGEN_PRODUCT_REQUIREMENTS_PATH') {
    failures.push('privateInput.requirementsEnv is invalid')
  }
  if (privateInput?.matrixEnv !== 'CAOGEN_ACCEPTANCE_MATRIX_PATH') {
    failures.push('privateInput.matrixEnv is invalid')
  }
  if (privateInput?.defaultRequirementsPath !== 'docs/PRODUCT-REQUIREMENTS.md') {
    failures.push('privateInput.defaultRequirementsPath is invalid')
  }
  if (privateInput?.defaultMatrixPath !== 'docs/1.0-ACCEPTANCE-MATRIX.md') {
    failures.push('privateInput.defaultMatrixPath is invalid')
  }
  return failures
}

export function checkAcceptanceContractScripts(contract, packageScripts) {
  const requiredScripts = Array.isArray(contract?.closurePolicy?.requiredPackageScripts)
    ? contract.closurePolicy.requiredPackageScripts
    : []
  const publicGateBindings = Array.isArray(contract?.closurePolicy?.publicGateBindings)
    ? contract.closurePolicy.publicGateBindings
    : []
  const declared = [
    ...requiredScripts,
    ...publicGateBindings.map((binding) => binding?.script).filter(isString)
  ]
  return declared
    .filter((script) => packageScripts?.[script] === undefined)
    .map((script) => `acceptance contract package script is missing: ${script}`)
}

export function hasPublicAcceptanceGate(contract, requirementId, script) {
  const bindings = Array.isArray(contract?.closurePolicy?.publicGateBindings)
    ? contract.closurePolicy.publicGateBindings
    : []
  return bindings.some((binding) =>
    binding?.requirementId === requirementId && binding?.script === script
  )
}

function resolvePrivateInput({ repoRoot, environment, envName, defaultPath }) {
  const explicit = isString(envName) ? environment[envName]?.trim() : ''
  if (!explicit && !isString(defaultPath)) {
    return {
      path: null,
      explicit: false,
      markdown: '',
      error: `${isString(envName) ? envName : 'private acceptance input'} path is not configured`
    }
  }
  const relativeOrAbsolute = explicit || defaultPath
  const resolvedPath = path.isAbsolute(relativeOrAbsolute)
    ? path.resolve(relativeOrAbsolute)
    : path.resolve(repoRoot, relativeOrAbsolute)
  const displayPath = explicit ? `<private:${envName}>` : relativeOrAbsolute
  if (!existsSync(resolvedPath)) {
    return {
      path: displayPath,
      explicit: Boolean(explicit),
      markdown: '',
      ...(explicit ? { error: `${envName} does not reference an existing file` } : {})
    }
  }
  return {
    path: displayPath,
    explicit: Boolean(explicit),
    ...readPrivateMarkdown(resolvedPath, envName)
  }
}

function readContract(filePath) {
  try {
    return {
      contract: JSON.parse(readFileSync(filePath, 'utf8')),
      error: null
    }
  } catch {
    return {
      contract: {},
      error: `acceptance contract could not be read: ${CONTRACT_RELATIVE_PATH}`
    }
  }
}

function readPrivateMarkdown(filePath, envName) {
  try {
    return { markdown: readFileSync(filePath, 'utf8') }
  } catch {
    return {
      markdown: '',
      error: `${isString(envName) ? envName : 'private acceptance input'} could not be read`
    }
  }
}

function sameStrings(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index])
}

function sameNumbers(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index])
}

function sameGateBindings(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) =>
    item?.requirementId === expected[index].requirementId && item?.script === expected[index].script
  )
}

function isString(value) {
  return typeof value === 'string' && value.trim().length > 0
}
