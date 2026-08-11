#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-team-recommendation-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  compile('src/main/digital-worker/team-recommendation.ts')
  const api = await import(pathToFileURL(findCompiled(outDir, 'team-recommendation.js')).href)
  const project = {
    id: 'project-team', name: 'Team fixture', kind: 'software', status: 'active', resources: [
      { id: 'safe', kind: 'directory', path: '/tmp/safe', dataClass: 'S2', egressPolicy: 'local_only' },
      { id: 'secret', kind: 'directory', path: '/tmp/secret', dataClass: 'S3', egressPolicy: 'allow' }
    ]
  }
  const goal = {
    id: 'goal-team', projectId: project.id, title: '开发并测试软件', objective: '实现代码并完成独立测试',
    constraints: [], successCriteria: ['构建通过'], forbiddenActions: [], acceptance: [],
    riskLevel: 'high', status: 'planned', updatedAt: 10
  }
  const result = api.recommendDigitalWorkerTeam({
    project, goals: [goal], workItems: [{ id: 'work-team', projectId: project.id, goalId: goal.id, title: '开发功能' }]
  })
  assert(result.roles.length >= 1 && result.roles.length <= 8)
  assert(result.roles.some((role) => role.watercolorRole === 'planner'))
  assert(result.roles.some((role) => role.watercolorRole === 'developer'))
  assert(result.roles.some((role) => role.watercolorRole === 'review-test'))
  assert.deepEqual(result.roles[0].dataScope.deniedDataClasses, ['S3', 'S4'])
  assert(!result.roles.some((role) => role.dataScope.allowedResourceIds.includes('secret')))
  assert.equal(result.digest, api.recommendDigitalWorkerTeam({
    project, goals: [goal], workItems: [{ id: 'work-team', projectId: project.id, goalId: goal.id, title: '开发功能' }]
  }).digest)
  console.log('team recommendation smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile(entry) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), entry,
    '--outDir', outDir, '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node', '--skipLibCheck', '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function findCompiled(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, name) } catch { /* continue */ }
    } else if (entry.name === name) return full
  }
  throw new Error(`compiled ${name} not found`)
}
