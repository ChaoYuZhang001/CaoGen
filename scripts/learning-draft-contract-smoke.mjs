#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-learning-draft-contract-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataRoot = path.join(tempRoot, 'user-data')
const learningRoot = path.join(userDataRoot, 'learning')
const memoryRoot = path.join(userDataRoot, 'memory')
const projectRoot = path.join(tempRoot, 'project-a')
const otherProjectRoot = path.join(tempRoot, 'project-b')
const failures = []

process.env.CAOGEN_USER_DATA_DIR = userDataRoot
process.env.CAOGEN_MEMORY_DIR = memoryRoot

try {
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(otherProjectRoot, { recursive: true })
  compile([
    'src/main/learning/learning-lifecycle.ts',
    'src/main/memoryStore.ts',
    'src/main/memory/memory-writer.ts',
    'src/main/skill/auto-skill-review.ts',
    'src/main/openaiTools.ts'
  ])

  const lifecycle = await loadCompiled('learning-lifecycle.js')
  const learningStore = await loadCompiled('learning-store.js')
  const memoryStore = await loadCompiled('memoryStore.js')
  const autoSkillReview = await loadCompiled('auto-skill-review.js')
  const codingTools = await loadCompiled('openaiTools.js')
  const memoryWriter = await loadCompiled('memory-writer.js')
  const layeredMemory = await loadCompiled('memory-manager.js')

  const memoryDraft = await memoryStore.proposeMemoryDraft(
    projectRoot,
    memoryRoot,
    {
      kind: 'workflow-preference',
      title: 'Run focused verification first',
      body: 'Run the smallest required smoke before the complete Deep gate.',
      source: 'memory-loop:turn-result',
      reason: 'A repeated project workflow was observed.'
    },
    {
      confidence: 0.73,
      actor: { type: 'agent', id: 'memory-loop', source: 'session-review' }
    }
  )
  const skillDraft = await lifecycle.createLearningDraft(
    projectRoot,
    learningRoot,
    {
      kind: 'skill',
      source: 'auto-skill-review:turn-result',
      confidence: 0.88,
      payload: {
        type: 'skill',
        name: 'Focused Verification',
        description: 'Run a focused required smoke before the complete gate.',
        markdown: skillMarkdown('Focused Verification', 'npm run test:learning-draft-contract:required'),
        relativePath: 'focused-verification/SKILL.md'
      }
    },
    { actor: { type: 'runtime', id: 'auto-skill-review', source: 'turn-result' } }
  )

  const snapshot = await lifecycle.listLearningProject(projectRoot, learningRoot)
  const memoryRecord = requiredRecord(snapshot, memoryDraft.id)
  const skillRecord = requiredRecord(snapshot, skillDraft.id)

  await check('Memory and Skill drafts retain provenance, confidence, diff, and project scope', async () => {
    assertDraftContract(memoryRecord, {
      kind: 'memory',
      source: 'memory-loop:turn-result',
      confidence: 0.73,
      actorId: 'memory-loop',
      actorSource: 'session-review',
      project: learningStore.learningProjectHash(projectRoot)
    })
    assertDraftContract(skillRecord, {
      kind: 'skill',
      source: 'auto-skill-review:turn-result',
      confidence: 0.88,
      actorId: 'auto-skill-review',
      actorSource: 'turn-result',
      project: learningStore.learningProjectHash(projectRoot)
    })
  })

  await check('unapproved Memory and Skill drafts have zero active materialization', async () => {
    const memory = await memoryStore.readProjectMemory(projectRoot, memoryRoot)
    equal(memory.entries.length, 0, 'unapproved Memory must not enter confirmed entries')
    equal(memory.drafts.length, 1, 'Memory proposal must remain reviewable as a draft')
    assert(!memory.markdown.includes(memoryRecord.payload.title), 'unapproved Memory must not enter prompt markdown')
    assert(!existsSync(path.join(projectRoot, '.caogen', 'skills', skillRecord.payload.relativePath)), 'unapproved Skill must not be written')
    equal(snapshot.active.length, 0, 'no draft may be active before a trusted decision')
  })

  await check('project-scoped drafts remain isolated', async () => {
    const other = await lifecycle.createLearningDraft(
      otherProjectRoot,
      learningRoot,
      {
        kind: 'memory',
        source: 'memory-loop:turn-result',
        confidence: 0.73,
        payload: {
          type: 'memory',
          memoryKind: 'workflow-preference',
          title: 'Project B only',
          body: 'This draft must never appear in project A.',
          reason: 'Isolation contract fixture.'
        }
      }
    )
    const projectA = await lifecycle.listLearningProject(projectRoot, learningRoot)
    const projectB = await lifecycle.listLearningProject(otherProjectRoot, learningRoot)
    assert(!projectA.records.some((record) => record.id === other.id), 'project A leaked a project B draft')
    assert(projectB.records.some((record) => record.id === other.id), 'project B draft was not persisted in its own state')
    assert(projectA.project !== projectB.project, 'project state hashes must differ')
  })

  await check('auto Skill review dynamically creates a complete draft with zero SKILL.md writes', async () => {
    const result = await autoSkillReview.runAutoSkillReview(
      {
        meta: {
          id: 'auto-review-session',
          title: 'Automatic Learning Review',
          cwd: projectRoot,
          model: '',
          providerId: '',
          permissionMode: 'default',
          status: 'idle',
          costUsd: 0,
          usage: { input: 10, output: 8, cacheRead: 0, cacheCreation: 0 },
          contextTokens: 18,
          createdAt: Date.UTC(2026, 6, 22, 1, 0, 0)
        },
        transcript: [
          {
            seq: 1,
            event: {
              kind: 'user-message',
              text: 'Extract a reusable verification workflow, keep it pending user review, and never activate it automatically.'
            }
          },
          {
            seq: 2,
            event: {
              kind: 'assistant-message',
              blocks: [{ type: 'text', text: 'Generated a reviewable Skill proposal with focused verification evidence and no active write.' }]
            }
          },
          {
            seq: 3,
            event: {
              kind: 'tool-result',
              toolUseId: 'required-smoke',
              content: 'focused required smoke passed with synthetic evidence',
              isError: false
            }
          }
        ],
        event: {
          kind: 'turn-result',
          subtype: 'success',
          isError: false,
          resultText: 'The workflow was verified and is ready for explicit user review.',
          durationMs: 1200
        }
      },
      { enabled: true, now: () => Date.UTC(2026, 6, 22, 1, 1, 0) }
    )

    equal(result.status, 'drafted', 'auto review result status')
    equal(result.draftStatus, 'draft', 'auto review draft status')
    assert(typeof result.draftId === 'string' && result.draftId.length > 0, 'auto review draft id is required')
    assert(typeof result.materializationPath === 'string', 'auto review must disclose its intended materialization path')
    assert(!existsSync(result.materializationPath), 'auto review wrote SKILL.md before approval')
    assert(findNamedFiles(path.join(projectRoot, '.caogen', 'skills'), 'SKILL.md').length === 0, 'auto review created a project Skill file before approval')

    const after = await lifecycle.listLearningProject(projectRoot, learningRoot)
    const record = requiredRecord(after, result.draftId)
    assertDraftContract(record, {
      kind: 'skill',
      source: 'auto-skill-review:auto-review-session',
      confidence: 0.8,
      actorId: 'auto-skill-review',
      actorSource: 'session:auto-review-session',
      project: learningStore.learningProjectHash(projectRoot)
    })
    equal(record.payload.relativePath, path.relative(path.join(projectRoot, '.caogen', 'skills'), result.materializationPath).split('\\').join('/'), 'auto review materialization target')
  })

  await check('optimize_skill production entry creates a review draft without mutating SKILL.md', async () => {
    const skillDir = path.join(projectRoot, '.caogen', 'skills', 'existing-skill')
    const skillPath = path.join(skillDir, 'SKILL.md')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillPath, skillMarkdown('Existing Skill', 'npm run typecheck'), 'utf8')
    const beforeMarkdown = readFileSync(skillPath, 'utf8')
    const beforeIds = new Set(readPersistedLearningRecords(tempRoot).map((record) => record.id))

    const result = await codingTools.executeCodingTool(
      'optimize_skill',
      {
        id: 'Existing Skill',
        outcome: 'corrected',
        summary: 'User correction requires a focused required smoke before Deep.',
        correctionSteps: ['Run the focused required smoke first.'],
        verification: ['npm run test:learning-draft-contract:required']
      },
      projectRoot
    )

    equal(result.ok, true, 'optimize_skill should successfully propose a review draft')
    equal(readFileSync(skillPath, 'utf8'), beforeMarkdown, 'optimize_skill must not mutate active SKILL.md before approval')

    const output = parseJsonObject(result.output)
    const candidates = [
      ...findDraftRecords(output),
      ...readPersistedLearningRecords(tempRoot).filter((record) => !beforeIds.has(record.id))
    ]
    const proposed = candidates.find((record) => record.kind === 'skill' && record.status === 'draft')
    assert(proposed, `optimize_skill did not return or persist a Skill draft: ${result.output}`)
    assertDraftContract(proposed, {
      kind: 'skill',
      project: learningStore.learningProjectHash(projectRoot)
    })
    assert(!candidates.some((record) => record.kind === 'skill' && record.status === 'active'), 'optimize_skill activated a Skill without approval')
  })

  await check('optimize_skill and auto review are statically bound to draft-only learning paths', async () => {
    const p2Source = readFileSync(path.join(repoRoot, 'src/main/agent/tools/p2-tools.ts'), 'utf8')
    const optimizeBranch = between(p2Source, "if (name === 'optimize_skill')", "if (name === 'route_model')")
    const optimizerSource = readFileSync(path.join(repoRoot, 'src/main/skill/skill-optimizer.ts'), 'utf8')
    const directDraftBinding = /createLearningDraft|proposeSkill(?:Learning|Optimization)|draftSkillOptimization|queueSkillLearning/i.test(optimizeBranch)
    const delegatedDraftBinding = /recordSkillFeedback\s*\(/.test(optimizeBranch) && /createLearningDraft\s*\(/.test(optimizerSource)
    assert(directDraftBinding || delegatedDraftBinding, 'optimize_skill is not wired to a Learning draft proposal')
    assert(!/writeTextAtomically\s*\(\s*skillPath/.test(optimizerSource), 'Skill optimizer still writes active SKILL.md directly')

    const optimizeDefinition = between(p2Source, "name: 'optimize_skill'", "name: 'route_model'")
    assert(/draft|approval|approve|pending|review|草稿|审批|批准|待确认/i.test(optimizeDefinition), 'optimize_skill contract does not disclose pending user approval')

    const autoReviewSource = readFileSync(path.join(repoRoot, 'src/main/skill/auto-skill-review.ts'), 'utf8')
    assert(/createLearningDraft|proposeSkill(?:Learning|Review)/i.test(autoReviewSource), 'auto Skill review is not wired to the Learning draft lifecycle')
    assert(!/writeSkillAtomically\s*\(/.test(autoReviewSource), 'auto Skill review still materializes SKILL.md directly')
  })

  await check('automatic and model Memory ingress create drafts without active layered writes', async () => {
    const beforeActive = await layeredMemory.listMemories(memoryRoot)
    const extracted = await memoryWriter.writeExtractedMemory({
      rootDir: memoryRoot,
      projectRoot,
      text: '记住: 自动提取的长期约定必须先进入审批草稿，不能直接生效。',
      source: 'required-smoke:auto-extract',
      defaultLayer: 'project'
    })
    assertDraftContract(requiredRecord(await lifecycle.listLearningProject(projectRoot, learningRoot), extracted.id), {
      kind: 'memory',
      source: 'required-smoke:auto-extract',
      confidence: 0.8,
      actorId: 'memory-auto-extract',
      project: learningStore.learningProjectHash(projectRoot)
    })

    const proposed = await codingTools.executeCodingTool('memory_add', {
      layer: 'project',
      title: 'Model-proposed required rule',
      body: 'Model-proposed memories remain inactive until a trusted user approves them.',
      source: 'required-smoke:model',
      tags: ['approval']
    }, projectRoot)
    equal(proposed.ok, true, 'model memory_add should create a draft')
    const proposedRecord = parseJsonObject(proposed.output)
    assertDraftContract(proposedRecord, {
      kind: 'memory',
      source: 'openai-tool:memory_add',
      confidence: 0.7,
      actorId: 'openai-tool',
      actorSource: 'memory_add',
      project: learningStore.learningProjectHash(projectRoot)
    })
    const afterActive = await layeredMemory.listMemories(memoryRoot)
    equal(afterActive.length, beforeActive.length, 'unapproved Memory ingress must not mutate active layered memory')
  })

  await check('Learning IPC mints trusted authority in main and preload exposes ids only', async () => {
    const ipcSource = readFileSync(path.join(repoRoot, 'src/main/ipc/learning-handlers.ts'), 'utf8')
    const preloadSource = readFileSync(path.join(repoRoot, 'src/preload/learning.ts'), 'utf8')
    const learningTypes = readFileSync(path.join(repoRoot, 'src/shared/learning-types.ts'), 'utf8')
    assert(/listLearning:\s*\(sessionId:\s*string\)\s*=>\s*ipcRenderer\.invoke\('learning:list',\s*sessionId\)/s.test(preloadSource), 'preload Learning list must pass only sessionId')

    for (const action of ['approve', 'reject', 'rollback', 'revoke', 'delete']) {
      const handler = ipcHandler(ipcSource, action)
      assert(new RegExp(`decision\\('${action}'\\)`).test(handler), `learning:${action} does not mint trusted authority inside main IPC`)
      assert(!/\b(actor|authority)\s*[:,]/i.test(handler), `learning:${action} accepts renderer-controlled actor or authority data`)

      const method = `${action}Learning`
      const preloadPattern = new RegExp(`${method}:\\s*\\(sessionId:\\s*string,\\s*recordId:\\s*string\\)\\s*=>\\s*ipcRenderer\\.invoke\\('learning:${action}',\\s*sessionId,\\s*recordId\\)`, 's')
      assert(preloadPattern.test(preloadSource), `${method} preload contract must pass only sessionId and recordId`)
    }

    const apiBlock = between(learningTypes, 'export interface LearningApi', '\n}')
    assert(!/\b(actor|authority)\b/i.test(apiBlock), 'renderer Learning API exposes actor or authority input')
  })

  if (failures.length > 0) {
    throw new Error(`learningDraftContract smoke failed (${failures.length}):\n${failures.map((item) => `- ${item}`).join('\n')}`)
  }
  console.log('learningDraftContract smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertDraftContract(record, expected) {
  assert(record && typeof record === 'object', 'Learning draft record is missing')
  equal(record.schemaVersion, 1, 'Learning schema version')
  equal(record.status, 'draft', 'Learning proposal status')
  equal(record.scope, 'project', 'Learning proposal scope')
  assertExpectedDraftFields(record, expected)
  assertDraftIdentity(record)
  assertDraftDiff(record)
  equal(record.payload?.type, record.kind, 'Learning payload kind must match the record kind')
}

function assertExpectedDraftFields(record, expected) {
  if (expected.kind) equal(record.kind, expected.kind, 'Learning proposal kind')
  if (expected.source) equal(record.source, expected.source, 'Learning proposal source')
  if (expected.confidence !== undefined) equal(record.confidence, expected.confidence, 'Learning confidence')
  if (expected.project) equal(record.project, expected.project, 'Learning project identity')
  if (expected.actorId) equal(record.actor?.id, expected.actorId, 'Learning actor id')
  if (expected.actorSource) equal(record.actor?.source, expected.actorSource, 'Learning actor source')
}

function assertDraftIdentity(record) {
  assert(typeof record.id === 'string' && record.id.length > 0, 'Learning record id is required')
  assert(typeof record.logicalId === 'string' && record.logicalId.length > 0, 'Learning logical id is required')
  assert(Number.isInteger(record.version) && record.version >= 1, 'Learning version must be positive')
  assert(typeof record.source === 'string' && record.source.length > 0, 'Learning provenance source is required')
  assert(typeof record.confidence === 'number' && record.confidence >= 0 && record.confidence <= 1, 'Learning confidence must be normalized')
}

function assertDraftDiff(record) {
  assert(/^[a-f0-9]{64}$/.test(record.digest), 'Learning payload digest must be SHA-256')
  equal(record.diff?.currentDigest, record.digest, 'Learning diff must bind the current digest')
  assert(typeof record.diff?.summary === 'string' && record.diff.summary.length > 0, 'Learning diff summary is required')
  assert(Array.isArray(record.diff?.changedFields) && record.diff.changedFields.length > 0, 'Learning changed fields are required')
}

function requiredRecord(snapshot, id) {
  const record = snapshot.records.find((item) => item.id === id)
  assert(record, `Learning record not found: ${id}`)
  return record
}

function skillMarkdown(name, verification) {
  return [
    '---',
    `name: ${name}`,
    'description: Synthetic project Skill used by the required Learning gate.',
    'trigger: learning approval contract',
    'tags: [learning, test-only]',
    '---',
    '',
    `# ${name}`,
    '',
    '## Steps',
    '1. Keep automatic learning in a reviewable draft.',
    '',
    '## Verification',
    `1. ${verification}`,
    ''
  ].join('\n')
}

function readPersistedLearningRecords(root) {
  const records = []
  for (const filePath of findNamedFiles(root, 'learning.json')) {
    try {
      const state = JSON.parse(readFileSync(filePath, 'utf8'))
      if (Array.isArray(state.records)) records.push(...state.records)
    } catch {
      // Invalid state is reported by the lifecycle checks that consume it.
    }
  }
  return records
}

function findNamedFiles(root, fileName) {
  if (!existsSync(root)) return []
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) found.push(...findNamedFiles(fullPath, fileName))
    else if (entry.isFile() && entry.name === fileName) found.push(fullPath)
  }
  return found
}

function findDraftRecords(value, found = []) {
  if (!value || typeof value !== 'object') return found
  if (value.status === 'draft' && (value.kind === 'memory' || value.kind === 'skill')) found.push(value)
  for (const item of Array.isArray(value) ? value : Object.values(value)) findDraftRecords(item, found)
  return found
}

function parseJsonObject(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return { output: value }
  }
}

function between(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, Math.max(0, from + start.length))
  assert(from >= 0 && to > from, `source contract block missing: ${start}`)
  return source.slice(from, to)
}

function ipcHandler(source, action) {
  const pattern = new RegExp(`ipcMain\\.handle\\('learning:${action}',[\\s\\S]*?\\n\\s*}\\)`, 'm')
  const match = source.match(pattern)
  assert(match, `main IPC handler missing: learning:${action}`)
  const handler = match[0]
  assert(new RegExp(`ipcMain\\.handle\\('learning:${action}',\\s*async\\s*\\(_(?:e|event),\\s*sessionId:\\s*string,\\s*recordId:\\s*string\\)`).test(handler), `learning:${action} handler accepts fields beyond sessionId and recordId`)
  return handler
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

function compile(files) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files,
      '--outDir',
      outDir,
      '--rootDir',
      'src',
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

function equal(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
