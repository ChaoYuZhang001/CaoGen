#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const scriptPath = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const workerMode = process.argv[2] === '--worker'
const sourceEvidenceAtStart = workerMode ? undefined : readSourceEvidenceState(repoRoot)
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'workflow-artifact-delivery-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-delivery-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const writer = 'src/main/task/workflow-artifact-delivery.ts'
const projectId = 'delivery-recovery-project'
const artifactId = 'delivery-recovery-artifact-v1'
const evidenceId = 'delivery-recovery-evidence-v1'
const acceptanceId = 'delivery-recovery-acceptance-v1'
const generationAt = 1_900_000_000_000
const packageTargetName = 'delivery-package.zip'
const faultClasses = ['strong_kill', 'network_unknown_result', 'duplicate_idempotency', 'out_of_order']

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  const faultEvidence = {}
  let report
  try {
    const runtimes = await loadRuntimes()
    Object.assign(faultEvidence, await runRecoveryScenarios(runtimes))
    assert(faultClasses.every((name) => faultEvidence[name]?.status === 'verified'))
    report = passedRecoveryReport(faultEvidence)
  } catch (error) {
    report = failedRecoveryReport(faultEvidence, error)
    process.exitCode = 1
  } finally {
    finalizeRecoveryReport(report)
  }
  printRecoverySummary(report)
}

async function loadRuntimes() {
  compileSources()
  installRuntimeStubs()
  const deliveryModulePath = path.join(compiledDir, 'main', 'task', 'workflow-artifact-delivery.js')
  const importRuntime = (name) => import(pathToFileURL(path.join(compiledDir, 'main', 'task', name)).href)
  return {
    deliveryModulePath,
    deliveryRuntime: await import(pathToFileURL(deliveryModulePath).href),
    workflowRuntime: await importRuntime('workflow-ledger-api.js'),
    verifierRuntime: await importRuntime('workflow-delivery-package-verifier.js'),
    identityRuntime: await importRuntime('workflow-delivery-identity.js')
  }
}

async function runRecoveryScenarios(runtimes) {
  const { deliveryModulePath, deliveryRuntime, workflowRuntime, verifierRuntime, identityRuntime } = runtimes
  const manifestStrongKill = await runManifestStrongKillScenarios(deliveryModulePath, deliveryRuntime)
  const packageStrongKill = await runPackageStrongKillScenarios(runtimes)
  return {
    strong_kill: verifiedFault(
      { scenarios: manifestStrongKill },
      {
        scenarios: packageStrongKill,
        publicationLayers: ['streaming_zip_temporary', 'durable_candidate', 'rename', 'directory_fsync']
      }
    ),
    network_unknown_result: verifiedFault(
      { scenario: await verifyManifestUnknownResult(deliveryModulePath, deliveryRuntime) },
      { scenario: await verifyPackageUnknownResult({ deliveryModulePath, workflowRuntime, verifierRuntime, identityRuntime }) }
    ),
    duplicate_idempotency: verifiedFault(
      { scenario: await verifyManifestDuplicate(deliveryRuntime) },
      { scenario: await verifyPackageDuplicate({ deliveryModulePath, workflowRuntime, verifierRuntime, identityRuntime }) }
    ),
    out_of_order: verifiedFault(
      { scenario: await verifyManifestOutOfOrder(deliveryModulePath) },
      { scenario: await verifyPackageOutOfOrder({ deliveryModulePath, workflowRuntime, verifierRuntime, identityRuntime }) }
    )
  }
}

async function runManifestStrongKillScenarios(modulePath, runtime) {
  const scenarios = []
  for (const checkpoint of ['after_write', 'after_file_sync', 'after_publish']) {
    scenarios.push(await verifyManifestStrongKill(modulePath, runtime, checkpoint))
  }
  return scenarios
}

async function runPackageStrongKillScenarios(runtimes) {
  const scenarios = []
  for (const checkpoint of [
    'after_streaming_zip_sync',
    'after_durable_candidate_write',
    'after_durable_candidate_sync',
    'after_durable_rename',
    'after_directory_sync'
  ]) {
    scenarios.push(await verifyPackageStrongKill({ ...runtimes, checkpoint }))
  }
  return scenarios
}

function passedRecoveryReport(faultEvidence) {
  const worktreeStatusCount = gitStatusCount()
  return {
    ...baseRecoveryReport(),
    status: 'passed',
    verification: 'manifest_and_zip_runtime_publication_verified',
    classification: worktreeStatusCount === 0 ? 'clean_sha_evidence' : 'targeted_dirty_worktree_evidence',
    sourceRevision: git(['rev-parse', 'HEAD']),
    worktreeStatusCount,
    faults: faultEvidence,
    packagePublication: packagePublicationDescription(),
    explicitlyNotVerified: [
      'physical power-loss hardware behavior',
      'macOS Keychain availability in a signed packaged build',
      'clean release SHA binding when worktreeStatusCount is non-zero'
    ]
  }
}

function failedRecoveryReport(faultEvidence, error) {
  return {
    ...baseRecoveryReport(),
    status: 'failed',
    verification: 'not_verified',
    sourceRevision: git(['rev-parse', 'HEAD']),
    worktreeStatusCount: gitStatusCount(),
    faults: failedFaults(faultEvidence),
    error: serializeError(error)
  }
}

function baseRecoveryReport() {
  return {
    schemaVersion: 2,
    gate: 'test:workflow-artifact-delivery-recovery',
    requirement: 'NFR-REC-002',
    runId,
    writer,
    scope: 'Manifest and signed ZIP package recovery through production export and package verification APIs'
  }
}

function packagePublicationDescription() {
  return {
    exporter: 'exportWorkflowProjectDeliveryPackageToPath',
    verifier: 'verifyWorkflowProjectDeliveryPackageAtPath',
    fixture: 'canonical Project-scoped Artifact, Location, Evidence, Acceptance and Evidence Link',
    publicationLayers: {
      outer: 'streamed ZIP temporary file, stable hash, and cleanup',
      inner: 'writeDurableFile candidate, fsync, rename, and parent-directory fsync'
    },
    signing: 'real Ed25519 identity path with an isolated protected-storage boundary stub'
  }
}

function finalizeRecoveryReport(report) {
  const sourceEvidenceAtEnd = readSourceEvidenceState(repoRoot)
  const provenance = bindSourceEvidence(report, sourceEvidenceAtStart, sourceEvidenceAtEnd, 'Workflow Artifact delivery recovery')
  report.worktreeStatusCount = sourceEvidenceAtStart.statusEntryCount
  report.classification = sourceEvidenceAtStart.worktreeClean ? 'clean_sha_evidence' : 'targeted_dirty_worktree_evidence'
  if (provenance.status !== 'pass') {
    report.status = 'failed'
    report.verification = 'not_verified'
    process.exitCode = 1
  }
  mkdirSync(reportDir, { recursive: true })
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), body, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), body, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
}

function printRecoverySummary(report) {
  console.log(JSON.stringify({
    status: report.status,
    verification: report.verification,
    sourceRevision: report.sourceRevision,
    worktreeStatusCount: report.worktreeStatusCount,
    verifiedFaults: faultClasses.filter((name) => report.faults?.[name]?.status === 'verified').length,
    reportPath: path.relative(repoRoot, path.join(reportDir, 'report.json')),
    error: report.error
  }, null, 2))
}

function verifiedFault(manifest, zipPackage) {
  return {
    status: 'verified',
    requiredSurfaces: ['manifest', 'package'],
    surfaces: {
      manifest: { status: 'verified', ...manifest },
      package: { status: 'verified', ...zipPackage }
    }
  }
}

function failedFaults(observed) {
  return Object.fromEntries(faultClasses.map((name) => [name, observed[name] ?? {
    status: 'not_verified',
    requiredSurfaces: ['manifest', 'package'],
    surfaces: {
      manifest: { status: 'not_verified' },
      package: { status: 'not_verified' }
    }
  }]))
}

async function verifyManifestStrongKill(modulePath, runtime, checkpoint) {
  const root = scenarioRoot(`manifest-strong-kill-${checkpoint}`)
  const target = path.join(root, 'delivery-manifest.json')
  const exit = await invokeWorker({
    modulePath,
    surface: 'manifest',
    root,
    target,
    checkpoint,
    marker: 'strong',
    generationAt
  }, { killAtCheckpoint: checkpoint })
  assertStrongKill(exit, checkpoint)
  const publishedBeforeKill = checkpoint === 'after_publish'
  assert.equal(existsSync(target), publishedBeforeKill)
  const replay = await publishManifest(runtime, target, manifest('replay'))
  assert.equal(replay.fileName, 'delivery-manifest.json')
  assert.deepEqual(temporaryFilesForTarget(target), [])
  return {
    checkpoint,
    publicationLayer: 'durable_manifest',
    signal: exit.signal,
    publishedBeforeKill,
    restartPublishSucceeded: true,
    orphanTemporaryCount: 0,
    finalDigest: sha256(readFileSync(target))
  }
}

async function verifyManifestUnknownResult(modulePath, runtime) {
  const root = scenarioRoot('manifest-unknown-result')
  const target = path.join(root, 'delivery-manifest.json')
  const exit = await invokeWorker({
    modulePath,
    surface: 'manifest',
    root,
    target,
    checkpoint: 'post_directory_sync_throw',
    marker: 'unknown',
    generationAt
  })
  assert.equal(exit.code, 2)
  assert.equal(workerError(exit)?.code, 'EUNKNOWNRESULT')
  const published = JSON.parse(readFileSync(target, 'utf8'))
  assert.equal(published.artifact.id, 'artifact-unknown')
  await publishManifest(runtime, target, manifest('reconciled'))
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).artifact.id, 'artifact-reconciled')
  assert.deepEqual(temporaryFilesForTarget(target), [])
  return {
    injectedErrorCode: 'EUNKNOWNRESULT',
    publishedBytesReadBack: true,
    restartReconciled: true,
    finalDigest: sha256(readFileSync(target))
  }
}

async function verifyManifestDuplicate(runtime) {
  const root = scenarioRoot('manifest-duplicate')
  const target = path.join(root, 'delivery-manifest.json')
  const body = manifest('duplicate')
  await publishManifest(runtime, target, body)
  const first = fileIdentity(target)
  await publishManifest(runtime, target, body)
  const second = fileIdentity(target)
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).artifact.id, 'artifact-duplicate')
  assert.equal(second.digest, first.digest)
  assert.deepEqual(temporaryFilesForTarget(target), [])
  return {
    sameManifestReplayed: true,
    byteStable: true,
    finalDigest: second.digest
  }
}

async function verifyManifestOutOfOrder(modulePath) {
  const root = scenarioRoot('manifest-out-of-order')
  const target = path.join(root, 'delivery-manifest.json')
  const olderGenerationAt = generationAt
  const newerGenerationAt = generationAt + 1_000
  const older = startWorker({
    modulePath,
    surface: 'manifest',
    root,
    target,
    checkpoint: 'before_publish_lock',
    marker: 'older',
    generationAt: olderGenerationAt
  })
  try {
    await older.waitForCheckpoint('before_publish_lock')
    const newerExit = await invokeWorker({
      modulePath,
      surface: 'manifest',
      root,
      target,
      marker: 'newer',
      generationAt: newerGenerationAt
    })
    assertWorkerSucceeded(newerExit)
    const newerBytes = readFileSync(target)
    const newerManifest = JSON.parse(newerBytes)
    assert.equal(newerManifest.artifact.id, 'artifact-newer')

    older.resume('before_publish_lock')
    const olderExit = await older.completion
    assert.equal(olderExit.code, 2)
    assert.equal(workerError(olderExit)?.code, 'ESTALEPUBLICATION')
    assert.match(olderExit.messages.find((message) => message?.type === 'error')?.message ?? '', /Stale durable publication/)

    const bytes = readFileSync(target)
    const parsed = JSON.parse(bytes)
    assert.equal(parsed.artifact.id, 'artifact-newer')
    assert(bytes.equals(newerBytes))
    assert.deepEqual(temporaryFilesForTarget(target), [])
    assert.equal(existsSync(publicationLockPath(target)), false)
    return {
      concurrentFreshProcesses: 2,
      olderGenerationAt,
      newerGenerationAt,
      olderPausedBeforeRename: true,
      newerPublishedFirst: true,
      delayedOlderWriterRejectedByCas: true,
      rejectedError: 'ESTALEPUBLICATION',
      finalGeneration: 'newer',
      noPartialBytes: true,
      zeroTemporaryResidue: true,
      finalDigest: sha256(bytes)
    }
  } finally {
    if (!older.exited()) older.kill('SIGKILL')
  }
}

async function verifyPackageStrongKill({
  deliveryModulePath,
  workflowRuntime,
  verifierRuntime,
  identityRuntime,
  checkpoint
}) {
  const root = scenarioRoot(`package-strong-kill-${checkpoint}`)
  const fixture = await seedPackageFixture(workflowRuntime, root)
  await prepareSigningIdentity(identityRuntime, root, generationAt)
  const target = packageTarget(root)
  const exit = await invokeWorker(packageWorkerInput({
    modulePath: deliveryModulePath,
    root,
    target,
    checkpoint,
    generationAt
  }), { killAtCheckpoint: checkpoint })
  assertStrongKill(exit, checkpoint)
  const publishedBeforeKill = checkpoint === 'after_durable_rename' || checkpoint === 'after_directory_sync'
  assert.equal(existsSync(target), publishedBeforeKill)
  const preRetryTemporaryFiles = temporaryFilesForTarget(target)
  assert.equal(preRetryTemporaryFiles.length, expectedPackageOrphans(checkpoint))
  const beforeRetry = publishedBeforeKill
    ? await verifyPackage(verifierRuntime, target, root, fixture)
    : undefined

  const retry = await invokeWorker(packageWorkerInput({
    modulePath: deliveryModulePath,
    root,
    target,
    generationAt
  }))
  assertWorkerSucceeded(retry)
  const verified = await verifyPackage(verifierRuntime, target, root, fixture)
  assert.deepEqual(temporaryFilesForTarget(target), [])
  if (beforeRetry) assert.equal(verified.manifestDigest, beforeRetry.manifestDigest)
  return {
    checkpoint,
    publicationLayer: packageCheckpointLayer(checkpoint),
    signal: exit.signal,
    publishedBeforeKill,
    preRetryOrphanTemporaryCount: preRetryTemporaryFiles.length,
    freshProcessRetrySucceeded: true,
    zeroTemporaryResidue: true,
    packageVerification: verified
  }
}

async function verifyPackageUnknownResult({
  deliveryModulePath,
  workflowRuntime,
  verifierRuntime,
  identityRuntime
}) {
  const root = scenarioRoot('package-unknown-result')
  const fixture = await seedPackageFixture(workflowRuntime, root)
  await prepareSigningIdentity(identityRuntime, root, generationAt)
  const target = packageTarget(root)
  const exit = await invokeWorker(packageWorkerInput({
    modulePath: deliveryModulePath,
    root,
    target,
    checkpoint: 'post_directory_sync_throw',
    generationAt
  }))
  assert.equal(exit.code, 2)
  assert.equal(workerError(exit)?.code, 'EUNKNOWNRESULT')
  assert(existsSync(target), 'unknown-result package must be present after directory fsync')
  const beforeRetry = await verifyPackage(verifierRuntime, target, root, fixture)
  assert.deepEqual(temporaryFilesForTarget(target), [])

  const retry = await invokeWorker(packageWorkerInput({
    modulePath: deliveryModulePath,
    root,
    target,
    generationAt
  }))
  assertWorkerSucceeded(retry)
  const afterRetry = await verifyPackage(verifierRuntime, target, root, fixture)
  assert.equal(afterRetry.packageDigest, beforeRetry.packageDigest)
  assert.equal(afterRetry.manifestDigest, beforeRetry.manifestDigest)
  assert.deepEqual(temporaryFilesForTarget(target), [])
  return {
    injectedErrorCode: 'EUNKNOWNRESULT',
    injectionPoint: 'after_parent_directory_fsync',
    publishedPackageVerifiedBeforeRetry: true,
    freshProcessRetrySucceeded: true,
    sameGenerationByteStable: true,
    zeroTemporaryResidue: true,
    packageVerification: afterRetry
  }
}

async function verifyPackageDuplicate({
  deliveryModulePath,
  workflowRuntime,
  verifierRuntime,
  identityRuntime
}) {
  const root = scenarioRoot('package-duplicate')
  const fixture = await seedPackageFixture(workflowRuntime, root)
  await prepareSigningIdentity(identityRuntime, root, generationAt)
  const target = packageTarget(root)
  const input = packageWorkerInput({ modulePath: deliveryModulePath, root, target, generationAt })
  const firstExit = await invokeWorker(input)
  assertWorkerSucceeded(firstExit)
  const first = fileIdentity(target)
  const firstVerification = await verifyPackage(verifierRuntime, target, root, fixture)
  assert.deepEqual(temporaryFilesForTarget(target), [])

  const deadWriterTemporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.2147483647.00000000-0000-4000-8000-000000000000.tmp`
  )
  const unrelatedLookalike = path.join(
    path.dirname(target),
    `.${path.basename(target)}.2147483647.not-a-caogen-uuid.tmp`
  )
  writeFileSync(deadWriterTemporary, 'dead writer residue', 'utf8')
  writeFileSync(unrelatedLookalike, 'preserve this file', 'utf8')
  const secondExit = await invokeWorker(input)
  assertWorkerSucceeded(secondExit)
  assert.equal(existsSync(deadWriterTemporary), false, 'dead CaoGen ZIP temporary file was not reaped')
  assert.equal(readFileSync(unrelatedLookalike, 'utf8'), 'preserve this file')
  rmSync(unrelatedLookalike, { force: true })
  const second = fileIdentity(target)
  const secondVerification = await verifyPackage(verifierRuntime, target, root, fixture)
  assert.equal(second.digest, first.digest)
  assert.equal(secondVerification.manifestDigest, firstVerification.manifestDigest)
  assert.deepEqual(temporaryFilesForTarget(target), [])
  return {
    sameFrozenGenerationReplayed: true,
    freshProcesses: 2,
    byteStable: true,
    signatureReverified: true,
    deadWriterTemporaryReaped: true,
    unrelatedLookalikePreserved: true,
    zeroTemporaryResidue: true,
    finalDigest: second.digest,
    packageVerification: secondVerification
  }
}

async function verifyPackageOutOfOrder({
  deliveryModulePath,
  workflowRuntime,
  verifierRuntime,
  identityRuntime
}) {
  const root = scenarioRoot('package-out-of-order')
  const fixture = await seedPackageFixture(workflowRuntime, root)
  await prepareSigningIdentity(identityRuntime, root, generationAt)
  const target = packageTarget(root)
  const olderGenerationAt = generationAt
  const newerGenerationAt = generationAt + 1_000
  const older = startWorker(packageWorkerInput({
    modulePath: deliveryModulePath,
    root,
    target,
    checkpoint: 'before_publish_lock',
    generationAt: olderGenerationAt
  }))
  try {
    await older.waitForCheckpoint('before_publish_lock')
    const newerExit = await invokeWorker(packageWorkerInput({
      modulePath: deliveryModulePath,
      root,
      target,
      generationAt: newerGenerationAt
    }))
    assertWorkerSucceeded(newerExit)
    const newerPublished = await verifyPackage(verifierRuntime, target, root, fixture)

    older.resume('before_publish_lock')
    const olderExit = await older.completion
    assert.equal(olderExit.code, 2)
    assert.equal(workerError(olderExit)?.code, 'ESTALEPUBLICATION')
    assert.match(workerError(olderExit)?.message ?? '', /Stale durable publication/)
    const finalVerification = await verifyPackage(verifierRuntime, target, root, fixture)
    assert.equal(finalVerification.packageDigest, newerPublished.packageDigest)
    assert.equal(finalVerification.manifestDigest, newerPublished.manifestDigest)
    assert.deepEqual(temporaryFilesForTarget(target), [])
    assert.equal(existsSync(publicationLockPath(target)), false)
    return {
      concurrentFreshProcesses: 2,
      olderGenerationAt,
      newerGenerationAt,
      olderPausedBeforeRename: true,
      newerPublishedFirst: true,
      delayedOlderWriterRejectedByCas: true,
      rejectedError: 'ESTALEPUBLICATION',
      finalGeneration: 'newer',
      finalPackageComplete: true,
      signatureReverified: true,
      zeroTemporaryResidue: true,
      packageVerification: finalVerification
    }
  } finally {
    if (!older.exited()) older.kill('SIGKILL')
  }
}

async function seedPackageFixture(workflowRuntime, root) {
  mkdirSync(root, { recursive: true })
  const fixtureDir = path.join(root, 'canonical-artifacts')
  mkdirSync(fixtureDir, { recursive: true })
  const sourcePath = path.join(fixtureDir, 'verified-delivery.txt')
  const bytes = Buffer.from('CaoGen canonical delivery recovery fixture\n', 'utf8')
  const digest = sha256(bytes)
  writeFileSync(sourcePath, bytes)
  const createdAt = generationAt - 10_000
  await workflowRuntime.createWorkflowArtifact({
    id: artifactId,
    projectId,
    kind: 'document',
    title: 'Verified delivery recovery fixture',
    version: 1,
    digest: `sha256:${digest}`,
    mediaType: 'text/plain',
    provenance: 'explicit',
    createdAt,
    updatedAt: createdAt
  }, root)
  await workflowRuntime.createWorkflowArtifactLocation({
    id: 'delivery-recovery-location-v1',
    artifactId,
    projectId,
    kind: 'file',
    path: sourcePath,
    availability: 'available',
    checksum: `sha256:${digest}`,
    sizeBytes: bytes.byteLength,
    mediaType: 'text/plain',
    createdAt: createdAt + 1,
    updatedAt: createdAt + 1
  }, root)
  await workflowRuntime.createWorkflowEvidence({
    evidenceId,
    projectId,
    artifactId,
    kind: 'delivery_check',
    title: 'Canonical Artifact bytes verified',
    contentDigest: digest,
    metadata: { fixture: 'workflow-artifact-delivery-recovery-v1' }
  }, root, {
    source: 'runtime',
    verifier: 'workflow-artifact-delivery-recovery',
    observedAt: createdAt + 2
  })
  const criterion = 'Canonical Artifact bytes, Evidence and signature are delivery-ready'
  await workflowRuntime.saveWorkflowAcceptance({
    id: acceptanceId,
    projectId,
    criteria: [criterion],
    status: 'pending',
    revision: 1,
    createdAt: createdAt + 3,
    updatedAt: createdAt + 3
  }, root)
  await workflowRuntime.createWorkflowEvidenceLink({
    id: 'delivery-recovery-evidence-link-v1',
    evidenceId,
    evidenceOrigin: 'workflow',
    projectId,
    artifactId,
    acceptanceId,
    relation: 'verifies',
    createdAt: createdAt + 4
  }, root)
  await workflowRuntime.saveWorkflowAcceptance({
    id: acceptanceId,
    projectId,
    criteria: [criterion],
    status: 'verifying',
    evidenceRefs: [evidenceId],
    revision: 2,
    createdAt: createdAt + 3,
    updatedAt: createdAt + 5
  }, root)
  await workflowRuntime.saveWorkflowAcceptance({
    id: acceptanceId,
    projectId,
    criteria: [criterion],
    status: 'passed',
    evidenceRefs: [evidenceId],
    verifier: 'workflow-artifact-delivery-recovery',
    verifiedAt: createdAt + 6,
    revision: 3,
    createdAt: createdAt + 3,
    updatedAt: createdAt + 6
  }, root)
  const workbench = await workflowRuntime.getProjectDeliveryWorkbench(projectId, root)
  assert.equal(workbench.artifacts.length, 1)
  assert.equal(workbench.evidence.length, 1)
  assert.equal(workbench.acceptances.length, 1)
  assert.equal(workbench.acceptances[0].status, 'passed')
  return { sourcePath, digest, sizeBytes: bytes.byteLength }
}

async function prepareSigningIdentity(identityRuntime, root, timestamp) {
  return withFrozenClock(timestamp, () => identityRuntime.getWorkflowDeliverySigningIdentity(root))
}

async function verifyPackage(verifierRuntime, target, root, fixture) {
  const verification = await verifierRuntime.verifyWorkflowProjectDeliveryPackageAtPath(target, root)
  assert.equal(verification.verdict, 'verified', JSON.stringify(verification.blockers))
  assert.equal(verification.byteIntegrity, 'verified')
  assert.equal(verification.signatureStatus, 'valid')
  assert.equal(verification.identityTrust, 'local_identity')
  assert.equal(verification.trustPolicyVerdict, 'passed')
  assert.equal(verification.projectId, projectId)
  assert.equal(verification.entryCount, 2)
  assert.equal(verification.declaredArtifactCount, 1)
  assert.equal(verification.verifiedArtifactCount, 1)
  assert.equal(verification.verifiedArtifactBytes, fixture.sizeBytes)
  assert.deepEqual(verification.blockers, [])
  assert.equal(verification.packageDigest, `sha256:${sha256(readFileSync(target))}`)
  return {
    verdict: verification.verdict,
    byteIntegrity: verification.byteIntegrity,
    signatureStatus: verification.signatureStatus,
    identityTrust: verification.identityTrust,
    trustPolicyVerdict: verification.trustPolicyVerdict,
    projectId: verification.projectId,
    manifestDigest: verification.manifestDigest,
    packageDigest: verification.packageDigest,
    entryCount: verification.entryCount,
    declaredArtifactCount: verification.declaredArtifactCount,
    verifiedArtifactCount: verification.verifiedArtifactCount,
    verifiedArtifactBytes: verification.verifiedArtifactBytes
  }
}

function packageWorkerInput({ modulePath, root, target, checkpoint = '', generationAt: timestamp }) {
  return {
    modulePath,
    surface: 'zip_package',
    root,
    target,
    checkpoint,
    projectId,
    generationAt: timestamp
  }
}

function expectedPackageOrphans(checkpoint) {
  if (checkpoint === 'after_durable_candidate_write' || checkpoint === 'after_durable_candidate_sync') return 2
  return 1
}

function packageCheckpointLayer(checkpoint) {
  const layers = {
    before_publish_lock: 'publication_lock_cas_boundary',
    after_streaming_zip_sync: 'streaming_zip_temporary',
    after_durable_candidate_write: 'durable_candidate_write',
    after_durable_candidate_sync: 'durable_candidate_fsync',
    after_durable_rename: 'durable_rename',
    after_directory_sync: 'parent_directory_fsync'
  }
  return layers[checkpoint]
}

function packageTarget(root) {
  return path.join(root, 'exports', packageTargetName)
}

function publicationLockPath(target) {
  return `${target}.caogen-publish.lock`
}

async function publishManifest(runtime, target, body) {
  return runtime.exportWorkflowArtifactManifestToPath(body, target)
}

function invokeWorker(input, options = {}) {
  const worker = startWorker(input)
  if (!options.killAtCheckpoint) return worker.completion
  return worker.waitForCheckpoint(options.killAtCheckpoint).then(() => {
    worker.kill('SIGKILL')
    return worker.completion
  })
}

function startWorker(input) {
  const payload = Buffer.from(JSON.stringify(input)).toString('base64url')
  const child = fork(scriptPath, ['--worker', payload], {
    cwd: repoRoot,
    execArgv: [],
    env: { ...process.env, NODE_PATH: process.env.NODE_PATH },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  const messages = []
  const checkpointWaiters = new Map()
  let settled = false
  let exited = false
  let stderr = ''
  let completionResolve
  let completionReject
  const completion = new Promise((resolve, reject) => {
    completionResolve = resolve
    completionReject = reject
  })
  const timeout = setTimeout(() => {
    child.kill('SIGKILL')
    finish(new Error('delivery recovery worker timed out'))
  }, 60_000)
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  child.on('message', (message) => {
    messages.push(message)
    if (message?.type !== 'checkpoint') return
    const waiters = checkpointWaiters.get(message.checkpoint) ?? []
    checkpointWaiters.delete(message.checkpoint)
    for (const waiter of waiters) waiter.resolve(message)
  })
  child.on('error', (error) => finish(error))
  child.on('exit', (code, signal) => {
    exited = true
    finish(null, { code, signal, messages, stderr })
  })
  function finish(error, value) {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    for (const waiters of checkpointWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error ?? new Error('worker exited before checkpoint'))
    }
    checkpointWaiters.clear()
    if (error) completionReject(error)
    else completionResolve(value)
  }
  function waitForCheckpoint(checkpoint) {
    const observed = messages.find((message) => message?.type === 'checkpoint' && message.checkpoint === checkpoint)
    if (observed) return Promise.resolve(observed)
    if (exited) return Promise.reject(new Error(`worker exited before checkpoint ${checkpoint}`))
    return new Promise((resolve, reject) => {
      const values = checkpointWaiters.get(checkpoint) ?? []
      values.push({ resolve, reject })
      checkpointWaiters.set(checkpoint, values)
    })
  }
  return {
    completion,
    waitForCheckpoint,
    resume(checkpoint) { child.send({ type: 'continue', checkpoint }) },
    kill(signal = 'SIGKILL') { child.kill(signal) },
    exited: () => exited
  }
}

async function runWorker() {
  const Module = require('node:module').Module
  const realFs = require('node:fs')
  const realPromises = require('node:fs/promises')
  const originalLoad = Module._load
  const originalNow = Date.now
  const payload = workerPayload()
  const target = path.resolve(payload.target)
  const parent = path.dirname(target)
  const streamingTemporaryPaths = new Set()
  Date.now = () => payload.generationAt
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises' || request === 'fs/promises') {
      return faultInjectingPromises(realPromises, target, parent, payload.checkpoint, streamingTemporaryPaths)
    }
    if (request === 'node:fs' || request === 'fs') {
      return {
        ...realFs,
        createWriteStream: (...args) => {
          const openedPath = path.resolve(String(args[0]))
          if (isTargetTemporaryPath(openedPath, target)) streamingTemporaryPaths.add(openedPath)
          return realFs.createWriteStream(...args)
        }
      }
    }
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const runtime = require(payload.modulePath)
    const result = payload.surface === 'zip_package'
      ? await runtime.exportWorkflowProjectDeliveryPackageToPath(payload.projectId, target, payload.root)
      : await runtime.exportWorkflowArtifactManifestToPath(manifest(payload.marker, payload.generationAt), target)
    process.send?.({ type: 'completed', result })
  } catch (error) {
    process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
    Date.now = originalNow
  }
}

function workerPayload() {
  const raw = process.argv[3]
  if (!raw) throw new Error('delivery recovery worker payload is required')
  const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  for (const key of ['modulePath', 'surface', 'root', 'target']) {
    if (typeof payload[key] !== 'string' || !payload[key]) throw new Error(`worker payload ${key} is required`)
  }
  if (!Number.isSafeInteger(payload.generationAt)) throw new Error('worker payload generationAt is required')
  if (!['manifest', 'zip_package'].includes(payload.surface)) throw new Error('worker payload surface is invalid')
  return { checkpoint: '', marker: 'worker', projectId, ...payload }
}

function faultInjectingPromises(realPromises, target, parent, checkpoint, streamingTemporaryPaths) {
  return {
    ...realPromises,
    open: async (...args) => {
      const openedPath = path.resolve(String(args[0]))
      if (openedPath === publicationLockPath(target) && checkpoint === 'before_publish_lock') {
        await pauseAt(checkpoint, { layer: 'publication_lock' })
      }
      const handle = await realPromises.open(...args)
      const layer = openedPath === parent
        ? 'directory'
        : streamingTemporaryPaths.has(openedPath)
          ? 'streaming_zip_temporary'
          : isTargetTemporaryPath(openedPath, target)
            ? 'durable_candidate'
            : undefined
      return wrapHandle(handle, layer, checkpoint)
    },
    rename: async (...args) => {
      const result = await realPromises.rename(...args)
      if (path.resolve(String(args[1])) === target) {
        if (checkpoint === 'after_publish') await pauseAt(checkpoint, { layer: 'durable_rename' })
        if (checkpoint === 'after_durable_rename') await pauseAt(checkpoint, { layer: 'durable_rename' })
      }
      return result
    }
  }
}

function wrapHandle(handle, layer, checkpoint) {
  return new Proxy(handle, {
    get(owner, property) {
      if (property === 'writeFile' && layer === 'durable_candidate') return async (...args) => {
        const result = await owner.writeFile(...args)
        if (checkpoint === 'after_write') await pauseAt(checkpoint, { layer })
        if (checkpoint === 'after_durable_candidate_write') await pauseAt(checkpoint, { layer })
        return result
      }
      if (property === 'sync') return async (...args) => {
        const result = await owner.sync(...args)
        if (layer === 'streaming_zip_temporary' && checkpoint === 'after_streaming_zip_sync') {
          await pauseAt(checkpoint, { layer })
        }
        if (layer === 'durable_candidate' && checkpoint === 'after_file_sync') {
          await pauseAt(checkpoint, { layer })
        }
        if (layer === 'durable_candidate' && checkpoint === 'after_durable_candidate_sync') {
          await pauseAt(checkpoint, { layer })
        }
        if (layer === 'directory' && checkpoint === 'after_directory_sync') {
          await pauseAt(checkpoint, { layer: 'parent_directory' })
        }
        if (layer === 'directory' && checkpoint === 'post_directory_sync_throw') {
          throw Object.assign(new Error('injected delivery publication unknown result'), { code: 'EUNKNOWNRESULT' })
        }
        return result
      }
      const value = Reflect.get(owner, property, owner)
      return typeof value === 'function' ? value.bind(owner) : value
    }
  })
}

async function pauseAt(checkpoint, details) {
  await new Promise((resolve) => process.send?.({ type: 'checkpoint', checkpoint, ...details }, resolve))
  await new Promise((resolve) => {
    const listener = (message) => {
      if (message?.type !== 'continue' || message.checkpoint !== checkpoint) return
      process.off('message', listener)
      resolve()
    }
    process.on('message', listener)
  })
}

function manifest(marker, generatedAt = generationAt) {
  const artifact = {
    id: `artifact-${marker}`,
    projectId: 'delivery-project',
    kind: 'document',
    title: `Delivery ${marker}`,
    version: 1,
    digest: `sha256:${marker.padEnd(64, '0').slice(0, 64)}`,
    sizeBytes: marker.length,
    createdAt: 1_000
  }
  const verification = { verdict: 'blocked', artifact }
  const body = {
    schemaVersion: 1,
    format: 'caogen.artifact-delivery-manifest.v1',
    generatedAt,
    artifact,
    lineage: { artifactId: artifact.id, versions: [1] },
    evidence: [],
    acceptances: [],
    verification
  }
  return { ...body, manifestDigest: `sha256:${sha256(Buffer.from(canonicalJson(body)))}` }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function installRuntimeStubs() {
  const electronDir = path.join(compiledDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), [
    'module.exports = {',
    '  app: { getPath: () => process.cwd(), isPackaged: false, focus() {} },',
    '  ipcMain: { handle() {} },',
    '  BrowserWindow: { getAllWindows: () => [] },',
    '  dialog: {},',
    '  Notification: class { static isSupported() { return false } once() {} show() {} }',
    '}'
  ].join('\n') + '\n')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"commonjs"}\n')

  const protectedStoragePath = path.join(compiledDir, 'main', 'security', 'protected-storage-runtime.js')
  assert(existsSync(protectedStoragePath), 'compiled protected-storage runtime is missing')
  writeFileSync(protectedStoragePath, [
    "'use strict'",
    'exports.protectedStorage = {',
    '  isEncryptionAvailable: () => true,',
    "  encryptString: (value) => Buffer.from(value, 'utf8'),",
    "  decryptString: (value) => Buffer.from(value).toString('utf8'),",
    "  getSelectedStorageBackend: () => 'isolated_test_keychain'",
    '}'
  ].join('\n') + '\n')
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/workflow-artifact-delivery.ts',
    'src/main/task/workflow-delivery-package-verifier.ts',
    'src/main/task/workflow-ledger-api.ts',
    '--outDir', compiledDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
}

function scenarioRoot(name) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  return root
}

function temporaryFilesForTarget(target) {
  const parent = path.dirname(target)
  if (!existsSync(parent)) return []
  const prefix = `.${path.basename(target)}.`
  return readdirSync(parent).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp')).sort()
}

function isTargetTemporaryPath(candidate, target) {
  return path.dirname(candidate) === path.dirname(target) &&
    path.basename(candidate).startsWith(`.${path.basename(target)}.`) &&
    path.basename(candidate).endsWith('.tmp')
}

function assertStrongKill(exit, checkpoint) {
  const observed = process.platform === 'win32'
    ? exit.signal === null && exit.code !== 0
    : exit.signal === 'SIGKILL'
  assert(observed, `${checkpoint} worker must receive a strong kill: ${JSON.stringify(exit)}`)
  assert(exit.messages.some((message) => message?.type === 'checkpoint' && message.checkpoint === checkpoint))
}

function assertWorkerSucceeded(exit) {
  assert.equal(exit.code, 0, `worker failed: ${exit.stderr || JSON.stringify(workerError(exit))}`)
  assert.equal(exit.signal, null)
  assert(exit.messages.some((message) => message?.type === 'completed'))
}

function workerError(exit) {
  return exit.messages.find((message) => message?.type === 'error')
}

function fileIdentity(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino), size: info.size, digest: sha256(readFileSync(file)) }
}

async function withFrozenClock(timestamp, action) {
  const original = Date.now
  Date.now = () => timestamp
  try { return await action() } finally { Date.now = original }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function git(args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' }
}

function gitStatusCount() {
  return git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length
}

function serializeError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'Error', message: String(error) }
}
