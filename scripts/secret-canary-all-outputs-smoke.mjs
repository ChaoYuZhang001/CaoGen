#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
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
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-secret-all-outputs-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataRoot = path.join(tempRoot, 'user-data')
const projectRoot = path.join(tempRoot, 'project')
const learningRoot = path.join(userDataRoot, 'learning')
const evidenceRoot = path.join(tempRoot, 'evidence')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'secret-canary-all-outputs', runId)
const latestPath = path.join(repoRoot, 'test-results', 'secret-canary-all-outputs', 'latest.json')
const canary = ['marble', 'lantern', 'frost', '8264'].join('-')
const checks = []

process.env.CAOGEN_USER_DATA_DIR = userDataRoot
process.env.CAOGEN_MEMORY_DIR = path.join(userDataRoot, 'memory')

try {
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(evidenceRoot, { recursive: true })
  installElectronStub()
  configureModuleSearchPath()
  compile([
    'src/main/providerCredentialBroker.ts',
    'src/main/security/secret-redaction.ts',
    'src/main/security/main-process-console-redaction.ts',
    'src/main/security/crash-diagnostic.ts',
    'src/main/transcript.ts',
    'src/main/learning/learning-lifecycle.ts',
    'src/main/task/workflow-ledger-artifact-security.ts',
    'src/main/task/artifact-lifecycle-content.ts',
    'src/main/project-aggregate/project-aggregate-export.ts',
    'src/main/permission/audit-log.ts'
  ])

  const brokerModule = await loadCompiled('providerCredentialBroker.js')
  const redaction = await loadCompiled('secret-redaction.js')
  const broker = new brokerModule.ProviderCredentialBroker(secureBackend())
  const credentialRecord = broker.store(
    { providerId: 'all-output-provider', keyId: 'all-output-key' },
    canary
  )
  redaction.configureKnownCredentialRedactor((value) => broker.redactKnownCredentials(value))
  check(!JSON.stringify(credentialRecord).includes(canary), 'Broker record excludes the arbitrary canary')
  check(redaction.containsKnownCredential(`prefix ${canary} suffix`), 'Broker recognizes a non-token-shaped canary')
  check(
    redaction.redactSensitiveText('session-ref:auto-review-session') === 'session-ref:auto-review-session',
    'Session provenance namespace survives secret redaction'
  )
  check(
    redaction.redactSensitiveText('session:credential-value') === 'session:[REDACTED]',
    'Session credential syntax remains redacted'
  )

  await verifyRendererAndTranscript(redaction)
  await verifyLearningOutputs()
  await verifyArtifactAndEvidenceRejection()
  await verifyProjectExport()
  await verifyPermissionAudit()
  await verifyOrdinaryLog(redaction)
  await verifyCrashDiagnostic()
  verifyProductionWiring()

  assertNoCanaryInRoots([userDataRoot, projectRoot, evidenceRoot])
  check(true, 'all generated application outputs exclude the raw canary')

  const report = {
    schemaVersion: 1,
    status: 'passed',
    required: true,
    runId,
    gitCommit: gitCommit(),
    worktreeClean: false,
    canary: {
      shape: 'arbitrary broker-known credential',
      rawValuePersisted: false,
      replacement: '[REDACTED]'
    },
    surfaces: [
      'renderer-event',
      'transcript-jsonl',
      'memory',
      'skill',
      'artifact',
      'evidence',
      'project-export',
      'permission-audit',
      'ordinary-log',
      'crash-diagnostic',
      'test-report'
    ],
    checks
  }
  mkdirSync(reportDir, { recursive: true })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(latestPath, serialized, 'utf8')
  assertNoCanaryInRoots([reportDir, latestPath])
  console.log(`secret canary all outputs: PASS (${checks.length}/${checks.length})`)
  console.log(`report: ${path.relative(repoRoot, reportDir)}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function verifyRendererAndTranscript(redaction) {
  const transcript = await loadCompiled('transcript.js')
  const writer = new transcript.TranscriptWriter()
  writer.nextEntry({ kind: 'init', sdkSessionId: 'all-output-session', model: 'fixture-model' })
  const entry = writer.nextEntry({
    kind: 'user-message',
    messageId: 'all-output-message',
    text: `renderer payload ${canary}`
  })
  const rendererPayload = redaction.redactSensitiveValue({
    sessionId: 'all-output-session',
    event: entry.event
  })
  const rendererPath = path.join(evidenceRoot, 'renderer-event.json')
  writeFileSync(rendererPath, `${JSON.stringify(rendererPayload, null, 2)}\n`, 'utf8')
  const rendererText = readFileSync(rendererPath, 'utf8')
  check(!rendererText.includes(canary) && rendererText.includes('[REDACTED]'),
    'Renderer event contains only the redaction marker')

  const transcriptText = readFileSync(transcript.transcriptFile('all-output-session'), 'utf8')
  check(!transcriptText.includes(canary) && transcriptText.includes('[REDACTED]'),
    'Transcript JSONL contains only the redaction marker')
}

async function verifyLearningOutputs() {
  const learning = await loadCompiled('learning-lifecycle.js')
  await learning.createLearningDraft(projectRoot, learningRoot, {
    kind: 'memory',
    source: 'all-output-memory',
    payload: {
      type: 'memory',
      memoryKind: 'workflow-preference',
      title: 'Credential redaction',
      body: `memory body ${canary}`,
      reason: 'all-output canary'
    }
  })
  await learning.createLearningDraft(projectRoot, learningRoot, {
    kind: 'skill',
    source: 'all-output-skill',
    payload: {
      type: 'skill',
      name: 'Credential Redaction',
      description: 'Keep credentials out of generated Skills.',
      markdown: `# Credential Redaction\n\n${canary}\n`,
      relativePath: 'credential-redaction/SKILL.md'
    }
  })
  const learningText = readFilesUnder(learningRoot).join('\n')
  check(!learningText.includes(canary) && learningText.includes('[REDACTED]'),
    'Memory and Skill persisted state contains only the redaction marker')
}

async function verifyArtifactAndEvidenceRejection() {
  const security = await loadCompiled('workflow-ledger-artifact-security.js')
  const content = await loadCompiled('artifact-lifecycle-content.js')
  assertRejects(
    () => security.assertWorkflowArtifactMetadataSafe({ note: canary }, 'artifact metadata'),
    'Artifact metadata rejects a Broker-known arbitrary credential'
  )
  assertRejects(
    () => security.assertWorkflowEvidenceTextSafe(canary, 'workflow evidence summary'),
    'Evidence text rejects a Broker-known arbitrary credential'
  )
  await assertRejectsAsync(
    () => content.prepareArtifactContent({
      storageKind: 'blob',
      bytes: Buffer.from(`artifact bytes ${canary}`, 'utf8')
    }, userDataRoot),
    'Artifact content rejects credential-bearing bytes before materialization'
  )
}

async function verifyProjectExport() {
  const aggregateExport = await loadCompiled('project-aggregate-export.js')
  const result = aggregateExport.buildProjectAggregateExport(
    {
      projectId: 'all-output-project',
      aggregateRevision: 1,
      identityDigest: 'identity-digest',
      aggregateDigest: 'aggregate-digest',
      objectCounts: {},
      diagnosticNote: canary
    },
    { aggregateRevision: 1 },
    { roleTemplates: [], diagnosticNote: canary },
    { routines: [], diagnosticNote: canary },
    { dependencies: [], milestones: [], diagnosticNote: canary },
    {
      taskSnapshots: [{ prompt: canary }],
      modelAttempts: [],
      artifactLifecycles: [],
      artifactPurges: [],
      artifactBlobs: [],
      runtimeDigest: 'runtime-digest'
    }
  )
  const exportPath = path.join(evidenceRoot, 'project-export.json')
  writeFileSync(exportPath, `${result.json}\n`, 'utf8')
  const exportText = readFileSync(exportPath, 'utf8')
  check(!exportText.includes(canary) && exportText.includes('[REDACTED]'),
    'Project export defensively redacts aggregate, dependency, automation, and runtime values')
}

async function verifyPermissionAudit() {
  const audit = await loadCompiled('audit-log.js')
  audit.writeAuditLog(projectRoot, {
    action: 'deny',
    source: 'policy',
    toolName: 'all-output-probe',
    input: { note: canary },
    message: `audit message ${canary}`,
    fallbackReason: `audit fallback ${canary}`
  })
  const logPath = path.join(projectRoot, '.caogen', 'audit.log')
  check(existsSync(logPath), 'Permission audit fixture writes a durable JSONL record')
  const auditText = readFileSync(logPath, 'utf8')
  check(!auditText.includes(canary) && auditText.includes('[REDACTED]'),
    'Permission audit JSONL contains only the redaction marker')
}

async function verifyOrdinaryLog(redaction) {
  const projected = redaction.redactLogArguments([
    new Error(`ordinary error ${canary}`),
    { detail: canary }
  ])
  const logPath = path.join(evidenceRoot, 'ordinary.log')
  writeFileSync(logPath, `${JSON.stringify(projected)}\n`, 'utf8')
  const logText = readFileSync(logPath, 'utf8')
  check(!logText.includes(canary) && logText.includes('[REDACTED]'),
    'Ordinary log arguments redact Error and structured values')
}

async function verifyCrashDiagnostic() {
  const crash = await loadCompiled('crash-diagnostic.js')
  const diagnostic = crash.buildRendererCrashDiagnostic(
    { reason: `crashed ${canary}`, exitCode: 9 },
    new Date('2026-08-11T00:00:00.000Z')
  )
  const crashPath = path.join(evidenceRoot, 'crash-diagnostic.json')
  writeFileSync(crashPath, `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8')
  const crashText = readFileSync(crashPath, 'utf8')
  check(!crashText.includes(canary) && crashText.includes('[REDACTED]'),
    'Renderer crash diagnostic is whitelist-shaped and credential-free')
}

function verifyProductionWiring() {
  const transcript = source('src/main/transcript.ts')
  const openai = source('src/main/openaiEngine.ts')
  const anthropic = source('src/main/anthropicEngine.ts')
  const sessionManager = source('src/main/sessionManager.ts')
  const index = source('src/main/index.ts')
  const portableRuntime = source('src/main/data-lifecycle/project-portable-runtime.ts')
  check(transcript.includes('const safeEvent = redactTranscriptEvent(event)'),
    'TranscriptWriter redacts before persistence and identity projection')
  check(openai.includes('emit(entry.event, entry.seq, entry)'),
    'OpenAI Engine emits the TranscriptWriter redacted event')
  check(anthropic.includes('emit(entry.event, entry.seq, entry)'),
    'Anthropic Engine emits the TranscriptWriter redacted event')
  check(sessionManager.includes('const event = redactSensitiveValue(normalizedEvent)'),
    'SessionManager defensively redacts non-standard Engine events')
  check(index.includes("import './security/main-process-console-redaction'"),
    'main entry installs process-wide console redaction')
  check(index.includes('buildRendererCrashDiagnostic(details)'),
    'renderer crash logging uses the whitelist diagnostic')
  check(!source('src/main/index.ts').includes('crashReporter.start('),
    'application does not create credential-bearing native crash uploads')
  check((portableRuntime.match(/assertArtifactContentCredentialFree\(bytes\)/g) ?? []).length >= 4,
    'Project Artifact export and import inspect decoded bytes before packaging or materialization')
}

function installElectronStub() {
  const moduleRoot = path.join(tempRoot, 'node_modules', 'electron')
  mkdirSync(moduleRoot, { recursive: true })
  writeFileSync(path.join(moduleRoot, 'index.js'), [
    "'use strict'",
    'module.exports = {',
    '  app: { getPath: () => process.env.CAOGEN_USER_DATA_DIR },',
    '  safeStorage: {',
    '    isEncryptionAvailable: () => true,',
    "    getSelectedStorageBackend: () => 'keychain',",
    '    encryptString: (value) => Buffer.from(value, \'utf8\'),',
    '    decryptString: (value) => Buffer.from(value).toString(\'utf8\')',
    '  }',
    '}',
    ''
  ].join('\n'), 'utf8')
}

function configureModuleSearchPath() {
  const require = createRequire(import.meta.url)
  process.env.NODE_PATH = [path.join(tempRoot, 'node_modules'), path.join(repoRoot, 'node_modules')]
    .join(path.delimiter)
  require('node:module').Module._initPaths()
}

function compile(files) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    ...files,
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

async function loadCompiled(fileName) {
  return import(pathToFileURL(findCompiled(outDir, fileName)).href)
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled ${fileName} not found`)
}

function findCompiledOptional(root, fileName) {
  try {
    return findCompiled(root, fileName)
  } catch {
    return null
  }
}

function secureBackend() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8')
  }
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function readFilesUnder(root) {
  if (!existsSync(root)) return []
  if (statSync(root).isFile()) return [readFileSync(root, 'utf8')]
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(root, entry.name)
    return entry.isDirectory() ? readFilesUnder(child) : [readFileSync(child, 'utf8')]
  })
}

function assertNoCanaryInRoots(roots) {
  for (const root of roots) {
    for (const text of readFilesUnder(root)) {
      if (text.includes(canary)) throw new Error('raw secret canary reached a persisted output')
    }
  }
}

function assertRejects(run, label) {
  let rejected = false
  try {
    run()
  } catch {
    rejected = true
  }
  check(rejected, label)
}

async function assertRejectsAsync(run, label) {
  let rejected = false
  try {
    await run()
  } catch {
    rejected = true
  }
  check(rejected, label)
}

function gitCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function check(condition, label) {
  if (!condition) throw new Error(label)
  checks.push({ id: `C${String(checks.length + 1).padStart(2, '0')}`, label, status: 'passed' })
}
