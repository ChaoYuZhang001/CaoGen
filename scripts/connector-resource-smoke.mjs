#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-connector-resource-'))
const outDir = path.join(tempRoot, 'compiled')
try {
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/project-workspace/connector-resource.ts', '--outDir', outDir, '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node', '--skipLibCheck'], { cwd: repoRoot, stdio: 'inherit' })
  const api = await import(pathToFileURL(findCompiled(outDir, 'connector-resource.js')).href)
  const resource = {
    id: 'connector-resource', kind: 'connector', connector: {
      schemaVersion: 1, usage: ['resource', 'knowledge_source', 'tool'], capabilities: ['read', 'write'], dataDirection: 'bidirectional',
      authorization: { subject: 'personal', principalId: 'user-1', scopes: ['records:read', 'records:write'], status: 'active' }, version: 'v1',
      revocation: { behavior: 'deny_new_operations', purgeCachedData: true }, writePolicy: { effect: 'required', reconciliation: 'manual_only' }
    }
  }
  assert.deepEqual(api.connectorResourceAvailability(resource), { available: true })
  assert(api.connectorSupportsRead(resource) && api.connectorSupportsWrite(resource))
  const read = api.createConnectorReadResult(resource, 'project-connector', { data: { id: 1 }, source: 'mock://records/1', version: 'v1', retrievedAt: 10 })
  assert.equal(read.citation.projectId, 'project-connector')
  assert.equal(read.citation.version, 'v1')
  assert.match(read.citation.contentDigest, /^sha256:[a-f0-9]{64}$/)
  api.assertConnectorWriteExecution(resource, { projectId: 'project-connector', effectId: 'effect-1', reconciliation: 'manual_only' })
  const revoked = { ...resource, connector: { ...resource.connector, authorization: { ...resource.connector.authorization, status: 'revoked', revokedAt: 20 } } }
  assert.equal(api.connectorResourceAvailability(revoked).available, false)
  assert.throws(() => api.createConnectorReadResult(revoked, 'project-connector', { data: {}, source: 'mock', version: 'v1' }), /not authorized/)
  console.log('connector resource smoke ok')
} finally { rmSync(tempRoot, { recursive: true, force: true }) }

function findCompiled(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) { try { return findCompiled(full, name) } catch { /* continue */ } }
    else if (entry.name === name) return full
  }
  throw new Error(`compiled ${name} not found`)
}
