export const TRUSTED_MAC_DISTRIBUTION_MIN_VERSION = '0.1.7'

export function requiresTrustedMacDistribution(releaseVersion) {
  return compareVersions(releaseVersion, TRUSTED_MAC_DISTRIBUTION_MIN_VERSION) >= 0
}

export function trustedMacDistributionChecks({
  audit,
  releaseVersion,
  gitState,
  artifactSetSha256,
  targetArch = 'x64'
}) {
  const provenance = audit?.buildProvenance?.app
  return {
    macosDistributionAuditPassed: audit?.status === 'passed',
    macosDistributionAuditWasRequired: audit?.required === true,
    macosDistributionModeMatches: audit?.mode === 'post_build',
    macosDistributionVersionMatches: audit?.packageVersion === releaseVersion,
    macosDistributionTargetArchMatches: audit?.targetArch === targetArch,
    macosDistributionCommitMatches: audit?.git?.commit === gitState.commit,
    macosDistributionCleanEvidence: audit?.git?.worktreeClean === true && gitState.worktreeClean,
    macosDistributionArtifactSetMatches:
      Boolean(artifactSetSha256) && audit?.artifactSetSha256 === artifactSetSha256,
    macosDistributionBuildCommitMatches: provenance?.gitCommit === gitState.commit,
    macosDistributionBuildWasClean: provenance?.worktreeClean === true,
    macosDistributionBuildVersionMatches: provenance?.packageVersion === releaseVersion
  }
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return null
  return value.split('.').map(Number)
}
