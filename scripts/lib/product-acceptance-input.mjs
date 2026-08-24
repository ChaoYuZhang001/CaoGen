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
  'test:product-1.0-acceptance:required'
]
const PUBLIC_GATE_BINDINGS = [
  { requirementId: 'WORK-002', script: 'test:workitem-board:required' }
]
const ADDITIONAL_RELEASE_SCOPE_IDS = ['SEARCH-001', 'VID-MVP-001', 'CRITICAL-RECOVERY-11']
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
    ...validateContractTables(contract),
    ...validateClosurePolicy(contract),
    ...validatePrivateInputContract(contract)
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
    failures.push('additional release blocking scope must contain SEARCH-001, VID-MVP-001, and CRITICAL-RECOVERY-11')
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
