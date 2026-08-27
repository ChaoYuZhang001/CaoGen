export function validateEvidenceDocument(definition, report, context) {
  if (!isObject(report)) return ['report root is not an object']
  const errors = [
    ...validateEvidenceHeader(definition, report),
    ...validateEvidenceCounts(report),
    ...validateSourceBinding(report, context.expectedCommit, context.checkoutDigest)
  ]
  if (definition.electron) {
    errors.push(...validateElectronBuild(report, context.currentBuild, context.expectedCommit, context.checkoutDigest))
  }
  return errors
}

export function validateSourceBinding(report, expectedCommit, checkoutDigest) {
  return [
    ...validateSourceSummary(report, expectedCommit, checkoutDigest),
    ...validateSourceProvenance(report, expectedCommit, checkoutDigest)
  ]
}

export function validateElectronBuild(report, currentBuild, expectedCommit, checkoutDigest) {
  const build = report.buildEvidence
  if (!isObject(build)) return ['Electron report is missing build evidence']
  const errors = [
    ...validateElectronEnvelope(build),
    ...validateElectronSource(build.evidence?.source, expectedCommit, checkoutDigest),
    ...validateElectronOutputRecord(build.evidence),
    ...validateElectronOutputMatch(build, currentBuild)
  ]
  return errors
}

export function summarizeBuild(build) {
  if (!build) return { status: 'missing' }
  return {
    status: build.status,
    errors: build.errors,
    sourceRevision: build.evidence?.source?.end?.commit,
    sourceCheckoutDigest: build.evidence?.source?.end?.checkoutDigest,
    output: build.output,
    generatedAt: build.evidence?.generatedAt
  }
}

function validateEvidenceHeader(definition, report) {
  const errors = []
  if (report.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (report.gate !== definition.gate) errors.push(`gate is ${report.gate ?? 'missing'}, expected ${definition.gate}`)
  if (!['pass', 'passed'].includes(report.status)) errors.push(`status is ${report.status ?? 'missing'}`)
  if (report.ok !== undefined && report.ok !== true) errors.push('ok is not true')
  return errors
}

function validateEvidenceCounts(report) {
  const errors = []
  if (Number.isFinite(report.pass) && Number.isFinite(report.total) && report.pass !== report.total) {
    errors.push(`pass/total is ${report.pass}/${report.total}`)
  }
  if (Array.isArray(report.failures) && report.failures.length > 0) errors.push('failures are present')
  return errors
}

function validateSourceSummary(report, expectedCommit, checkoutDigest) {
  const errors = []
  if (report.sourceRevision !== expectedCommit || report.sourceRevisionAtEnd !== expectedCommit) {
    errors.push('source revision does not match expected HEAD at both boundaries')
  }
  if (report.sourceWorktreeClean !== true || report.sourceWorktreeCleanAtEnd !== true) {
    errors.push('source report is not clean at both boundaries')
  }
  if (report.sourceStatusEntryCount !== 0 || report.sourceStatusEntryCountAtEnd !== 0) {
    errors.push('source report contains status entries')
  }
  if (report.sourceCheckoutDigest !== checkoutDigest || report.sourceCheckoutDigestAtEnd !== checkoutDigest) {
    errors.push('source checkout digest does not match the Stage E checkout')
  }
  return errors
}

function validateSourceProvenance(report, expectedCommit, checkoutDigest) {
  const provenance = report.provenance
  const errors = []
  if (provenance?.status !== 'pass' || !Array.isArray(provenance?.drift) || provenance.drift.length !== 0) {
    errors.push('source provenance did not pass without drift')
  }
  for (const boundary of ['start', 'end']) {
    if (!matchesCleanSource(provenance?.[boundary], expectedCommit, checkoutDigest)) {
      errors.push(`provenance ${boundary} does not match the clean Stage E checkout`)
    }
  }
  return errors
}

function validateElectronEnvelope(build) {
  const errors = []
  if (build.status !== 'pass' || !Array.isArray(build.errors) || build.errors.length !== 0) {
    errors.push('Electron report build evidence did not pass')
  }
  if (build.evidence?.schemaVersion !== 1 || build.evidence?.kind !== 'caogen-build-evidence' ||
      build.evidence?.status !== 'passed') {
    errors.push('Electron report contains invalid build manifest evidence')
  }
  return errors
}

function validateElectronSource(source, expectedCommit, checkoutDigest) {
  const errors = []
  if (source?.status !== 'pass' || !Array.isArray(source?.drift) || source.drift.length !== 0) {
    errors.push('Electron build source provenance did not pass without drift')
  }
  for (const boundary of ['start', 'end']) {
    if (!matchesCleanSource(source?.[boundary], expectedCommit, checkoutDigest)) {
      errors.push(`Electron build ${boundary} does not match the clean Stage E checkout`)
    }
  }
  return errors
}

function validateElectronOutputRecord(evidence) {
  return evidence?.outputValidation?.status === 'pass' &&
    Array.isArray(evidence.outputValidation.errors) && evidence.outputValidation.errors.length === 0
    ? []
    : ['Electron build output validation did not pass']
}

function validateElectronOutputMatch(build, currentBuild) {
  if (currentBuild?.status !== 'pass') return ['current out directory has no valid build evidence']
  const fields = ['digest', 'fileCount', 'totalBytes']
  return fields
    .filter((field) => build.output?.[field] !== currentBuild.output?.[field] ||
      build.evidence?.output?.[field] !== currentBuild.output?.[field])
    .map((field) => `Electron build ${field} does not match current out`)
}

function matchesCleanSource(state, expectedCommit, checkoutDigest) {
  return state?.commit === expectedCommit && state?.worktreeClean === true &&
    state?.statusEntryCount === 0 && state?.checkoutDigest === checkoutDigest
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
