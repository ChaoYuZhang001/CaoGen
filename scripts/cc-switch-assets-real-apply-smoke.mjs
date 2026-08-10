#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const sourceRoot = path.join(homedir(), '.cc-switch')
const databasePath = path.join(sourceRoot, 'cc-switch.db')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-cc-switch-assets-real-apply-'))
const outDir = path.join(tempRoot, 'compiled')
const isolatedHome = path.join(tempRoot, 'home')
const isolatedSource = path.join(isolatedHome, '.cc-switch')
const backupRoot = path.join(tempRoot, 'backups')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'cc-switch-assets-real-apply', runId)
const checks = []

try {
  if (!existsSync(databasePath)) throw new Error('CC Switch database is not installed')
  const sourceBefore = databaseIdentity()
  compile()
  mkdirSync(isolatedHome, { recursive: true })
  cpSync(sourceRoot, isolatedSource, { recursive: true, dereference: false })
  const migration = await import(pathToFileURL(findCompiled('migration.js')).href)

  const scan = migration.scanMigration(undefined, isolatedHome)
  const assets = scan.assets.filter((asset) => asset.agent === 'CC Switch')
  const selected = assets.filter((asset) => asset.importable)
  assert(selected.length > 0, 'real CC Switch sample contains importable assets')
  assert(selected.every((asset) => isWithin(isolatedHome, asset.targetPath)),
    'every real asset target is contained in the isolated home')
  assert(assets.filter((asset) => !asset.importable).every((asset) => asset.risk === 'blocked' || asset.action === 'skip'),
    'non-importable real assets remain blocked or skipped')

  const applied = migration.applyMigration({
    scanId: scan.scanId,
    decisions: assets.map((asset) => ({ assetId: asset.id, action: asset.importable ? 'import' : 'skip' }))
  }, { backupRoot })
  assert(applied.ok && applied.status === 'applied', 'real safe assets apply as one isolated batch')
  equal(applied.applied.length, selected.length, 'real apply count matches the importable preview')
  assert(selected.every((asset) => existsSync(asset.targetPath)), 'every selected real asset target exists after apply')
  assert(existsSync(path.join(backupRoot, applied.backupId)), 'real asset apply creates a private rollback batch')

  const targetText = selected.flatMap((asset) => readTargetText(asset.targetPath)).join('\n')
  assert(!/"env"\s*:/i.test(targetText), 'real asset targets exclude MCP environment credential maps')
  assert(!/OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY/i.test(targetText),
    'real asset targets exclude known credential field names')

  const rolledBack = migration.rollbackMigration(applied.backupId, backupRoot)
  assert(rolledBack.ok, 'real asset batch rollback succeeds')
  assert(selected.every((asset) => !existsSync(asset.targetPath)), 'real asset rollback removes all created targets')
  equal(databaseIdentity(), sourceBefore, 'source CC Switch database remains byte-identical after asset apply and rollback')

  const report = {
    generatedAt: new Date().toISOString(),
    status: 'passed',
    sourceDatabaseUnchanged: true,
    assetCount: assets.length,
    importableCount: selected.length,
    appliedCount: applied.applied.length,
    kinds: countBy(assets, (asset) => asset.kind),
    rollbackRemovedTargets: true,
    checks
  }
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`CC Switch real isolated asset apply passed: ${checks.length}/${checks.length}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/migration.ts', '--outDir', outDir,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--types', 'node', '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function readTargetText(targetPath) {
  if (!existsSync(targetPath)) return []
  const info = statSync(targetPath)
  if (info.isFile()) return info.size <= 8 * 1024 * 1024 ? [readFileSync(targetPath, 'utf8')] : []
  const values = []
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    values.push(...readTargetText(path.join(targetPath, entry.name)))
  }
  return values
}

function databaseIdentity() {
  const stat = statSync(databasePath)
  return `${stat.size}:${stat.mtimeMs}:${createHash('sha256').update(readFileSync(databasePath)).digest('hex')}`
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function countBy(values, keyOf) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = keyOf(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return counts
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)))
}

function findCompiled(fileName) {
  const queue = [outDir]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(candidate)
      else if (entry.name === fileName) return candidate
    }
  }
  throw new Error(`compiled module missing: ${fileName}`)
}

function assert(condition, message) {
  checks.push({ name: message, status: condition ? 'pass' : 'fail' })
  if (!condition) throw new Error(message)
}

function equal(actual, expected, message) {
  assert(Object.is(actual, expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
