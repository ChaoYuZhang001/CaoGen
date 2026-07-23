#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-learning-approval-lifecycle-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataRoot = path.join(tempRoot, 'user-data')
const learningRoot = path.join(userDataRoot, 'learning')
const memoryRoot = path.join(userDataRoot, 'memory')
const projectRoot = path.join(tempRoot, 'project-a')
const otherProjectRoot = path.join(tempRoot, 'project-b')
const failures = []

process.env.CAOGEN_USER_DATA_DIR = userDataRoot

try {
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(otherProjectRoot, { recursive: true })
  compile([
    'src/main/learning/learning-lifecycle.ts',
    'src/main/memoryStore.ts',
    'src/main/skill/skill-manager.ts'
  ])

  const lifecycle = await loadCompiled('learning-lifecycle.js')
  const security = await loadCompiled('learning-security.js')
  const learningStore = await loadCompiled('learning-store.js')
  const memoryStore = await loadCompiled('memoryStore.js')
  const authority = (action) => security.createTrustedUserLearningDecision(`required-smoke:${action}`)
  const lines = [
    learningLine('memory'),
    learningLine('skill')
  ]

  for (const line of lines) {
    line.v1 = await lifecycle.createLearningDraft(
      projectRoot,
      learningRoot,
      line.input(1),
      { requestedLogicalId: `${line.kind}-logical-id` }
    )
  }

  await check('all user decisions fail closed for forged authority objects', async () => {
    const before = await lifecycle.listLearningProject(projectRoot, learningRoot)
    for (const line of lines) {
      await rejectsUntrusted(() => lifecycle.approveLearningDraft(projectRoot, learningRoot, line.v1.id, {}))
      await rejectsUntrusted(() => lifecycle.rejectLearningDraft(projectRoot, learningRoot, line.v1.id, {}))
      await rejectsUntrusted(() => lifecycle.rollbackLearningRecord(projectRoot, learningRoot, line.v1.id, {}))
      await rejectsUntrusted(() => lifecycle.revokeLearningRecord(projectRoot, learningRoot, line.v1.id, {}))
      await rejectsUntrusted(() => lifecycle.deleteLearningRecord(projectRoot, learningRoot, line.v1.id, {}))
    }
    const after = await lifecycle.listLearningProject(projectRoot, learningRoot)
    equal(after.audit.length, before.audit.length, 'forged decisions must not append audit events')
    equal(after.records.map((record) => record.status).join(','), before.records.map((record) => record.status).join(','), 'forged decisions must not mutate state')
  })

  await check('Skill approval rejects symlink parents without changing external bytes', async () => {
    const symlinkProjectRoot = path.join(tempRoot, 'symlink-project')
    const outsideRoot = path.join(tempRoot, 'symlink-outside')
    const skillRoot = path.join(symlinkProjectRoot, '.caogen', 'skills')
    const outsideCanary = path.join(outsideRoot, 'SKILL.md')
    mkdirSync(skillRoot, { recursive: true })
    mkdirSync(outsideRoot, { recursive: true })
    writeFileSync(outsideCanary, 'outside-canary\n')
    symlinkSync(outsideRoot, path.join(skillRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const draft = await lifecycle.createLearningDraft(
      symlinkProjectRoot,
      learningRoot,
      skillInput(1, 'escape/SKILL.md')
    )

    let rejected = false
    try {
      await lifecycle.approveLearningDraft(
        symlinkProjectRoot,
        learningRoot,
        draft.id,
        authority('skill:symlink-approve')
      )
    } catch (error) {
      rejected = true
      assert(/real directory|symbolic|symlink/i.test(String(error)), `unexpected symlink rejection: ${String(error)}`)
    }
    assert(rejected, 'symlinked Skill parent unexpectedly approved')
    equal(readFileSync(outsideCanary, 'utf8'), 'outside-canary\n', 'external symlink canary bytes')
    const state = learningStore.readLearningStateSync(learningRoot, symlinkProjectRoot)
    equal(state.materialization?.status, 'failed', 'symlink rejection materialization journal status')
  })

  await check('fresh first Skill load recovers pending materialization and marks journal clean', async () => {
    const recoveryProjectRoot = path.join(tempRoot, 'recovery-project')
    const relativePath = 'recovery/SKILL.md'
    mkdirSync(recoveryProjectRoot, { recursive: true })
    const draft = await lifecycle.createLearningDraft(
      recoveryProjectRoot,
      learningRoot,
      skillInput(1, relativePath)
    )
    await lifecycle.approveLearningDraft(
      recoveryProjectRoot,
      learningRoot,
      draft.id,
      authority('skill:recovery-approve')
    )
    const skillPath = path.join(recoveryProjectRoot, '.caogen', 'skills', relativePath)
    const statePath = learningStore.learningStatePath(learningRoot, recoveryProjectRoot)
    const interrupted = JSON.parse(readFileSync(statePath, 'utf8'))
    interrupted.materialization = {
      generation: (interrupted.materialization?.generation ?? 0) + 1,
      status: 'pending',
      updatedAt: new Date().toISOString()
    }
    writeFileSync(statePath, `${JSON.stringify(interrupted, null, 2)}\n`)
    rmSync(skillPath, { force: true })

    const fresh = freshProcessSkillLoad(recoveryProjectRoot)
    assert(fresh.projectSkills.some((skill) => skill.name === 'Skill lifecycle v1'), 'fresh Skill load did not recover the active Skill')
    equal(fresh.materialization?.status, 'clean', 'fresh recovery journal status')
    assert(existsSync(skillPath), 'fresh Skill load did not restore missing SKILL.md')
    equal(readFileSync(skillPath, 'utf8'), draft.payload.markdown, 'recovered SKILL.md bytes')
  })

  await check('fresh first Skill load expires and removes a due Skill without Learning UI', async () => {
    const expiryProjectRoot = path.join(tempRoot, 'expiry-project')
    const relativePath = 'expiry/SKILL.md'
    const fakeFuture = Date.now() + 120_000
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    mkdirSync(expiryProjectRoot, { recursive: true })
    const draft = await lifecycle.createLearningDraft(
      expiryProjectRoot,
      learningRoot,
      skillInput(1, relativePath, undefined, expiresAt)
    )
    await lifecycle.approveLearningDraft(
      expiryProjectRoot,
      learningRoot,
      draft.id,
      authority('skill:first-load-expiry')
    )
    const skillPath = path.join(expiryProjectRoot, '.caogen', 'skills', relativePath)
    assert(existsSync(skillPath), 'expiring Skill was not initially materialized')

    const fresh = freshProcessSkillLoad(expiryProjectRoot, fakeFuture)
    assert(!fresh.projectSkills.some((skill) => skill.name === 'Skill lifecycle v1'), 'due Skill remained loadable on first load')
    equal(fresh.recordStatuses[draft.id], 'expired', 'first-load expiry record status')
    equal(fresh.materialization?.status, 'clean', 'first-load expiry journal status')
    assert(!existsSync(skillPath), 'first-load expiry did not remove SKILL.md')
  })

  for (const line of lines) {
    line.activeV1 = await lifecycle.approveLearningDraft(projectRoot, learningRoot, line.v1.id, authority(`${line.kind}:approve-v1`))
    equal(line.activeV1.status, 'active', `${line.kind} v1 approval status`)
    equal(line.activeV1.version, 1, `${line.kind} v1 version`)
  }
  await assertMaterialized(lines, memoryStore, 'v1')

  await check('duplicate approval requests are idempotent', async () => {
    for (const line of lines) {
      const repeated = await lifecycle.approveLearningDraft(projectRoot, learningRoot, line.v1.id, authority(`${line.kind}:approve-v1-repeat`))
      equal(repeated.id, line.activeV1.id, `${line.kind} repeated approval id`)
      equal(repeated.status, 'active', `${line.kind} repeated approval status`)
    }
  })

  for (const line of lines) {
    line.v2 = await lifecycle.createLearningDraft(projectRoot, learningRoot, line.input(2, line.v1.id))
    equal(line.v2.version, 2, `${line.kind} v2 version`)
    equal(line.v2.supersedes, line.v1.id, `${line.kind} v2 predecessor`)
    equal(line.v2.diff.previousDigest, line.v1.digest, `${line.kind} v2 diff predecessor digest`)
    line.activeV2 = await lifecycle.approveLearningDraft(projectRoot, learningRoot, line.v2.id, authority(`${line.kind}:approve-v2`))
    equal(line.activeV2.status, 'active', `${line.kind} v2 approval status`)
  }
  await assertOnlyLatestActive(lifecycle, lines)
  await assertMaterialized(lines, memoryStore, 'v2')

  for (const line of lines) {
    line.v3 = await lifecycle.createLearningDraft(projectRoot, learningRoot, line.input(3, line.v2.id))
    line.rejected = await lifecycle.rejectLearningDraft(projectRoot, learningRoot, line.v3.id, authority(`${line.kind}:reject-v3`))
    equal(line.rejected.status, 'rejected', `${line.kind} rejection status`)
  }
  await check('duplicate rejection requests are idempotent', async () => {
    for (const line of lines) {
      const repeated = await lifecycle.rejectLearningDraft(projectRoot, learningRoot, line.v3.id, authority(`${line.kind}:reject-v3-repeat`))
      equal(repeated.status, 'rejected', `${line.kind} repeated rejection status`)
    }
  })
  await assertMaterialized(lines, memoryStore, 'v2')

  for (const line of lines) {
    line.revoked = await lifecycle.revokeLearningRecord(projectRoot, learningRoot, line.v2.id, authority(`${line.kind}:revoke-v2`))
    equal(line.revoked.status, 'revoked', `${line.kind} revoke status`)
  }
  await assertNothingMaterialized(lines, memoryStore)
  await check('duplicate revoke requests are idempotent', async () => {
    for (const line of lines) {
      const repeated = await lifecycle.revokeLearningRecord(projectRoot, learningRoot, line.v2.id, authority(`${line.kind}:revoke-v2-repeat`))
      equal(repeated.status, 'revoked', `${line.kind} repeated revoke status`)
    }
  })

  for (const line of lines) {
    line.rollbackV1 = await lifecycle.rollbackLearningRecord(projectRoot, learningRoot, line.v1.id, authority(`${line.kind}:rollback-v1`))
    equal(line.rollbackV1.status, 'active', `${line.kind} rollback status`)
    assert(line.rollbackV1.version > line.v3.version, `${line.kind} rollback must create a new monotonic version`)
    equal(line.rollbackV1.digest, line.v1.digest, `${line.kind} rollback digest`)
  }
  await assertMaterialized(lines, memoryStore, 'v1')

  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  for (const line of lines) {
    line.expiring = await lifecycle.createLearningDraft(
      projectRoot,
      learningRoot,
      line.input(4, line.rollbackV1.id, expiresAt)
    )
    line.expiringActive = await lifecycle.approveLearningDraft(projectRoot, learningRoot, line.expiring.id, authority(`${line.kind}:approve-expiring`))
    equal(line.expiringActive.status, 'active', `${line.kind} expiring approval status`)
  }
  const expired = await lifecycle.expireDueLearningRecords(projectRoot, learningRoot, Date.now() + 120_000)
  for (const line of lines) {
    assert(expired.some((record) => record.id === line.expiring.id && record.status === 'expired'), `${line.kind} active record did not expire`)
  }
  await assertNothingMaterialized(lines, memoryStore)

  for (const line of lines) {
    line.rollbackForDelete = await lifecycle.rollbackLearningRecord(projectRoot, learningRoot, line.v1.id, authority(`${line.kind}:rollback-delete`))
    line.deleted = await lifecycle.deleteLearningRecord(projectRoot, learningRoot, line.rollbackForDelete.id, authority(`${line.kind}:delete`))
    equal(line.deleted.status, 'deleted', `${line.kind} delete status`)
  }
  await assertNothingMaterialized(lines, memoryStore)
  await check('duplicate deletion requests are idempotent', async () => {
    for (const line of lines) {
      const repeated = await lifecycle.deleteLearningRecord(projectRoot, learningRoot, line.deleted.id, authority(`${line.kind}:delete-repeat`))
      equal(repeated.status, 'deleted', `${line.kind} repeated delete status`)
    }
  })

  await check('project isolation permits identical requested ids without cross-project reads', async () => {
    const sharedId = 'shared-request-id'
    const other = await lifecycle.createLearningDraft(
      otherProjectRoot,
      learningRoot,
      memoryInput(1),
      { requestedId: sharedId, requestedLogicalId: 'other-project-memory' }
    )
    equal(other.id, sharedId, 'requested id in project B')
    const projectA = await lifecycle.listLearningProject(projectRoot, learningRoot)
    const projectB = await lifecycle.listLearningProject(otherProjectRoot, learningRoot)
    assert(!projectA.records.some((record) => record.id === sharedId), 'project A observed project B state')
    assert(projectB.records.some((record) => record.id === sharedId), 'project B state was not persisted')
    assert(projectA.project !== projectB.project, 'project hashes must isolate persisted state')
  })

  await check('restart preserves versions, terminal states, and complete audit history', async () => {
    const lifecyclePath = findCompiled(outDir, 'learning-lifecycle.js')
    const raw = execFileSync(
      process.execPath,
      [
        '-e',
        "const lifecycle=require(process.argv[1]);lifecycle.listLearningProject(process.argv[2],process.argv[3]).then((snapshot)=>process.stdout.write(JSON.stringify(snapshot))).catch((error)=>{console.error(error);process.exit(1)})",
        lifecyclePath,
        projectRoot,
        learningRoot
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    )
    const restarted = JSON.parse(raw)
    assert(restarted.records.length >= 12, 'restart lost Learning history records')
    for (const line of lines) {
      const records = restarted.records.filter((record) => record.kind === line.kind)
      assert(records.some((record) => record.status === 'rejected'), `${line.kind} rejected history was lost on restart`)
      assert(records.some((record) => record.status === 'revoked'), `${line.kind} revoked history was lost on restart`)
      assert(records.some((record) => record.status === 'expired'), `${line.kind} expired history was lost on restart`)
      assert(records.some((record) => record.status === 'deleted'), `${line.kind} deleted history was lost on restart`)
      const versions = records.filter((record) => record.logicalId === line.v1.logicalId).map((record) => record.version)
      equal(new Set(versions).size, versions.length, `${line.kind} versions must remain unique after restart`)
      assert(isStrictlyIncreasing([...versions].sort((a, b) => a - b)), `${line.kind} versions must remain monotonic after restart`)
    }
    assertAudit(restarted)
  })

  if (failures.length > 0) {
    throw new Error(`learningApprovalLifecycle smoke failed (${failures.length}):\n${failures.map((item) => `- ${item}`).join('\n')}`)
  }
  console.log('learningApprovalLifecycle smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function learningLine(kind) {
  const relativePath = `${kind}-lifecycle/SKILL.md`
  return {
    kind,
    relativePath,
    input(version, supersedes, expiresAt) {
      return kind === 'memory'
        ? memoryInput(version, supersedes, expiresAt)
        : skillInput(version, relativePath, supersedes, expiresAt)
    }
  }
}

function memoryInput(version, supersedes, expiresAt) {
  return {
    kind: 'memory',
    source: `required-smoke:memory:v${version}`,
    confidence: 0.8,
    ...(supersedes ? { supersedes } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    payload: {
      type: 'memory',
      memoryKind: 'workflow-rule',
      title: `Memory lifecycle v${version}`,
      body: `Memory lifecycle body v${version}`,
      reason: 'Required approval lifecycle verification.'
    }
  }
}

function skillInput(version, relativePath, supersedes, expiresAt) {
  return {
    kind: 'skill',
    source: `required-smoke:skill:v${version}`,
    confidence: 0.9,
    ...(supersedes ? { supersedes } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    payload: {
      type: 'skill',
      name: `Skill lifecycle v${version}`,
      description: `Synthetic Skill lifecycle revision ${version}.`,
      markdown: skillMarkdown(version),
      relativePath
    }
  }
}

function skillMarkdown(version) {
  return [
    '---',
    `name: Skill lifecycle v${version}`,
    `description: Synthetic Skill lifecycle revision ${version}.`,
    'trigger: learning approval lifecycle',
    'tags: [learning, test-only]',
    '---',
    '',
    `# Skill lifecycle v${version}`,
    '',
    '## Steps',
    `1. Exercise lifecycle revision ${version}.`,
    '',
    '## Verification',
    '1. npm run test:learning-approval-lifecycle:required',
    ''
  ].join('\n')
}

async function assertOnlyLatestActive(lifecycle, lines) {
  const snapshot = await lifecycle.listLearningProject(projectRoot, learningRoot)
  for (const line of lines) {
    const active = snapshot.active.filter((record) => record.kind === line.kind)
    equal(active.length, 1, `${line.kind} active record count`)
    equal(active[0].id, line.v2.id, `${line.kind} active v2 id`)
    equal(requiredRecord(snapshot, line.v1.id).status, 'superseded', `${line.kind} v1 superseded status`)
  }
}

async function assertMaterialized(lines, memoryStore, revision) {
  const memory = await memoryStore.readProjectMemory(projectRoot, memoryRoot)
  equal(memory.entries.length, 1, `Memory ${revision} active entry count`)
  assert(memory.markdown.includes(`Memory lifecycle ${revision}`), `Memory ${revision} did not enter prompt markdown`)
  const skill = lines.find((line) => line.kind === 'skill')
  const skillPath = path.join(projectRoot, '.caogen', 'skills', skill.relativePath)
  assert(existsSync(skillPath), `Skill ${revision} was not materialized`)
  assert(readFileSync(skillPath, 'utf8').includes(`Skill lifecycle ${revision}`), `Skill ${revision} materialization is stale`)
}

async function assertNothingMaterialized(lines, memoryStore) {
  const memory = await memoryStore.readProjectMemory(projectRoot, memoryRoot)
  equal(memory.entries.length, 0, 'inactive Memory must not enter confirmed entries')
  equal(memory.markdown, '', 'inactive Memory must not enter prompt markdown')
  const skill = lines.find((line) => line.kind === 'skill')
  assert(!existsSync(path.join(projectRoot, '.caogen', 'skills', skill.relativePath)), 'inactive Skill materialization must be removed')
}

function assertAudit(snapshot) {
  const actions = new Set(snapshot.audit.map((event) => event.action))
  for (const action of ['proposed', 'approved', 'rejected', 'rolled_back', 'revoked', 'expired', 'deleted']) {
    assert(actions.has(action), `audit action missing after restart: ${action}`)
  }
  equal(new Set(snapshot.audit.map((event) => event.id)).size, snapshot.audit.length, 'audit event ids must be unique')
  const byId = new Map(snapshot.records.map((record) => [record.id, record]))
  for (const event of snapshot.audit) {
    assert(byId.has(event.recordId), `audit event references an unknown record: ${event.recordId}`)
    assert(typeof event.at === 'string' && !Number.isNaN(Date.parse(event.at)), 'audit timestamp must be an ISO timestamp')
    assert(event.actor && typeof event.actor.id === 'string' && event.actor.id.length > 0, 'audit actor id is required')
    assert(event.actor && typeof event.actor.source === 'string' && event.actor.source.length > 0, 'audit actor source is required')
    if (['approved', 'rejected', 'rolled_back', 'revoked', 'deleted'].includes(event.action)) {
      equal(event.actor.type, 'user', `${event.action} audit actor type`)
    }
  }
  for (const kind of ['memory', 'skill']) {
    const recordIds = new Set(snapshot.records.filter((record) => record.kind === kind).map((record) => record.id))
    for (const action of ['proposed', 'approved', 'rejected', 'rolled_back', 'revoked', 'expired', 'deleted']) {
      assert(snapshot.audit.some((event) => recordIds.has(event.recordId) && event.action === action), `${kind} audit action missing: ${action}`)
    }
  }
}

function freshProcessSkillLoad(targetProjectRoot, fakeNow) {
  const managerPath = findCompiled(outDir, 'skill-manager.js')
  const storePath = findCompiled(outDir, 'learning-store.js')
  const raw = execFileSync(
    process.execPath,
    [
      '-e',
      [
        "if(process.argv[5])Date.now=()=>Number(process.argv[5])",
        "const {SkillManager}=require(process.argv[1])",
        "const store=require(process.argv[2])",
        "const skills=new SkillManager({projectRoot:process.argv[3]}).list()",
        "const state=store.readLearningStateSync(process.argv[4],process.argv[3])",
        "process.stdout.write(JSON.stringify({projectSkills:skills.filter((skill)=>skill.scope==='project').map(({id,name,scope})=>({id,name,scope})),recordStatuses:Object.fromEntries(state.records.map((record)=>[record.id,record.status])),materialization:state.materialization}))"
      ].join(';'),
      managerPath,
      storePath,
      targetProjectRoot,
      learningRoot,
      fakeNow === undefined ? '' : String(fakeNow)
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CAOGEN_USER_DATA_DIR: userDataRoot }
    }
  )
  return JSON.parse(raw)
}

async function rejectsUntrusted(run) {
  try {
    await run()
  } catch (error) {
    equal(error?.code, 'UNTRUSTED_LEARNING_DECISION', 'untrusted decision error code')
    return
  }
  throw new Error('forged authority unexpectedly authorized a Learning decision')
}

function isStrictlyIncreasing(values) {
  return values.every((value, index) => index === 0 || value > values[index - 1])
}

function requiredRecord(snapshot, id) {
  const record = snapshot.records.find((item) => item.id === id)
  assert(record, `Learning record not found: ${id}`)
  return record
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
