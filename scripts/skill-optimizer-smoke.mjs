import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-skill-optimizer-'))
const outDir = path.join(tempRoot, 'compiled')
const projectRoot = path.join(tempRoot, 'project')

try {
  mkdirSync(path.join(projectRoot, '.caogen', 'skills', 'tailwind-config'), { recursive: true })
  const skillPath = path.join(projectRoot, '.caogen', 'skills', 'tailwind-config', 'SKILL.md')
  writeFileSync(
    skillPath,
    [
      '---',
      'name: Tailwind Config Builder',
      'description: Add or repair Tailwind configuration.',
      'trigger: tailwind config frontend styles',
      'tags: [tailwind, frontend]',
      '---',
      '',
      '# Tailwind Config Builder',
      '',
      '## Steps',
      '1. Inspect package.json and existing Tailwind files.',
      '2. Update tailwind.config.',
      '',
      '## Verification',
      '1. npm.cmd run typecheck'
    ].join('\n'),
    'utf8'
  )

  compile(
    [
      'src/main/skill/skill-loader.ts',
      'src/main/skill/skill-tester.ts',
      'src/main/skill/skill-manager.ts',
      'src/main/skill/skill-optimizer.ts'
    ],
    outDir
  )

  const optimizer = await import(pathToFileURL(findCompiled(outDir, 'skill-optimizer.js')).href)
  const lifecycle = await import(pathToFileURL(findCompiled(outDir, 'learning-lifecycle.js')).href)
  const security = await import(pathToFileURL(findCompiled(outDir, 'learning-security.js')).href)
  const learningRoot = path.join(projectRoot, '.caogen', 'learning-state')
  const authority = (action) => security.createTrustedUserLearningDecision(`skill-optimizer-smoke:${action}`)
  const originalMarkdown = readFileSync(skillPath, 'utf8')

  const firstFailure = await optimizer.recordSkillFeedback({
    projectRoot,
    skillIdOrName: 'Tailwind Config Builder',
    outcome: 'failed',
    summary: 'First run failed because PostCSS config was not checked.',
    correctionSteps: ['Check postcss.config.js before editing Tailwind config.'],
    verification: ['npm.cmd run build'],
    occurredAt: Date.UTC(2026, 6, 7, 1, 0, 0),
    failureThreshold: 2
  })
  assertEqual(firstFailure.status, 'recorded')
  assert(!readFileSync(skillPath, 'utf8').includes('自动优化记录'), 'first failure should only record feedback')

  const secondFailureInput = {
    projectRoot,
    skillIdOrName: 'Tailwind Config Builder',
    outcome: 'failed',
    summary: 'Second run failed because CSS entry file did not import Tailwind layers.',
    correctionSteps: ['Verify the CSS entry imports Tailwind layers.'],
    verification: ['npm.cmd run build'],
    occurredAt: Date.UTC(2026, 6, 7, 1, 1, 0),
    failureThreshold: 2
  }
  const secondFailure = await optimizer.recordSkillFeedback(secondFailureInput)
  assertEqual(secondFailure.status, 'drafted')
  assertEqual(secondFailure.applied, false)
  assertEqual(readFileSync(skillPath, 'utf8'), originalMarkdown)
  let snapshot = await lifecycle.listLearningProject(projectRoot, learningRoot)
  const failureDraft = snapshot.drafts.find((record) => record.id === secondFailure.draftId)
  assert(failureDraft?.payload.type === 'skill', 'failure threshold should create a persisted Skill draft')
  assert(failureDraft.payload.markdown.includes('PostCSS config'), 'draft should include first failure feedback')
  assert(failureDraft.payload.markdown.includes('CSS entry'), 'draft should include second failure feedback')

  await lifecycle.rejectLearningDraft(projectRoot, learningRoot, failureDraft.id, authority('reject-failure-draft'))
  const retriedFailure = await optimizer.recordSkillFeedback(secondFailureInput)
  assertEqual(retriedFailure.status, 'drafted')
  assert(retriedFailure.draftId !== failureDraft.id, 'rejected optimization must be re-proposable as a new draft')
  assertEqual(readFileSync(skillPath, 'utf8'), originalMarkdown)

  const correctionInput = {
    projectRoot,
    skillIdOrName: 'Tailwind Config Builder',
    summary: 'User correction: also update content globs for src/pages.',
    correctionSteps: ['Include src/pages/**/* in Tailwind content globs.'],
    verification: ['npm.cmd run typecheck'],
    occurredAt: Date.UTC(2026, 6, 7, 1, 2, 0)
  }
  const correction = await optimizer.applySkillCorrection(correctionInput)
  assertEqual(correction.status, 'drafted')
  assertEqual(readFileSync(skillPath, 'utf8'), originalMarkdown)
  snapshot = await lifecycle.listLearningProject(projectRoot, learningRoot)
  const correctionDraft = snapshot.drafts.find((record) => record.id === correction.draftId)
  assert(correctionDraft?.payload.type === 'skill', 'user correction should create a persisted Skill draft')
  assert(correctionDraft.payload.markdown.includes('src/pages/**/*'), 'user correction should be present in the draft')

  await lifecycle.deleteLearningRecord(projectRoot, learningRoot, correctionDraft.id, authority('delete-correction-draft'))
  const retriedCorrection = await optimizer.applySkillCorrection(correctionInput)
  assertEqual(retriedCorrection.status, 'drafted')
  assert(retriedCorrection.draftId !== correctionDraft.id, 'deleted optimization must be re-proposable as a new draft')
  assertEqual(readFileSync(skillPath, 'utf8'), originalMarkdown)

  const feedbackPath = path.join(path.dirname(skillPath), 'skill-feedback.json')
  assert(existsSync(feedbackPath), 'feedback store should be persisted next to project skill')
  const feedback = JSON.parse(readFileSync(feedbackPath, 'utf8'))
  assert(feedback.records.length === 3, 'feedback store should keep all records')

  const builtin = await optimizer.recordSkillFeedback({
    projectRoot,
    skillIdOrName: 'Release 检查',
    outcome: 'corrected',
    summary: 'Do not mutate builtin skills.',
    correctionSteps: ['No write'],
    verification: []
  })
  assertEqual(builtin.status, 'not_project_skill')

  console.log('skillOptimizer smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile(files, outDir) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files,
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck',
      '--esModuleInterop',
      '--strict'
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
  throw new Error(`compiled file not found: ${fileName}`)
}

function findCompiledOptional(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
