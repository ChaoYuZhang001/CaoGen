export const REQUIRED_RECOVERY_FAULTS = [
  'strong_kill',
  'network_unknown_result',
  'duplicate_idempotency',
  'out_of_order'
]

export function durableRecoveryRequirementStatus(recovery = {}) {
  const counts = recoveryCounts(recovery)
  if (!counts) return 'open'
  if (counts.gap > 0) return 'open'
  if (counts.implemented_unverified > 0) return 'inventory_closed_unverified'
  return 'verified'
}

export function durableWriterInventoryClosed(inventory, options = {}) {
  const summary = inventorySummary(inventory)
  return summary !== undefined && sourceBindingClosed(inventory, options) &&
    writerContractsClosed(inventory.writers, summary)
}

export function workflowDeliverySurfacesClosed(report, faultClass, options = {}) {
  const fault = report?.faults?.[faultClass]
  return isWorkflowDeliveryReport(report, faultClass, options) &&
    faultClosed(fault) && surfacesClosed(fault.surfaces)
}

export function durableWriterGapReason(inventory) {
  if (!inventory) return 'durable writer runtime evidence inventory is missing or not current-SHA clean-bound'
  const recovery = inventory.summary?.recovery ?? {}
  const open = (optionalCount(recovery.implemented_unverified) ?? 0) + (optionalCount(recovery.gap) ?? 0)
  return open > 0
    ? `${open} durable writers still lack runtime recovery evidence`
    : 'durable writer inventory is not fully bound to four-class runtime evidence'
}

function optionalCount(value) {
  if (value === undefined) return 0
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function recoveryCounts(recovery) {
  if (!isRecord(recovery)) return undefined
  const keys = ['gap', 'implemented_unverified', 'verified', 'exempt']
  const counts = {}
  let hasValue = false
  for (const key of keys) {
    if (recovery[key] !== undefined) hasValue = true
    const count = optionalCount(recovery[key])
    if (count === undefined) return undefined
    counts[key] = count
  }
  return hasValue ? counts : undefined
}

function inventorySummary(inventory) {
  if (!isRecord(inventory) || inventory.inventoryStatus !== 'complete' || inventory.requirementStatus !== 'verified') {
    return undefined
  }
  const summary = inventory.summary
  const recovery = summary?.recovery
  if (!isRecord(summary) || !isRecord(recovery)) return undefined
  const modules = requiredCount(summary.modules)
  const verified = requiredCount(recovery.verified)
  const exempt = optionalCount(recovery.exempt)
  const unverified = optionalCount(recovery.implemented_unverified)
  const gap = optionalCount(recovery.gap)
  if (modules === undefined || verified === undefined || exempt === undefined ||
      unverified !== 0 || gap !== 0 || verified < 1 || verified + exempt !== modules) return undefined
  return { modules, verified, exempt }
}

function writerContractsClosed(writers, summary) {
  if (!Array.isArray(writers) || writers.length !== summary.modules) return false
  return writers.every(writerContractClosed)
}

function writerContractClosed(writer) {
  const contract = writer?.contract
  if (!isRecord(contract)) return false
  if (contract.recovery === 'exempt') return true
  return contract.recovery === 'verified' && namedEvidence(contract.evidence) &&
    namedEvidence(contract.requiredRecoverySurfaces, true)
}

function namedEvidence(values, optional = false) {
  if (values === undefined && optional) return true
  return Array.isArray(values) && values.length > 0 && values.every(
    (item) => typeof item === 'string' && item.trim().length > 0
  ) && new Set(values).size === values.length
}

function requiredCount(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sourceBindingClosed(value, options) {
  if (options.expectedSourceRevision !== undefined && value.sourceRevision !== options.expectedSourceRevision) {
    return false
  }
  return !options.requireClean || value.worktreeStatusCount === 0
}

function isWorkflowDeliveryReport(report, faultClass, options) {
  if (!isRecord(report) || report.writer !== 'src/main/task/workflow-artifact-delivery.ts' ||
      !REQUIRED_RECOVERY_FAULTS.includes(faultClass) || !sourceBindingClosed(report, options)) return false
  if (options.requireSchema && (report.schemaVersion !== 2 || report.status !== 'passed')) return false
  return true
}

function faultClosed(fault) {
  const surfaces = new Set(fault?.requiredSurfaces)
  return isRecord(fault) && fault.status === 'verified' &&
    Array.isArray(fault.requiredSurfaces) &&
    fault.requiredSurfaces.length === 2 &&
    surfaces.size === 2 && surfaces.has('manifest') && surfaces.has('package')
}

function surfacesClosed(surfaces) {
  return isRecord(surfaces) &&
    surfaceClosed(surfaces.manifest) &&
    surfaceClosed(surfaces.package)
}

function surfaceClosed(surface) {
  return isRecord(surface) && surface.status === 'verified'
}
