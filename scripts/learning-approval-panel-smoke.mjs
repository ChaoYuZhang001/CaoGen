#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-learning-approval-panel-'))
const outDir = path.join(tempRoot, 'compiled')
const failures = []

try {
  compileComponent()
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const panel = require(findCompiled(outDir, 'LearningApprovalPanel.js'))

  await check('Skill Markdown diff is a reversible transformation of the real before and after text', () => {
    const before = '# Focused Skill\n\nkeep this\nold command\nshared tail\n'
    const after = '# Focused Skill\n\nkeep this\nnew command\nshared tail\n'
    const diff = panel.buildSkillMarkdownDiff(before, after)
    equal(reconstruct(diff, 'added'), before, 'removed/context lines reconstruct previous Markdown')
    equal(reconstruct(diff, 'removed'), after, 'added/context lines reconstruct proposed Markdown')
    assert(diff.some((line) => line.kind === 'removed' && line.text === 'old command'), 'real removed line is missing')
    assert(diff.some((line) => line.kind === 'added' && line.text === 'new command'), 'real added line is missing')
  })

  await check('Skill approval preview renders complete before/after Markdown and the computed diff', () => {
    const previousMarkdown = '# Complete Previous\n\nprevious-only-token\nshared-tail-token\n'
    const proposedMarkdown = '# Complete Proposed\n\nproposed-only-token\nshared-tail-token\n'
    const previous = skillRecord({ id: 'skill-v1', version: 1, status: 'active', markdown: previousMarkdown })
    const proposed = skillRecord({
      id: 'skill-v2',
      version: 2,
      status: 'draft',
      markdown: proposedMarkdown,
      supersedes: previous.id,
      previousDigest: previous.digest
    })
    const html = renderToStaticMarkup(
      React.createElement(panel.LearningChangePreview, { record: proposed, previous })
    )

    assert(html.includes('data-skill-markdown-before="true"'), 'before Markdown surface is missing')
    assert(html.includes('data-skill-markdown-after="true"'), 'after Markdown surface is missing')
    assert(html.includes('data-skill-markdown-diff="true"'), 'computed diff surface is missing')
    assert(html.includes(previousMarkdown), 'complete previous Markdown was truncated or replaced')
    assert(html.includes(proposedMarkdown), 'complete proposed Markdown was truncated or replaced')
    assert(html.includes('- # Complete Previous'), 'rendered diff omitted the real removed heading')
    assert(html.includes('+ # Complete Proposed'), 'rendered diff omitted the real added heading')
    assert(html.includes('focused/SKILL.md'), 'Skill target path is missing from the diff')
  })

  await check('missing predecessor fails visibly instead of fabricating a before diff', () => {
    const proposed = skillRecord({
      id: 'skill-missing-v2',
      version: 2,
      status: 'draft',
      markdown: '# Proposed Without Predecessor\n',
      supersedes: 'missing-v1',
      previousDigest: '1'.repeat(64)
    })
    const html = renderToStaticMarkup(React.createElement(panel.LearningChangePreview, { record: proposed }))
    assert(html.includes('data-skill-diff-unavailable="true"'), 'missing predecessor warning is absent')
    assert(!html.includes('data-skill-markdown-diff="true"'), 'missing predecessor produced a fabricated diff')
    assert(html.includes('# Proposed Without Predecessor'), 'current complete Markdown must remain reviewable')
  })

  await check('new Skill diff uses an empty real predecessor and keeps the complete proposal', () => {
    const proposed = skillRecord({
      id: 'skill-new-v1',
      version: 1,
      status: 'draft',
      markdown: '# Brand New Skill\n\nnew-skill-token\n'
    })
    const html = renderToStaticMarkup(React.createElement(panel.LearningChangePreview, { record: proposed }))
    assert(html.includes('（新建 Skill，无上一版本）'), 'new Skill predecessor state is unclear')
    assert(html.includes('+ # Brand New Skill'), 'new Skill diff must add the real proposal from empty input')
    assert(html.includes('new-skill-token'), 'new Skill complete Markdown is missing')
  })

  if (failures.length > 0) {
    throw new Error(`learningApprovalPanel smoke failed (${failures.length}):\n${failures.map((item) => `- ${item}`).join('\n')}`)
  }
  console.log('learningApprovalPanel smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function skillRecord({ id, version, status, markdown, supersedes, previousDigest }) {
  const digest = String(version).repeat(64)
  return {
    schemaVersion: 1,
    id,
    logicalId: 'focused-skill',
    kind: 'skill',
    project: 'required-smoke-project',
    scope: 'project',
    source: `required-smoke:skill-v${version}`,
    confidence: 0.9,
    digest,
    diff: {
      summary: `Skill v${version}`,
      ...(previousDigest ? { previousDigest } : {}),
      currentDigest: digest,
      changedFields: ['markdown']
    },
    status,
    version,
    ...(supersedes ? { supersedes } : {}),
    actor: { type: 'agent', id: 'required-smoke', source: 'learning-approval-panel' },
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    payload: {
      type: 'skill',
      name: `Focused Skill v${version}`,
      description: 'Synthetic Skill approval preview fixture.',
      markdown,
      relativePath: 'focused/SKILL.md'
    }
  }
}

function reconstruct(diff, excludedKind) {
  return diff
    .filter((line) => line.kind !== excludedKind)
    .map((line) => line.text)
    .join('\n')
}

async function check(name, run) {
  try {
    await run()
    console.log(`ok - ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name}: ${message}`)
    console.error(`not ok - ${name}: ${message}`)
  }
}

function compileComponent() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/renderer/src/components/LearningApprovalPanel.tsx',
      'src/renderer/src/env.d.ts',
      '--outDir',
      outDir,
      '--rootDir',
      'src',
      '--target',
      'ES2022',
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--jsx',
      'react-jsx',
      '--types',
      'node',
      '--lib',
      'ES2022,DOM,DOM.Iterable',
      '--strict',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
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

function equal(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
