import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mapPath = join(repoRoot, 'src/main/data-lifecycle/local-data-map.ts')
const required = process.argv.includes('--required')
const failures = []
const checks = []

const mapModule = await loadTypeScriptModule(mapPath)
const entries = mapModule.LOCAL_DATA_LIFECYCLE_MAP
const aggregateObjects = mapModule.PROJECT_AGGREGATE_OBJECTS
const exclusions = mapModule.PERSISTENCE_SCAN_EXCLUSIONS
const foundation = mapModule.NFR_PRIV_001_FOUNDATION_STATUS
const expectedAggregateObjects = [
  'Workspace',
  'Resource',
  'Goal',
  'WorkItem',
  'Squad',
  'Comment',
  'DigitalWorker',
  'Assignment',
  'Lease',
  'Run',
  'Artifact',
  'Evidence',
  'Acceptance',
  'Memory',
  'Budget',
  'Policy',
  'Audit'
]

check(Array.isArray(entries) && entries.length >= 20, 'map contains the expected Store families')
check(
  Array.isArray(aggregateObjects) &&
    aggregateObjects.length === expectedAggregateObjects.length &&
    aggregateObjects.every((object, index) => object === expectedAggregateObjects[index]),
  `Project aggregate object contract exactly matches: ${expectedAggregateObjects.join(', ')}`
)
check(Array.isArray(exclusions), 'persistence scan exclusions are explicit')
check(foundation?.requirementId === 'NFR-PRIV-001' && foundation.status === 'partial', 'foundation remains truthfully partial')

const ids = new Set()
const paths = new Map()
const registeredSources = new Set()
for (const entry of entries) validateEntry(entry)

const coveredObjects = entries.flatMap((entry) => entry.projectObjects ?? [])
const duplicateObjects = duplicates(coveredObjects)
const missingObjects = aggregateObjects.filter((object) => !coveredObjects.includes(object))
const unknownObjects = coveredObjects.filter((object) => !aggregateObjects.includes(object))
check(missingObjects.length === 0, `Project aggregate coverage is complete${suffix(missingObjects)}`)
check(duplicateObjects.length === 0, `Project aggregate ownership is unambiguous${suffix(duplicateObjects)}`)
check(unknownObjects.length === 0, `Project aggregate coverage contains no unknown objects${suffix(unknownObjects)}`)

const credentialEntries = entries.filter((entry) => entry.sensitivity === 'credential')
check(credentialEntries.length >= 3, 'credential-bearing Store families are classified')
for (const entry of credentialEntries) {
  check(
    entry.export.mode === 'redacted' || entry.export.mode === 'excluded',
    `${entry.id} excludes or redacts credentials from export`
  )
}

const requiredFamilies = [
  'project-workspace',
  'workflow-ledger',
  'digital-workers',
  'learning',
  'project-aggregate-seals',
  'session-history',
  'active-sessions',
  'transcripts',
  'attachments',
  'task-plans',
  'supervisor-state',
  'task-audit',
  'effect-artifacts',
  'providers',
  'provider-authorizations',
  'notification-connectors',
  'provider-health-and-model-stats',
  'provider-profile-backups',
  'provider-native-import-backups',
  'codex-native-config-backups',
  'settings',
  'routines',
  'managed-worktrees',
  'migration-backups',
  'annotations',
  'plugins',
  'office-artifact-outputs',
  'indexes-and-cache'
]
const missingFamilies = requiredFamilies.filter((id) => !ids.has(id))
check(missingFamilies.length === 0, `required Store families are registered${suffix(missingFamilies)}`)

const excludedSources = new Set()
for (const exclusion of exclusions) {
  const source = exclusion?.sourceModule
  check(typeof source === 'string' && source.startsWith('src/main/'), 'scan exclusion has a main-process source')
  check(!excludedSources.has(source), `scan exclusion is unique: ${source}`)
  excludedSources.add(source)
  check(existsSync(join(repoRoot, source)), `scan exclusion source exists: ${source}`)
  check(
    exclusion.boundary === 'external_user_action'
      || exclusion.boundary === 'runtime_only'
      || exclusion.boundary === 'delegates_to_registered_store',
    `scan exclusion boundary is valid: ${source}`
  )
  check(typeof exclusion.reason === 'string' && exclusion.reason.length >= 20, `scan exclusion has a reason: ${source}`)
}

const candidates = scanPersistenceCandidates(join(repoRoot, 'src/main'))
const unregistered = candidates.filter((source) => !registeredSources.has(source) && !excludedSources.has(source))
check(unregistered.length === 0, `durable persistence source scan has no unregistered candidates${suffix(unregistered)}`)

const incomplete = entries
  .filter((entry) => entry.implementationStatus !== 'enforced' || entry.gaps.length > 0)
  .map((entry) => ({
    id: entry.id,
    implementationStatus: entry.implementationStatus,
    gaps: entry.gaps
  }))

const report = {
  generatedAt: new Date().toISOString(),
  required,
  requirementId: foundation.requirementId,
  requirementStatus: foundation.status,
  status: failures.length === 0 ? 'passed' : 'failed',
  summary: {
    entries: entries.length,
    paths: paths.size,
    registeredSources: registeredSources.size,
    scannedCandidates: candidates.length,
    explicitExclusions: excludedSources.size,
    aggregateObjects: aggregateObjects.length,
    credentialEntries: credentialEntries.length,
    enforcedEntries: entries.filter((entry) => entry.implementationStatus === 'enforced').length,
    partialEntries: entries.filter((entry) => entry.implementationStatus === 'partial').length,
    inventoryOnlyEntries: entries.filter((entry) => entry.implementationStatus === 'inventory_only').length,
    checks: checks.length,
    failures: failures.length
  },
  checks,
  failures,
  unregisteredSources: unregistered,
  incomplete,
  openRequirementWork: foundation.open
}

const timestamp = report.generatedAt.replace(/[:.]/g, '-')
const reportDir = join(repoRoot, 'test-results', 'local-data-map', timestamp)
mkdirSync(reportDir, { recursive: true })
writeFileSync(join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
mkdirSync(join(repoRoot, 'test-results', 'local-data-map'), { recursive: true })
writeFileSync(join(repoRoot, 'test-results', 'local-data-map', 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(`Local data map: ${report.status}`)
console.log(`Entries: ${report.summary.entries}; paths: ${report.summary.paths}; candidates: ${report.summary.scannedCandidates}`)
console.log(`Checks: ${report.summary.checks}; failures: ${report.summary.failures}; incomplete entries: ${incomplete.length}`)
console.log(`Report: ${relative(repoRoot, join(reportDir, 'report.json'))}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

function validateEntry(entry) {
  check(entry && typeof entry === 'object', 'map entry is an object')
  if (!entry || typeof entry !== 'object') return
  validateEntryIdentity(entry)
  validateEntryPaths(entry)
  validateEntrySources(entry)
  validateEntryPolicy(entry)
}

function validateEntryIdentity(entry) {
  check(typeof entry.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id), `entry id is valid: ${entry.id}`)
  check(!ids.has(entry.id), `entry id is unique: ${entry.id}`)
  ids.add(entry.id)
  check(typeof entry.title === 'string' && entry.title.length >= 8, `${entry.id} has a title`)
}

function validateEntryPaths(entry) {
  check(Array.isArray(entry.paths) && entry.paths.length > 0, `${entry.id} declares paths`)
  for (const path of entry.paths ?? []) {
    check(typeof path === 'string' && path.length > 3, `${entry.id} path is valid`)
    check(!paths.has(path), `${entry.id} path is unique: ${path}`)
    paths.set(path, entry.id)
  }
}

function validateEntrySources(entry) {
  check(Array.isArray(entry.sourceModules) && entry.sourceModules.length > 0, `${entry.id} declares source modules`)
  for (const source of entry.sourceModules ?? []) {
    check(typeof source === 'string' && source.startsWith('src/main/'), `${entry.id} source is main-process owned: ${source}`)
    check(existsSync(join(repoRoot, source)), `${entry.id} source exists: ${source}`)
    registeredSources.add(source)
  }
}

function validateEntryPolicy(entry) {
  check(entry.owner && typeof entry.owner.key === 'string' && entry.owner.key.length > 0, `${entry.id} declares an owner key`)
  check(['internal', 'personal', 'confidential', 'credential'].includes(entry.sensitivity), `${entry.id} sensitivity is valid`)
  check(['enforced', 'partial', 'inventory_only'].includes(entry.implementationStatus), `${entry.id} implementation status is valid`)
  check(Array.isArray(entry.gaps), `${entry.id} declares gaps`)
  if (entry.implementationStatus !== 'enforced') {
    check(entry.gaps.length > 0, `${entry.id} incomplete status has explicit gaps`)
  }
  const externalPath = entry.paths.some((path) => /^(?:projectRoot|userHome|user-selected)/.test(path))
  if (entry.owner?.scope === 'external_resource' || externalPath) {
    check(entry.deletion?.externalDelete === 'external_untouched', `${entry.id} leaves external resources untouched`)
  }
  check(
    entry.deletion?.externalDelete === 'not_applicable' || entry.deletion?.externalDelete === 'external_untouched',
    `${entry.id} external deletion boundary is explicit`
  )
}

function scanPersistenceCandidates(root) {
  const candidates = []
  for (const file of walk(root)) {
    if (!file.endsWith('.ts')) continue
    const text = readFileSync(file, 'utf8')
    if (!hasDurableWrite(text)) continue
    candidates.push(relative(repoRoot, file).replaceAll('\\', '/'))
  }
  return candidates.sort()
}

function hasDurableWrite(text) {
  const fsWriteImport = /import\s*\{[^}]*\b(?:appendFile|appendFileSync|copyFile|copyFileSync|createWriteStream|mkdir|mkdirSync|rename|renameSync|writeFile|writeFileSync)\b[^}]*\}\s*from\s*['"]node:fs(?:\/promises)?['"]/s
  const fileHandleWrite = /from\s*['"]node:fs\/promises['"]/.test(text) && /\b(?:handle|descriptor)\.writeFile\(/.test(text)
  const durableMarker = /(?:app\.getPath\(['"]userData['"]\)|CAOGEN_USER_DATA_DIR|configuredUserDataRoot|STORE_(?:FILE|DIRECTORY)|FILE_NAME|\.json['"`]|\.jsonl['"`]|\.db['"`]|artifact-blobs|effect-artifacts|migration-backups|worktree)/
  return (fsWriteImport.test(text) || fileHandleWrite) && durableMarker.test(text)
}

function walk(root) {
  const files = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) files.push(...walk(path))
    else files.push(path)
  }
  return files
}

async function loadTypeScriptModule(file) {
  const source = readFileSync(file, 'utf8')
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    },
    reportDiagnostics: true
  })
  const diagnostics = output.diagnostics ?? []
  if (diagnostics.length > 0) {
    throw new Error(`Local data map transpile failed: ${diagnostics.map((item) => item.messageText).join('; ')}`)
  }
  const url = `data:text/javascript;base64,${Buffer.from(output.outputText).toString('base64')}`
  return import(url)
}

function check(condition, description) {
  checks.push({ description, passed: Boolean(condition) })
  if (!condition) failures.push(description)
}

function duplicates(values) {
  const seen = new Set()
  const found = new Set()
  for (const value of values) {
    if (seen.has(value)) found.add(value)
    seen.add(value)
  }
  return [...found].sort()
}

function suffix(values) {
  return values.length > 0 ? `: ${values.join(', ')}` : ''
}
