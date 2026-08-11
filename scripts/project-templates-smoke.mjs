#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-templates-'))
const outDir = path.join(tempRoot, 'compiled')
try {
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/shared/project-workspace-templates.ts', '--outDir', outDir, '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node', '--skipLibCheck'], { cwd: repoRoot, stdio: 'inherit' })
  const api = await import(pathToFileURL(findCompiled(outDir, 'project-workspace-templates.js')).href)
  const templates = api.listProjectWorkspaceTemplates()
  assert.deepEqual(templates.map((item) => item.id).sort(), ['custom', 'education', 'office', 'opc', 'personal', 'research', 'software'])
  for (const template of templates) {
    assert(template.goal.acceptance.length > 0, `${template.id} requires Acceptance draft`)
    assert(template.workItems.length > 0, `${template.id} requires WorkItem presets`)
    assert(template.workItems.every((item) => item.expectedArtifactKinds.length > 0), `${template.id} requires Artifact kinds`)
    assert(template.resourceSuggestions.every((resource) => resource.egressPolicy !== 'allow' || resource.dataClass !== 'S3'), `${template.id} must deny S3 egress`)
    const clone = api.projectWorkspaceTemplate(template.id)
    clone.goal.title = 'mutated'
    assert.notEqual(api.projectWorkspaceTemplate(template.id).goal.title, 'mutated', `${template.id} must return an isolated clone`)
  }
  console.log('project templates smoke ok')
} finally { rmSync(tempRoot, { recursive: true, force: true }) }

function findCompiled(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) { try { return findCompiled(full, name) } catch { /* continue */ } }
    else if (entry.name === name) return full
  }
  throw new Error(`compiled ${name} not found`)
}
