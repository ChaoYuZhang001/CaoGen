import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'caogen-code-forge-')))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')
const worktreeDir = path.join(tempRoot, 'worktree')
const userData = path.join(tempRoot, 'user-data')
let patchArtifactPath

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/agent/tools/git-tools.ts',
      'src/main/permission/tool-permission.ts',
      'src/main/task/effect-reconciler.ts',
      'src/main/task/effect-target-validation.ts',
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
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')

  const gitTools = await import(pathToFileURL(path.join(outDir, 'main/agent/tools/git-tools.js')).href)
  const delivery = await import(pathToFileURL(path.join(outDir, 'main/code-forge/delivery.js')).href)
  const sourceSecurity = await import(pathToFileURL(path.join(outDir, 'main/code-forge/source-security.js')).href)
  const permissions = await import(pathToFileURL(path.join(outDir, 'main/permission/tool-permission.js')).href)
  const reconciler = await import(pathToFileURL(path.join(outDir, 'main/task/effect-reconciler.js')).href)
  const validation = await import(pathToFileURL(path.join(outDir, 'main/task/effect-target-validation.js')).href)
  const idempotency = await import(pathToFileURL(path.join(outDir, 'main/task/tool-idempotency.js')).href)
  const targetBuilder = await import(pathToFileURL(path.join(outDir, 'main/task/effect-target-builder.js')).href)

  const codeForgeTool = gitTools.GIT_TOOLS.find((item) => item.function?.name === 'code_forge_delivery')
  assert(codeForgeTool, 'code_forge_delivery schema missing')
  const codeForgeProperties = codeForgeTool.function.parameters.properties
  assert.deepEqual(codeForgeProperties.mode.enum, ['report', 'patch'], 'schema must expose report/patch only')
  for (const forbidden of [
    'verificationCommand',
    'verificationCommands',
    'verificationTimeoutMs',
    'commitMessage',
    'stageAll',
    'createPatch',
    'repoRoot',
    'worktreePath',
    'baseSha',
    'baseBranch',
    'branch',
    'prTitle',
    'prBody'
  ]) {
    assert.equal(forbidden in codeForgeProperties, false, `schema must not expose ${forbidden}`)
  }
  assert(idempotency.isReadOnlyToolCall('code_forge_delivery', { mode: 'report' }), 'report must be read-only')
  assert(!idempotency.isSideEffectingToolCall('code_forge_delivery', { mode: 'report' }), 'report must be effect-free')
  assert(idempotency.isSideEffectingToolCall('code_forge_delivery', { mode: 'patch' }), 'patch must create an effect')
  assert(
    idempotency.isSideEffectingToolCall('code_forge_delivery', { mode: 'report', createPatch: true }),
    'legacy report createPatch bypass must fail through the effect descriptor'
  )
  assert(targetBuilder.relativePathEscapesRoot('..\\outside', '\\'), 'Windows parent path must escape the root')

  initRepo(projectDir)
  writePassingContext(projectDir)
  writeFileSync(path.join(projectDir, 'app.txt'), 'base\n', 'utf8')
  git(projectDir, ['add', 'app.txt', 'caogen.md'])
  git(projectDir, ['commit', '-m', 'base'])
  const baseSha = git(projectDir, ['rev-parse', 'HEAD']).trim()

  git(projectDir, ['worktree', 'add', '-b', 'forge/change', worktreeDir, 'HEAD'])
  writeFileSync(path.join(worktreeDir, 'app.txt'), 'base\nforge\n', 'utf8')
  writeFileSync(path.join(worktreeDir, 'new.txt'), 'new file\n', 'utf8')

  const worktreeContext = {
    sessionId: 'code-forge-smoke',
    repoRoot: projectDir,
    worktreePath: worktreeDir,
    baseSha,
    branch: 'forge/change',
    baseBranch: 'main'
  }

  const registryDir = path.join(userData, 'worktrees')
  mkdirSync(registryDir, { recursive: true })
  writeFileSync(path.join(registryDir, 'index.json'), `${JSON.stringify([{
    sessionId: worktreeContext.sessionId,
    repoRoot: projectDir,
    sourceCwd: projectDir,
    worktreePath: worktreeDir,
    cwd: worktreeDir,
    branch: worktreeContext.branch,
    baseSha,
    baseBranch: 'main',
    state: 'active',
    createdAt: 1,
    updatedAt: 1
  }], null, 2)}\n`, 'utf8')

  const securityDescriptorInput = {
    sessionId: worktreeContext.sessionId,
    toolName: 'code_forge_delivery',
    toolInput: { mode: 'patch' },
    cwd: worktreeDir
  }
  const attributesPath = path.join(worktreeDir, '.gitattributes')
  for (const filterKind of ['clean', 'process']) {
    const marker = path.join(tempRoot, `code-forge-${filterKind}-filter-ran`)
    writeFileSync(attributesPath, '*.txt filter=code-forge-malicious\n', 'utf8')
    git(worktreeDir, [
      'config',
      `filter.code-forge-malicious.${filterKind}`,
      `${shellQuote(process.execPath)} -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}`
    ])
    const blockedFilterReport = delivery.runCodeForgeDelivery({
      cwd: worktreeDir,
      mode: 'report',
      worktreeContext
    })
    assert.equal(blockedFilterReport.ok, false, `${filterKind} filter must block Code Forge report`)
    assert.match(blockedFilterReport.error, /可执行 Git filter/, `${filterKind} filter rejection missing`)
    await assert.rejects(
      reconciler.buildEffectDescriptor(securityDescriptorInput),
      /可执行 Git filter/,
      `${filterKind} filter must block Code Forge descriptor`
    )
    assert.equal(existsSync(marker), false, `${filterKind} filter command must never execute`)
    git(worktreeDir, ['config', '--unset-all', `filter.code-forge-malicious.${filterKind}`])
    rmSync(attributesPath, { force: true })
  }

  const destinationFilterMarker = path.join(tempRoot, 'code-forge-destination-filter-ran')
  writeFileSync(attributesPath, '*.txt filter=code-forge-destination\n', 'utf8')
  git(projectDir, ['config', 'extensions.worktreeConfig', 'true'])
  git(projectDir, [
    'config',
    '--worktree',
    'filter.code-forge-destination.clean',
    `${shellQuote(process.execPath)} -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(destinationFilterMarker)}, 'ran')`)}`
  ])
  try {
    const destinationFilterReport = delivery.runCodeForgeDelivery({
      cwd: worktreeDir,
      mode: 'report',
      worktreeContext
    })
    assert.equal(destinationFilterReport.ok, false, 'destination worktree filter must block Code Forge report')
    assert.match(destinationFilterReport.error, /可执行 Git filter/, 'destination filter rejection missing')
    await assert.rejects(
      reconciler.buildEffectDescriptor(securityDescriptorInput),
      /可执行 Git filter/,
      'destination worktree filter must block Code Forge descriptor'
    )
    assert.equal(existsSync(destinationFilterMarker), false, 'destination worktree filter must never execute')
  } finally {
    git(projectDir, ['config', '--worktree', '--unset-all', 'filter.code-forge-destination.clean'])
    git(projectDir, ['config', '--unset', 'extensions.worktreeConfig'])
    rmSync(attributesPath, { force: true })
  }

  const submoduleSourceDir = path.join(tempRoot, 'code-forge-submodule-source')
  const submoduleParentDir = path.join(tempRoot, 'code-forge-submodule-parent')
  initRepo(submoduleSourceDir)
  writeFileSync(path.join(submoduleSourceDir, '.gitattributes'), '*.txt filter=code-forge-submodule\n', 'utf8')
  writeFileSync(path.join(submoduleSourceDir, 'tracked.txt'), 'before\n', 'utf8')
  git(submoduleSourceDir, ['add', '.gitattributes', 'tracked.txt'])
  git(submoduleSourceDir, ['commit', '-m', 'submodule base'])
  initRepo(submoduleParentDir)
  writeFileSync(path.join(submoduleParentDir, 'parent.txt'), 'parent\n', 'utf8')
  git(submoduleParentDir, ['add', 'parent.txt'])
  git(submoduleParentDir, ['commit', '-m', 'parent base'])
  git(submoduleParentDir, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    submoduleSourceDir,
    'vendor/sub'
  ])
  git(submoduleParentDir, ['commit', '-am', 'add submodule'])
  const checkedOutSubmodule = path.join(submoduleParentDir, 'vendor', 'sub')
  const submoduleFilterMarker = path.join(tempRoot, 'code-forge-submodule-filter-ran')
  git(checkedOutSubmodule, [
    'config',
    'filter.code-forge-submodule.clean',
    `${shellQuote(process.execPath)} -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(submoduleFilterMarker)}, 'ran')`)}`
  ])
  writeFileSync(path.join(checkedOutSubmodule, 'tracked.txt'), 'after\n', 'utf8')
  writeFileSync(path.join(submoduleParentDir, 'parent.txt'), 'parent\nchanged\n', 'utf8')

  const submoduleReport = delivery.runCodeForgeDelivery({
    cwd: submoduleParentDir,
    mode: 'report'
  })
  assert(submoduleReport.ok, submoduleReport.error)
  assert.deepEqual(submoduleReport.changes.files, ['parent.txt'], 'report must ignore dirty submodule worktree state')
  assert.equal(existsSync(submoduleFilterMarker), false, 'report must not execute dirty submodule filters')

  const submoduleDescriptorInput = {
    sessionId: 'code-forge-submodule-smoke',
    toolName: 'code_forge_delivery',
    toolInput: { mode: 'patch' },
    cwd: submoduleParentDir
  }
  const submoduleDescriptor = await reconciler.buildEffectDescriptor(submoduleDescriptorInput)
  assert.equal(submoduleDescriptor.target.kind, 'code_forge_patch', 'submodule fixture must build Code Forge patch target')
  assert.deepEqual(
    submoduleDescriptor.target.changedPaths,
    ['parent.txt'],
    'descriptor must ignore dirty submodule worktree state'
  )
  assert.equal(existsSync(submoduleFilterMarker), false, 'descriptor must not execute dirty submodule filters')

  const submoduleExecution = await gitTools.executeGitTool(
    'code_forge_delivery',
    { mode: 'patch' },
    submoduleParentDir,
    { sessionId: submoduleDescriptorInput.sessionId, effectTarget: submoduleDescriptor.target }
  )
  assert(submoduleExecution.ok, submoduleExecution.output)
  const submodulePatchReport = JSON.parse(submoduleExecution.output)
  const submodulePatchPath = submodulePatchReport.patch?.path
  assert.equal(typeof submodulePatchPath, 'string', 'submodule fixture patch path missing')
  const submodulePatchText = readFileSync(submodulePatchPath, 'utf8')
  assert.match(submodulePatchText, /parent\.txt/, 'patch must retain parent worktree changes')
  assert.doesNotMatch(submodulePatchText, /vendor\/sub/, 'patch must ignore dirty submodule worktree state')
  assert.equal(existsSync(submoduleFilterMarker), false, 'execution must not execute dirty submodule filters')
  rmSync(submodulePatchPath, { force: true })

  const injectedFilterMarker = path.join(tempRoot, 'code-forge-env-filter-ran')
  writeFileSync(attributesPath, '*.txt filter=code-forge-env\n', 'utf8')
  const injectedEnvironment = {
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0
  }
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'filter.code-forge-env.clean'
  process.env.GIT_CONFIG_VALUE_0 = `${shellQuote(process.execPath)} -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(injectedFilterMarker)}, 'ran')`)}`
  try {
    const isolatedEnvironmentReport = delivery.runCodeForgeDelivery({
      cwd: worktreeDir,
      mode: 'report',
      worktreeContext
    })
    assert(isolatedEnvironmentReport.ok, isolatedEnvironmentReport.error)
    assert.equal(existsSync(injectedFilterMarker), false, 'environment-injected filter must never execute')
  } finally {
    restoreEnvironment('GIT_CONFIG_COUNT', injectedEnvironment.GIT_CONFIG_COUNT)
    restoreEnvironment('GIT_CONFIG_KEY_0', injectedEnvironment.GIT_CONFIG_KEY_0)
    restoreEnvironment('GIT_CONFIG_VALUE_0', injectedEnvironment.GIT_CONFIG_VALUE_0)
    rmSync(attributesPath, { force: true })
  }

  const unsafeLinkPath = path.join(worktreeDir, 'unsafe-link.txt')
  symlinkSync('app.txt', unsafeLinkPath)
  const linkedUntrackedReport = delivery.runCodeForgeDelivery({
    cwd: worktreeDir,
    mode: 'report',
    worktreeContext
  })
  assert.equal(linkedUntrackedReport.ok, false, 'untracked symlink must block Code Forge report')
  assert.match(linkedUntrackedReport.error, /不是安全的普通文件/, 'untracked symlink rejection missing')
  await assert.rejects(
    reconciler.buildEffectDescriptor(securityDescriptorInput),
    /不是安全的普通文件/,
    'untracked symlink must block Code Forge descriptor'
  )
  rmSync(unsafeLinkPath, { force: true })

  if (process.platform !== 'win32') {
    const fifoPath = path.join(worktreeDir, 'unsafe-fifo')
    execFileSync('mkfifo', [fifoPath])
    const startedAt = Date.now()
    assert.throws(
      () => sourceSecurity.inspectCodeForgeUntrackedFiles(worktreeDir, ['unsafe-fifo'], 32 * 1024 * 1024),
      /不是安全的普通文件/,
      'non-regular untracked path must fail closed'
    )
    assert(Date.now() - startedAt < 5_000, 'untracked FIFO rejection must not block on file reads')
    rmSync(fifoPath, { force: true })
  }

  const oversizedFile = path.join(worktreeDir, 'oversized.bin')
  writeFileSync(oversizedFile, '')
  truncateSync(oversizedFile, 32 * 1024 * 1024 + 1)
  const oversizedReport = delivery.runCodeForgeDelivery({
    cwd: worktreeDir,
    mode: 'report',
    worktreeContext
  })
  assert.equal(oversizedReport.ok, false, 'oversized untracked file must block Code Forge report')
  assert.match(oversizedReport.error, /超过 33554432 字节上限/, 'oversized file rejection missing')
  rmSync(oversizedFile, { force: true })

  const aggregateA = path.join(worktreeDir, 'aggregate-a.bin')
  const aggregateB = path.join(worktreeDir, 'aggregate-b.bin')
  writeFileSync(aggregateA, '')
  writeFileSync(aggregateB, '')
  truncateSync(aggregateA, 17 * 1024 * 1024)
  truncateSync(aggregateB, 17 * 1024 * 1024)
  await assert.rejects(
    reconciler.buildEffectDescriptor(securityDescriptorInput),
    /聚合大小超过 33554432 字节上限/,
    'aggregate untracked files above artifact limit must block descriptor creation'
  )
  rmSync(aggregateA, { force: true })
  rmSync(aggregateB, { force: true })

  const reportResult = await gitTools.executeGitTool(
    'code_forge_delivery',
    { mode: 'report' },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext }
  )
  assert(reportResult.ok, reportResult.output)
  assert.equal('patch' in JSON.parse(reportResult.output), false, 'report must not publish a patch artifact')

  const legacyCreatePatch = await gitTools.executeGitTool(
    'code_forge_delivery',
    { mode: 'report', createPatch: true },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext }
  )
  assert.equal(legacyCreatePatch.ok, false, 'legacy createPatch bypass must fail closed')

  const targetOverride = await gitTools.executeGitTool(
    'code_forge_delivery',
    { mode: 'report', repoRoot: projectDir },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext }
  )
  assert.equal(targetOverride.ok, false, 'model-provided repository selector must be rejected')

  const descriptorInput = securityDescriptorInput
  const descriptor = await reconciler.buildEffectDescriptor(descriptorInput)
  assert.equal(descriptor.target.kind, 'code_forge_patch', 'patch must build a dedicated EffectTarget')
  assert.equal(descriptor.reconcilability, 'queryable', 'Code Forge patch must be queryable')
  assert(validation.isEffectTarget(descriptor.target), 'Code Forge patch target must survive persisted validation')
  assert.deepEqual(descriptor.target.changedPaths, ['app.txt', 'new.txt'], 'target must freeze every changed file')
  assert.equal(descriptor.target.artifactPreState, 'absent', 'fresh content-addressed artifact must be absent')
  patchArtifactPath = descriptor.target.artifactPath
  const effect = effectRecord(descriptor, descriptorInput)
  const preExecution = await reconciler.reconcileEffect(effect)
  assert.equal(preExecution.kind, 'not_applied', 'absent artifact with frozen source must be retryable')

  const missingTarget = await gitTools.executeGitTool(
    'code_forge_delivery',
    { mode: 'patch' },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext }
  )
  assert.equal(missingTarget.ok, false, 'patch execution without frozen target must fail closed')
  assert.equal(existsSync(patchArtifactPath), false, 'missing target must not write a patch artifact')

  writeFileSync(path.join(worktreeDir, 'app.txt'), 'base\nforge\ndrift\n', 'utf8')
  const drifted = await gitTools.executeGitTool(
    'code_forge_delivery',
    { mode: 'patch' },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext, effectTarget: descriptor.target }
  )
  assert.equal(drifted.ok, false, 'source drift before execution must fail closed')
  assert.equal(existsSync(patchArtifactPath), false, 'source drift must not publish a patch artifact')
  const driftProbe = await reconciler.reconcileEffect(effect)
  assert.equal(driftProbe.kind, 'unresolved', 'missing artifact plus source drift must remain unknown')
  writeFileSync(path.join(worktreeDir, 'app.txt'), 'base\nforge\n', 'utf8')

  const patchResult = await gitTools.executeGitTool(
    'code_forge_delivery',
    { mode: 'patch' },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext, effectTarget: descriptor.target }
  )
  assert(patchResult.ok, patchResult.output)
  const patchReport = JSON.parse(patchResult.output)
  assert.equal(patchReport.status, 'needs-review', 'external verification is required before delivery readiness')
  assert.equal(patchReport.target.kind, 'managed-worktree', 'should use managed worktree context')
  assert.equal(patchReport.verification.status, 'skipped', 'Code Forge must not run embedded verification')
  assert.equal(patchReport.patch.canApply, true, 'patch should apply cleanly to source repo')
  assert(existsSync(patchReport.patch.path), 'patch file should exist')
  assert.equal(patchReport.mergeable, false, 'Code Forge cannot claim mergeable without explicit verification evidence')
  assert(patchReport.changes.files.includes('app.txt'), 'tracked change missing')
  assert(patchReport.changes.files.includes('new.txt'), 'untracked change missing')
  assert.equal(patchReport.patch.path, patchArtifactPath, 'execution must use the frozen artifact path')
  const confirmed = await reconciler.reconcileEffect(effect)
  const confirmedAgain = await reconciler.reconcileEffect(effect)
  assert.equal(confirmed.kind, 'confirmed', 'published artifact must reconcile as confirmed')
  assert.equal(confirmedAgain.kind, 'confirmed', 'reconciliation must be repeatable')
  assert.equal(confirmedAgain.evidenceDigest, confirmed.evidenceDigest, 'repeat reconciliation evidence must be stable')

  const frozenPatch = readFileSync(patchArtifactPath)
  writeFileSync(patchArtifactPath, 'tampered\n', 'utf8')
  const tampered = await reconciler.reconcileEffect(effect)
  assert.equal(tampered.kind, 'unresolved', 'mismatched content-addressed artifact must fail closed')
  writeFileSync(patchArtifactPath, frozenPatch)

  rmSync(patchArtifactPath, { force: true })
  symlinkSync(path.join(worktreeDir, 'app.txt'), patchArtifactPath)
  const linkedArtifact = await reconciler.reconcileEffect(effect)
  assert.equal(linkedArtifact.kind, 'unresolved', 'symlink patch artifact must fail closed')
  rmSync(patchArtifactPath, { force: true })
  writeFileSync(patchArtifactPath, frozenPatch)

  const blockedCommit = await gitTools.executeGitTool(
    'code_forge_delivery',
    {
      mode: 'commit',
      verificationCommands: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
      commitMessage: 'code forge smoke delivery',
      stageAll: true,
      createPatch: true
    },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext }
  )
  assert.equal(blockedCommit.ok, false, 'compound Code Forge commit must fail closed')
  assert.match(blockedCommit.output, /mode=commit/, 'blocked commit guidance missing')
  assert.equal(git(worktreeDir, ['diff', '--cached', '--name-only']).trim(), '', 'blocked commit must not stage files')

  const preDirectHead = git(worktreeDir, ['rev-parse', 'HEAD']).trim()
  const directCommit = delivery.runCodeForgeDelivery({
    cwd: worktreeDir,
    mode: 'commit',
    commitMessage: 'must not commit',
    stageAll: true,
    worktreeContext
  })
  assert.equal(directCommit.ok, false, 'direct compound commit API must fail closed')
  assert.match(directCommit.error, /mode=commit.*停用/, 'direct commit rejection missing')
  assert.equal(git(worktreeDir, ['rev-parse', 'HEAD']).trim(), preDirectHead, 'direct API must not commit')
  assert.equal(git(worktreeDir, ['diff', '--cached', '--name-only']).trim(), '', 'direct API must not stage')
  const directPr = delivery.runCodeForgeDelivery({
    cwd: path.join(tempRoot, 'missing-cwd'),
    mode: 'pr'
  })
  assert.equal(directPr.ok, false, 'direct compound PR API must fail closed')
  assert.match(directPr.error, /mode=pr.*停用/, 'direct PR must reject before resolving cwd or remote state')

  const verificationMarker = path.join(worktreeDir, 'inline-verification-ran.txt')
  const verificationCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(verificationMarker)}, 'ran')`)}`
  for (const legacyInput of [
    { verificationCommand },
    { verificationCommands: [verificationCommand] }
  ]) {
    const blockedVerification = delivery.runCodeForgeDelivery({
      cwd: worktreeDir,
      mode: 'report',
      ...legacyInput,
      worktreeContext
    })
    assert.equal(blockedVerification.ok, false, 'direct embedded verification API must fail closed')
    assert.match(blockedVerification.error, /显式调用 bash/, 'embedded verification guidance missing')
    assert.equal(existsSync(verificationMarker), false, 'embedded verification command must not execute')
  }

  const blockedToolVerification = await gitTools.executeGitTool(
    'code_forge_delivery',
    { mode: 'report', verificationCommand },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext }
  )
  assert.equal(blockedToolVerification.ok, false, 'tool-level embedded verification must fail closed')
  assert.equal(existsSync(verificationMarker), false, 'tool-level embedded verification must not execute')

  git(worktreeDir, ['add', '--all'])
  const explicitCommit = await gitTools.executeGitTool(
    'git_commit',
    { message: 'code forge smoke delivery' },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext }
  )
  assert(explicitCommit.ok, explicitCommit.output)
  const commitReport = JSON.parse(explicitCommit.output)
  assert.match(commitReport.sha, /^[0-9a-f]{40}$/, 'explicit commit sha missing')
  assert.equal(git(worktreeDir, ['status', '--porcelain']).trim(), '', 'worktree should be clean after commit')
  assert(readFileSync(path.join(projectDir, 'app.txt'), 'utf8') === 'base\n', 'source repo should not be mutated')

  const reportRisk = permissions.classifyToolRisk('code_forge_delivery', { mode: 'report' }, projectDir)
  const commitRisk = permissions.classifyToolRisk('code_forge_delivery', { mode: 'commit' }, projectDir)
  assert.equal(reportRisk.level, 'low', 'report mode should be low-risk read-only')
  assert.equal(commitRisk.level, 'high', 'commit mode should be high risk')

  if (process.platform !== 'win32') {
    const parkedWorktree = `${worktreeDir}-parked`
    renameSync(worktreeDir, parkedWorktree)
    symlinkSync(projectDir, worktreeDir, 'dir')
    try {
      const replacedReport = delivery.runCodeForgeDelivery({
        cwd: worktreeDir,
        mode: 'report',
        worktreeContext
      })
      assert.equal(replacedReport.ok, false, 'symlink-replaced managed worktree must block report')
      assert.match(replacedReport.error, /身份校验失败/, 'managed worktree identity rejection missing')
      await assert.rejects(
        reconciler.buildEffectDescriptor(descriptorInput),
        /身份校验失败/,
        'symlink-replaced managed worktree must block descriptor creation'
      )
    } finally {
      rmSync(worktreeDir, { force: true })
      renameSync(parkedWorktree, worktreeDir)
    }
  }

  console.log('code forge smoke ok')
} finally {
  try {
    git(projectDir, ['worktree', 'remove', '--force', worktreeDir])
  } catch {
    // temp cleanup below is enough if git worktree metadata was already removed.
  }
  if (patchArtifactPath) rmSync(patchArtifactPath, { force: true })
  rmSync(tempRoot, { recursive: true, force: true })
}

function effectRecord(descriptor, input) {
  return {
    schemaVersion: 1,
    id: 'code-forge-patch-effect',
    effectKey: 'effect-key',
    resourceKey: 'resource-key',
    sessionId: input.sessionId,
    runId: 'run-id',
    toolUseId: 'tool-use-id',
    toolName: input.toolName,
    generation: 1,
    revision: 1,
    status: 'executing',
    reconcilability: descriptor.reconcilability,
    target: descriptor.target,
    targetDigest: descriptor.targetDigest,
    intentDigest: descriptor.intentDigest,
    inputDigest: descriptor.inputDigest,
    evidence: [],
    createdAt: 1,
    updatedAt: 1
  }
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'smoke@example.test'])
  git(dir, ['config', 'user.name', 'CaoGen Smoke'])
}

function writePassingContext(dir) {
  writeFileSync(
    path.join(dir, 'caogen.md'),
    [
      '# Project',
      'Code Forge smoke',
      '',
      '# Commands',
      '- lint: node -e "process.exit(0)"',
      '- test: node -e "process.exit(0)"',
      ''
    ].join('\n'),
    'utf8'
  )
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
