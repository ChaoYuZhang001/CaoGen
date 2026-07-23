import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  requiresReleasePlatformMatrix,
  trustedMacDistributionChecks,
  trustedPackagedLaunchChecks,
  trustedWindowsDistributionChecks
} from './release-packaging-policy.mjs'

export function releasePlatformMatrixChecks({
  releaseVersion,
  gitState,
  macosX64ArtifactSetSha256,
  macosX64Audit,
  macosArm64Audit,
  windowsX64Audit,
  macosX64LaunchAudit,
  macosArm64LaunchAudit,
  windowsX64LaunchAudit
}) {
  if (!requiresReleasePlatformMatrix(releaseVersion)) return {}
  return {
    ...prefixChecks('macosX64', trustedPackagedLaunchChecks({
      audit: macosX64LaunchAudit,
      releaseVersion,
      gitState,
      platform: 'darwin',
      targetArch: 'x64',
      artifactSetSha256: macosX64Audit?.artifactSetSha256
    })),
    ...prefixChecks('macosArm64', trustedMacDistributionChecks({
      audit: macosArm64Audit,
      releaseVersion,
      gitState,
      artifactSetSha256: macosArm64Audit?.artifactSetSha256,
      targetArch: 'arm64'
    })),
    ...prefixChecks('macosArm64', trustedPackagedLaunchChecks({
      audit: macosArm64LaunchAudit,
      releaseVersion,
      gitState,
      platform: 'darwin',
      targetArch: 'arm64',
      artifactSetSha256: macosArm64Audit?.artifactSetSha256
    })),
    ...prefixChecks('windowsX64', trustedWindowsDistributionChecks({
      audit: windowsX64Audit,
      releaseVersion,
      gitState,
      targetArch: 'x64'
    })),
    ...prefixChecks('windowsX64', trustedPackagedLaunchChecks({
      audit: windowsX64LaunchAudit,
      releaseVersion,
      gitState,
      platform: 'win32',
      targetArch: 'x64',
      artifactSetSha256: windowsX64Audit?.artifactSetSha256
    })),
    macosX64ArtifactSetBound: /^[0-9a-f]{64}$/i.test(macosX64ArtifactSetSha256 || '')
  }
}

export function releaseArtifactEvidence(repoRoot, version) {
  const files = requiresReleasePlatformMatrix(version)
    ? [
        ...releasePlatformArtifactNames(version, 'macos-x64'),
        ...releasePlatformArtifactNames(version, 'macos-arm64'),
        ...releasePlatformArtifactNames(version, 'windows-x64'),
        'latest-mac.yml'
      ].sort()
    : [...releasePlatformArtifactNames(version, 'macos-x64'), 'latest-mac.yml'].sort()
  return digestReleaseFiles(repoRoot, files)
}

export function releasePlatformArtifactEvidence(repoRoot, version, target) {
  return digestReleaseFiles(repoRoot, releasePlatformArtifactNames(version, target).sort())
}

export function releasePlatformArtifactNames(version, target) {
  if (target === 'macos-x64') {
    return [
      `CaoGen-${version}.dmg`,
      `CaoGen-${version}.dmg.blockmap`,
      `CaoGen-${version}-mac.zip`,
      `CaoGen-${version}-mac.zip.blockmap`
    ]
  }
  if (target === 'macos-arm64') {
    return [
      `CaoGen-${version}-arm64.dmg`,
      `CaoGen-${version}-arm64.dmg.blockmap`,
      `CaoGen-${version}-arm64-mac.zip`,
      `CaoGen-${version}-arm64-mac.zip.blockmap`
    ]
  }
  if (target === 'windows-x64') {
    return [
      `CaoGen Setup ${version}.exe`,
      `CaoGen Setup ${version}.exe.blockmap`,
      'latest.yml'
    ]
  }
  return []
}

export function releasePackagingCommands(trustedDistributionRequired) {
  const platformCommands = trustedDistributionRequired
    ? [
        'npm run release:mac:preflight:x64',
        'npm run dist:mac:release:x64',
        'npm run test:macos-release-audit:required -- --arch x64',
        'npm run test:packaged-app:mac:x64',
        'npm run dist:mac:release:arm64 (on native Apple Silicon)',
        'npm run test:packaged-app:mac:arm64 (on native Apple Silicon)',
        'npm run dist:win:release:x64 (on native Windows x64)',
        'npm run test:packaged-app:win:x64 (on native Windows x64)'
      ]
    : ['npm run dist:mac:x64']
  return [
    'npm run typecheck',
    'npm run build',
    'npm run test:deep',
    'npm run secret:scan:history',
    ...platformCommands,
    'npm run test:release-packaging-audit:required'
  ]
}

export function releasePackagingNextActions(trustedDistributionRequired) {
  return [
    'Bump package.json and package-lock.json only when all required evidence gates are proved.',
    'Run platform packaging and native install/launch audits before uploading.',
    ...(trustedDistributionRequired
      ? ['For v0.1.7 and later, x64-only, unsigned, unnotarized, or non-native preview evidence never satisfies the distribution gate.']
      : []),
    'Run the packaging audit against the intended release version before creating GitHub Release assets.',
    'Publish only the intended installer/update assets; never upload test-results, out, node_modules, .env files, certs, private keys, or local evidence packs.'
  ]
}

function prefixChecks(prefix, checks) {
  return Object.fromEntries(Object.entries(checks).map(([name, passed]) => [
    `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`,
    passed
  ]))
}

function digestReleaseFiles(repoRoot, files) {
  const missing = files.filter((file) => !existsSync(path.join(repoRoot, 'dist', file)))
  if (missing.length > 0) return { complete: false, missing, files: {}, artifactSetSha256: null }
  const digests = Object.fromEntries(files.map((file) => {
    const absolutePath = path.join(repoRoot, 'dist', file)
    return [file, {
      size: statSync(absolutePath).size,
      sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
    }]
  }))
  return {
    complete: true,
    missing: [],
    files: digests,
    artifactSetSha256: createHash('sha256').update(JSON.stringify(digests)).digest('hex')
  }
}
