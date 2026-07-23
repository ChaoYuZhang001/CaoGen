import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-acceptance-artifact-integrity-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  compileSources()
  installElectronStub()
  const api = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-api.js')).href)
  const projectStoreApi = await import(pathToFileURL(
    path.join(outDir, 'main', 'project-workspace', 'store.js')
  ).href)
  const projectCommandApi = await import(pathToFileURL(
    path.join(outDir, 'main', 'project-workspace', 'command-service.js')
  ).href)
  const dependencies = { api, projectCommandApi, projectStoreApi }

  await assertValidLocalPath(dependencies)
  await assertValidFileUri(dependencies)
  await assertUnavailableLocationsCannotSatisfyAcceptance(dependencies)
  await assertInvalidPhysicalEvidence(dependencies)
  await assertAllAvailableLocalCopiesMustVerify(dependencies)
  await assertPostPassMutationFailsClosed(dependencies)

  console.log('acceptance artifact integrity smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function assertValidLocalPath(dependencies) {
  const fixture = await createFixture(dependencies, 'valid-local-path')
  const passed = await passAcceptance(fixture)
  const sourceItem = await mirrorPassedAcceptance(fixture, passed)
  await fixture.api.queryWorkflowArtifactGraph(fixture.artifactId, fixture.root)
  const done = await fixture.commands.transitionWorkItem(sourceItem.id, 'done', sourceItem.revision)
  assertEqual(done.status, 'done', 'valid absolute local file must permit canonical done')
}

async function assertValidFileUri(dependencies) {
  const fixture = await createFixture(dependencies, 'valid-file-uri', {
    artifactDigestStyle: 'bare',
    locations: [{ locator: 'file-uri', checksumStyle: 'bare' }]
  })
  const passed = await passAcceptance(fixture)
  const sourceItem = await mirrorPassedAcceptance(fixture, passed)
  const done = await fixture.commands.transitionWorkItem(sourceItem.id, 'done', sourceItem.revision)
  assertEqual(done.status, 'done', 'valid file: URI must permit canonical done')
}

async function assertUnavailableLocationsCannotSatisfyAcceptance(dependencies) {
  for (const availability of ['pending', 'unavailable', 'deleted', 'unknown']) {
    const fixture = await createFixture(dependencies, `availability-${availability}`, {
      locations: [{ availability }]
    })
    await expectArtifactGate(
      passAcceptance(fixture),
      'workflow_evidence_artifact_local_location_missing',
      `${availability} ArtifactLocation must not satisfy terminal evidence`,
      fixture
    )
  }
}

async function assertInvalidPhysicalEvidence(dependencies) {
  const wrongContentDigest = differentDigest('evidence-content')
  const cases = [
    {
      name: 'missing-file',
      options: { materialization: 'missing' },
      reason: 'workflow_evidence_artifact_file_unavailable'
    },
    {
      name: 'directory',
      options: { materialization: 'directory' },
      reason: 'workflow_evidence_artifact_file_not_regular'
    },
    {
      name: 'symlink',
      options: { materialization: 'symlink' },
      reason: 'workflow_evidence_artifact_file_not_regular'
    },
    {
      name: 'size-mismatch',
      options: { locations: [{ sizeDelta: 1 }] },
      reason: 'workflow_evidence_artifact_size_mismatch'
    },
    {
      name: 'size-missing',
      options: { locations: [{ omitSize: true }] },
      reason: 'workflow_evidence_artifact_location_size_missing'
    },
    {
      name: 'checksum-mismatch',
      options: { locations: [{ checksum: differentDigest('location') }] },
      reason: 'workflow_artifact_location_checksum_mismatch'
    },
    {
      name: 'checksum-missing',
      options: { locations: [{ omitChecksum: true }] },
      reason: 'workflow_evidence_artifact_location_checksum_missing'
    },
    {
      name: 'artifact-digest-mismatch',
      options: { artifactDigest: differentDigest('artifact') },
      reason: 'workflow_artifact_digest_mismatch'
    },
    {
      name: 'artifact-digest-invalid',
      options: { artifactDigest: 'not-a-sha256-digest' },
      reason: 'workflow_artifact_digest_invalid'
    },
    {
      name: 'evidence-digest-mismatch',
      options: {
        artifactDigest: wrongContentDigest,
        evidenceDigest: wrongContentDigest,
        locations: [{ checksum: wrongContentDigest }]
      },
      reason: 'workflow_evidence_content_digest_mismatch'
    },
    {
      name: 'checksum-invalid',
      options: { locations: [{ checksum: 'not-a-sha256-digest' }] },
      reason: 'workflow_artifact_location_checksum_invalid'
    },
    {
      name: 'remote-only',
      options: { locations: [{ locator: 'remote-url' }] },
      reason: 'workflow_evidence_artifact_local_location_missing'
    }
  ]

  for (const scenario of cases) {
    const fixture = await createFixture(dependencies, scenario.name, scenario.options)
    await expectArtifactGate(
      passAcceptance(fixture),
      scenario.reason,
      `${scenario.name} must fail closed`,
      fixture
    )
  }
}

async function assertAllAvailableLocalCopiesMustVerify(dependencies) {
  const fixture = await createFixture(dependencies, 'mixed-local-copies', {
    locations: [
      {},
      { pathSuffix: '-missing-copy', materialization: 'missing' }
    ]
  })
  await expectArtifactGate(
    passAcceptance(fixture),
    'workflow_evidence_artifact_file_unavailable',
    'one valid local copy must not hide another missing available copy',
    fixture
  )
}

async function assertPostPassMutationFailsClosed(dependencies) {
  const modified = await createFixture(dependencies, 'post-pass-modified', {
    content: 'artifact bytes A\n',
    locations: [{ omitSize: false }]
  })
  const modifiedPassed = await passAcceptance(modified)
  const modifiedSourceItem = await mirrorPassedAcceptance(modified, modifiedPassed)
  writeFileSync(modified.filePath, 'artifact bytes B\n')
  await expectCanonicalArtifactGate(
    modified.commands.transitionWorkItem(modifiedSourceItem.id, 'done', modifiedSourceItem.revision),
    [
      'workflow_evidence_content_digest_mismatch',
      'workflow_artifact_digest_mismatch',
      'workflow_artifact_location_checksum_mismatch'
    ],
    'modifying bytes after passed Acceptance must block canonical done',
    modified,
    modifiedSourceItem
  )

  const deleted = await createFixture(dependencies, 'post-pass-deleted')
  const deletedPassed = await passAcceptance(deleted)
  const deletedSourceItem = await mirrorPassedAcceptance(deleted, deletedPassed)
  unlinkSync(deleted.filePath)
  await expectCanonicalArtifactGate(
    deleted.commands.transitionWorkItem(deletedSourceItem.id, 'done', deletedSourceItem.revision),
    ['workflow_evidence_artifact_file_unavailable'],
    'deleting bytes after passed Acceptance must block canonical done',
    deleted,
    deletedSourceItem
  )
}

async function createFixture(dependencies, name, options = {}) {
  const id = name.replace(/[^a-z0-9-]/g, '-')
  const root = path.join(tempRoot, id)
  const artifactDir = path.join(root, 'artifacts')
  const filePath = path.join(artifactDir, `${id}.txt`)
  const content = Buffer.from(options.content ?? `acceptance artifact ${id}\n`)
  const contentDigest = sha256(content)
  mkdirSync(artifactDir, { recursive: true })
  materialize(filePath, content, options.materialization ?? 'file')

  const projectId = `project-${id}`
  const workItemId = `work-${id}`
  const artifactId = `artifact-${id}`
  const acceptanceId = `acceptance-${id}`
  const evidenceId = `evidence-${id}`
  const store = new dependencies.projectStoreApi.ProjectWorkspaceStore(root)
  await store.open()
  await store.createWorkspace({ id: projectId, name: `Artifact ${id}`, kind: 'software' })
  const commands = dependencies.projectCommandApi.createProjectWorkspaceCommandService(
    store,
    { rootDir: root }
  )
  const item = await commands.createWorkItem({
    id: workItemId,
    projectId,
    title: `Verify physical artifact ${id}`,
    status: 'verifying'
  })
  const artifactDigest = options.artifactDigest ?? formatDigest(
    contentDigest,
    options.artifactDigestStyle ?? 'prefixed'
  )
  await dependencies.api.createWorkflowArtifact({
    id: artifactId,
    projectId,
    workItemId,
    kind: 'test_report',
    title: `Artifact integrity ${id}`,
    digest: artifactDigest
  }, root)

  const locationSpecs = options.locations ?? [{}]
  for (let index = 0; index < locationSpecs.length; index += 1) {
    const spec = locationSpecs[index]
    const locationPath = spec.pathSuffix ? `${filePath}${spec.pathSuffix}` : filePath
    if (spec.pathSuffix) {
      materialize(locationPath, content, spec.materialization ?? 'file')
    }
    const location = buildLocation({
      artifactId,
      content,
      contentDigest,
      id,
      index,
      locationPath,
      projectId,
      spec,
      workItemId
    })
    await dependencies.api.createWorkflowArtifactLocation(location, root)
  }

  const pending = await dependencies.api.saveWorkflowAcceptance({
    id: acceptanceId,
    projectId,
    workItemId,
    criteria: ['physical artifact bytes remain locally verifiable']
  }, root)
  await dependencies.api.createWorkflowEvidence({
    evidenceId,
    projectId,
    workItemId,
    artifactId,
    kind: 'test_result',
    title: `Physical artifact evidence ${id}`,
    contentDigest: options.evidenceDigest ?? contentDigest
  }, root, {
    source: 'runtime',
    verifier: 'acceptance-artifact-integrity-smoke',
    observedAt: 1_000
  })
  const link = await dependencies.api.createWorkflowEvidenceLink({
    id: `link-${id}`,
    evidenceId,
    evidenceOrigin: 'workflow',
    projectId,
    workItemId,
    artifactId,
    acceptanceId,
    relation: 'verifies'
  }, root)

  return {
    ...dependencies,
    acceptanceId,
    artifactId,
    commands,
    contentDigest,
    evidenceId,
    filePath,
    item,
    link,
    pending,
    projectId,
    root,
    store,
    workItemId
  }
}

function buildLocation(input) {
  const { spec } = input
  const checksum = spec.checksum ?? formatDigest(
    input.contentDigest,
    spec.checksumStyle ?? 'prefixed'
  )
  const common = {
    id: `location-${input.id}-${input.index + 1}`,
    artifactId: input.artifactId,
    projectId: input.projectId,
    workItemId: input.workItemId,
    availability: spec.availability ?? 'available',
    ...(spec.omitChecksum ? {} : { checksum }),
    ...(spec.omitSize ? {} : { sizeBytes: input.content.byteLength + (spec.sizeDelta ?? 0) })
  }
  if (spec.locator === 'file-uri') {
    return { ...common, kind: 'file', uri: pathToFileURL(input.locationPath).href }
  }
  if (spec.locator === 'remote-url') {
    return { ...common, kind: 'url', uri: `https://example.test/${input.id}.txt` }
  }
  return { ...common, kind: 'file', path: input.locationPath }
}

function materialize(filePath, content, kind) {
  if (kind === 'missing') return
  if (kind === 'directory') {
    mkdirSync(filePath, { recursive: true })
    return
  }
  if (kind === 'symlink') {
    const targetPath = `${filePath}.target`
    writeFileSync(targetPath, content)
    symlinkSync(targetPath, filePath)
    return
  }
  writeFileSync(filePath, content)
}

async function passAcceptance(fixture) {
  const checking = await fixture.api.saveWorkflowAcceptance({
    ...fixture.pending,
    status: 'verifying',
    evidenceRefs: [fixture.link.evidenceId],
    revision: fixture.pending.revision + 1,
    updatedAt: 1_100
  }, fixture.root)
  return fixture.api.saveWorkflowAcceptance({
    ...checking,
    status: 'passed',
    verifier: 'acceptance-artifact-integrity-smoke',
    verifiedAt: 1_200,
    revision: checking.revision + 1,
    updatedAt: 1_200
  }, fixture.root)
}

function mirrorPassedAcceptance(fixture, passed) {
  return fixture.store.setWorkItemAcceptance(fixture.item.id, {
    status: 'passed',
    evidenceRefs: [fixture.evidenceId],
    verifiedBy: passed.verifier,
    verifiedAt: passed.verifiedAt
  }, fixture.item.revision)
}

async function expectArtifactGate(promise, reason, message, fixture) {
  try {
    await promise
  } catch (error) {
    assertEqual(error?.code, 'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID', `${message} (code)`)
    assertEqual(error?.details?.reason, reason, `${message} (reason)`)
    assertPathRedacted(error, fixture, message)
    return error
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

async function expectCanonicalArtifactGate(promise, reasons, message, fixture, item) {
  try {
    await promise
  } catch (error) {
    assertEqual(error?.code, 'canonical_acceptance_required', `${message} (code)`)
    assertEqual(error?.details?.sourceCommitted, false, `${message} must precede source commit`)
    assertEqual(error?.details?.reconciliationRequired, false, `${message} must not require reconciliation`)
    assertEqual(error?.details?.causeCode, 'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID', `${message} (causeCode)`)
    assertEqual(error?.cause?.code, 'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID', `${message} (cause code)`)
    assert(
      reasons.includes(error?.cause?.details?.reason),
      `${message} reason must be one of ${JSON.stringify(reasons)}, got ${JSON.stringify(error?.cause?.details?.reason)}`
    )
    assertPathRedacted(error, fixture, message)
    const unchanged = await fixture.store.getWorkItem(item.id)
    assert(unchanged, `${message} rejected WorkItem must remain readable`)
    assertEqual(unchanged.status, 'verifying', `${message} must preserve WorkItem status`)
    assertEqual(unchanged.revision, item.revision, `${message} must preserve WorkItem revision`)
    const readiness = await fixture.commands.getShadowProjectionReadiness()
    assertEqual(readiness?.ready, true, `${message} must not leave a pending journal`)
    return error
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assertPathRedacted(error, fixture, message) {
  const exposed = [
    error?.message,
    error?.cause?.message,
    JSON.stringify(error?.details ?? {}),
    JSON.stringify(error?.cause?.details ?? {})
  ].filter(Boolean).join('\n')
  assert(!exposed.includes(fixture.root), `${message} must not expose fixture root`)
  assert(!exposed.includes(fixture.filePath), `${message} must not expose artifact path`)
}

function formatDigest(value, style) {
  return style === 'bare' ? value : `sha256:${value}`
}

function differentDigest(label) {
  return sha256(Buffer.from(`different-${label}`))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/task-snapshot.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/workflow-ledger-store.ts',
    'src/main/task/workflow-acceptance-guard.ts',
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/command-service.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(tempRoot)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(root, name) {
  const found = searchCompiledModule(root, name)
  if (!found) throw new Error(`compiled ${name} not found under ${root}`)
  return found
}

function searchCompiledModule(root, name) {
  for (const entry of require('node:fs').readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = searchCompiledModule(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) {
      return fullPath
    }
  }
  return undefined
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
