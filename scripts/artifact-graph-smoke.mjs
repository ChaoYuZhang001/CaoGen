import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-artifact-graph-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
mkdirSync(userData, { recursive: true })

try {
  compileSources()
  installElectronStub()
  const workflowApi = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-api.js')).href)
  const graphApi = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-artifact-graph-api.js')).href)
  const graph = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-artifact-graph.js')).href)

  const source = await workflowApi.createWorkflowArtifact({
    id: 'artifact-source', projectId: 'project-1', kind: 'source', title: 'Source', digest: 'sha256:source'
  }, userData)
  const report = await workflowApi.createWorkflowArtifact({
    id: 'artifact-report', projectId: 'project-1', kind: 'report', title: 'Report', digest: 'sha256:report'
  }, userData)
  const foreign = await workflowApi.createWorkflowArtifact({
    id: 'artifact-foreign', projectId: 'project-2', kind: 'source', title: 'Foreign', digest: 'sha256:foreign'
  }, userData)
  // Deliberately collide with the synthetic graph-event namespace. Ledger
  // verification must resolve the graph row before this ordinary Artifact.
  await workflowApi.createWorkflowArtifact({
    id: 'artifact-edge:shadow', projectId: 'project-1', kind: 'custom', title: 'Synthetic ID shadow', digest: 'sha256:shadow'
  }, userData)

  const edge = await graphApi.createPersistedWorkflowArtifactEdge({
    id: 'shadow', fromArtifactId: source.id, toArtifactId: report.id,
    projectId: 'project-1', relation: 'derived_from', metadata: { stage: 'smoke' }, createdAt: 10
  }, userData)
  const secondEdge = await graphApi.createPersistedWorkflowArtifactEdge({
    id: 'edge-report-source', fromArtifactId: report.id, toArtifactId: source.id,
    projectId: 'project-1', relation: 'supports', createdAt: 11
  }, userData)
  const location = await graphApi.createPersistedWorkflowArtifactLocation({
    id: 'location-report', artifactId: report.id, projectId: 'project-1', kind: 'file',
    path: '/tmp/caogen-report.json', availability: 'available', checksum: 'sha256:report', createdAt: 12
  }, userData)
  assertEqual(edge.id, 'shadow', 'edge write must return stable ID')
  assertEqual(location.artifactId, report.id, 'location must retain Artifact ownership')

  const edgePage = await graphApi.listPersistedWorkflowArtifactEdges({ projectId: 'project-1', limit: 1 }, userData)
  assertEqual(edgePage.items.length, 1, 'edge query must honor page size')
  assert(edgePage.hasMore && edgePage.nextCursor, 'edge query must return cursor')
  const nextEdgePage = await graphApi.listPersistedWorkflowArtifactEdges({ projectId: 'project-1', limit: 1, cursor: edgePage.nextCursor }, userData)
  assertEqual(nextEdgePage.items[0].id, secondEdge.id, 'edge cursor must advance deterministically')
  const locations = await graphApi.listPersistedWorkflowArtifactLocations({ artifactId: report.id }, userData)
  assertEqual(locations.total, 1, 'location query must filter by Artifact')
  const neighborhood = await graphApi.queryPersistedWorkflowArtifactGraph(report.id, userData)
  assertEqual(neighborhood.inbound.length, 1, 'neighborhood must expose inbound edge')
  assertEqual(neighborhood.outbound.length, 1, 'neighborhood must expose outbound edge')
  assertEqual(neighborhood.locations.length, 1, 'neighborhood must expose locations')
  const verification = await graphApi.verifyPersistedWorkflowArtifactGraph(userData)
  assert(verification.valid && verification.edges === 2 && verification.locations === 1, 'graph verification must cover rows and events')

  await assertRejects(
    graphApi.createPersistedWorkflowArtifactEdge({
      id: 'edge-cross-project', fromArtifactId: source.id, toArtifactId: foreign.id,
      projectId: 'project-1', relation: 'references', createdAt: 20
    }, userData),
    (error) => String(error).includes('project boundary'),
    'cross-project edge must fail closed'
  )
  await assertRejects(
    graphApi.createPersistedWorkflowArtifactLocation({
      id: 'location-cross-project', artifactId: report.id, projectId: 'project-2',
      kind: 'file', path: '/tmp/foreign', createdAt: 21
    }, userData),
    (error) => String(error).includes('project ownership'),
    'cross-project location must fail closed'
  )
  await assertRejects(
    graphApi.createPersistedWorkflowArtifactEdge({
      id: 'edge-self', fromArtifactId: source.id, toArtifactId: source.id,
      projectId: 'project-1', relation: 'references', createdAt: 22
    }, userData),
    (error) => String(error).includes('itself'),
    'self edge must fail closed'
  )
  await assertRejects(
    graphApi.createPersistedWorkflowArtifactLocation({
      id: 'location-secret', artifactId: report.id, projectId: 'project-1',
      kind: 'url', uri: 'https://user:token@example.test/report', createdAt: 23
    }, userData),
    (error) => String(error).includes('credential') || String(error).includes('secret'),
    'credential-bearing location must fail closed'
  )

  let originalLocationState
  await tamperDatabase(path.join(userData, 'task-snapshots.db'), (db) => {
    const row = db.exec(
      'SELECT project_id, payload FROM workflow_artifact_locations WHERE id = ?',
      ['location-report']
    )[0]?.values[0]
    assert(row && typeof row[0] === 'string' && typeof row[1] === 'string', 'location tamper fixture must find row')
    originalLocationState = row
    const payload = JSON.parse(row[1])
    payload.projectId = 'project-2'
    db.run(
      'UPDATE workflow_artifact_locations SET project_id = ?, payload = ? WHERE id = ?',
      ['project-2', JSON.stringify(payload), 'location-report']
    )
  })
  await assertRejects(
    workflowApi.verifyPersistedWorkflowLedger(userData),
    (error) => String(error).includes('project ownership') || String(error).includes('project boundary') ||
      String(error).includes('artifact location') || String(error).includes('event payload'),
    'tampered location project ownership must fail closed'
  )
  await tamperDatabase(path.join(userData, 'task-snapshots.db'), (db) => {
    assert(Array.isArray(originalLocationState), 'location tamper fixture must be restorable')
    db.run(
      'UPDATE workflow_artifact_locations SET project_id = ?, payload = ? WHERE id = ?',
      [originalLocationState[0], originalLocationState[1], 'location-report']
    )
  })

  await tamperDatabase(path.join(userData, 'task-snapshots.db'), (db) => {
    const row = db.exec('SELECT payload FROM workflow_artifact_edges WHERE id = ?', ['shadow'])[0]?.values[0]
    assert(row && typeof row[0] === 'string', 'tamper fixture must find edge payload')
    const payload = JSON.parse(row[0])
    payload.relation = 'supports'
    db.run('UPDATE workflow_artifact_edges SET relation = ?, payload = ? WHERE id = ?', ['supports', JSON.stringify(payload), 'shadow'])
  })
  await assertRejects(
    workflowApi.verifyPersistedWorkflowLedger(userData),
    (error) => String(error).includes('event payload') || String(error).includes('payload does not match'),
    'synthetic graph ID collision must still fail closed through event verification'
  )

  console.log('artifact graph smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/task-snapshot.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/workflow-ledger-artifact-graph-api.ts',
    '--outDir', outDir, '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node', '--skipLibCheck', '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(root, name) {
  const found = findCompiledModuleInTree(root, name)
  if (!found) throw new Error(`compiled ${name} not found under ${root}`)
  return found
}

function findCompiledModuleInTree(root, name) {
  for (const entry of require('node:fs').readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleInTree(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) return fullPath
  }
  return null
}

async function tamperDatabase(dbPath, mutator) {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({ locateFile: (file) => file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file })
  const db = new SQL.Database(readFileSync(dbPath))
  try {
    mutator(db)
    writeFileSync(dbPath, db.export())
  } finally {
    db.close()
  }
}

async function assertRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected error ${error instanceof Error ? error.stack : String(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
