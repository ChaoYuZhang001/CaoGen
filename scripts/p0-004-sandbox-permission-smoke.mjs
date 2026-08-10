#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-p0-004-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')
const requireFromSmoke = createRequire(import.meta.url)

try {
  mkdirSync(projectDir)
  compileModules()

  const localExecution = requireFromSmoke(findCompiled('local-execution.js'))
  const safePath = requireFromSmoke(findCompiled('safe-project-path.js'))
  const permission = requireFromSmoke(findCompiled('tool-permission.js'))
  const audit = requireFromSmoke(findCompiled('audit-log.js'))
  const idempotency = requireFromSmoke(findCompiled('tool-idempotency.js'))

  await verifyLocalExecution(localExecution)
  await verifySafeProjectPath(safePath, localExecution)
  verifyPermission(permission)
  verifyAudit(audit)
  verifyOpenAiToolsBridge(idempotency)
  verifySecuritySettingsUi()
  verifyLocalExecutionBoundary()

  console.log('p0-004 local-execution/permission smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileModules() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/sandbox/local-execution.ts',
      'src/main/permission/tool-permission.ts',
      'src/main/permission/audit-log.ts',
      'src/main/task/tool-idempotency.ts',
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
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

async function verifyLocalExecution(localExecution) {
  await verifyCommandTermination(localExecution)

  const disabledWritePath = path.join(projectDir, 'disabled-write.txt')
  const disabledWrite = await localExecution.writeTextFileLocally({
    cwd: projectDir,
    targetPath: disabledWritePath,
    content: 'must-not-write\n',
    mode: 'disabled',
    timeoutMs: 10_000
  })
  assert(!disabledWrite.ok, 'legacy strict migration must keep local file writes disabled')
  assert(!existsSync(disabledWritePath), 'disabled local file write must not create a file')

  const standard = await localExecution.runLocalCommand({
    command: 'echo caogen-p0-004',
    cwd: projectDir,
    mode: 'restrictedLocal',
    timeoutMs: 10_000,
    maxBufferBytes: 1024 * 1024
  })
  assert(standard.ok, `local shell should pass: ${standard.output}`)
  assert(standard.commandTermination === 'exited', 'successful local shell must be classified as exited')
  assert(standard.output.includes('caogen-p0-004'), 'local shell output missing marker')
  assert(standard.modeUsed === 'restrictedLocal', `expected restrictedLocal mode, got ${standard.modeUsed}`)
  assert(standard.sandboxed === false, 'local shell must not be marked sandboxed')

  const guardedPath = path.join(projectDir, 'guarded-write.txt')
  const guardedBefore = Buffer.from('guarded-before\n', 'utf8')
  writeFileSync(guardedPath, guardedBefore)
  const guardedStat = statSync(guardedPath, { bigint: true })
  const guardedPrecondition = {
    identity: { device: guardedStat.dev.toString(), inode: guardedStat.ino.toString() },
    sha256: createHash('sha256').update(guardedBefore).digest('hex'),
    bytes: guardedBefore.byteLength
  }
  const guardedWrite = await localExecution.writeTextFileLocally({
    cwd: projectDir,
    targetPath: guardedPath,
    content: 'guarded-after\n',
    expectedFile: guardedPrecondition,
    mode: 'restrictedLocal',
    timeoutMs: 10_000
  })
  assert(guardedWrite.ok, `guarded host write should pass: ${guardedWrite.output}`)
  assert(readFileSync(guardedPath, 'utf8') === 'guarded-after\n', 'guarded host write content mismatch')

  writeFileSync(guardedPath, guardedBefore)
  const replacementPath = path.join(projectDir, 'guarded-replacement.txt')
  writeFileSync(replacementPath, guardedBefore)
  rmSync(guardedPath)
  renameSync(replacementPath, guardedPath)
  const replacedWrite = await localExecution.writeTextFileLocally({
    cwd: projectDir,
    targetPath: guardedPath,
    content: 'must-not-write\n',
    expectedFile: guardedPrecondition,
    mode: 'restrictedLocal',
    timeoutMs: 10_000
  })
  assert(!replacedWrite.ok, 'guarded host write must reject same-content inode replacement')
  assert(readFileSync(guardedPath, 'utf8') === 'guarded-before\n', 'rejected guarded write must preserve replacement content')

  const renamedDuringWritePath = path.join(projectDir, 'guarded-renamed-during-write.txt')
  const movedDuringWritePath = path.join(projectDir, 'guarded-original-after-rename.txt')
  const replacementDuringWritePath = path.join(projectDir, 'guarded-path-replacement.txt')
  writeFileSync(renamedDuringWritePath, guardedBefore)
  const renamedDuringWriteStat = statSync(renamedDuringWritePath, { bigint: true })
  const renamedDuringWrite = await localExecution.writeTextFileLocally({
    cwd: projectDir,
    targetPath: renamedDuringWritePath,
    content: 'must-not-report-success\n',
    expectedFile: {
      identity: {
        device: renamedDuringWriteStat.dev.toString(),
        inode: renamedDuringWriteStat.ino.toString()
      },
      sha256: createHash('sha256').update(guardedBefore).digest('hex'),
      bytes: guardedBefore.byteLength
    },
    mode: 'restrictedLocal',
    timeoutMs: 10_000,
    beforeGuardedCommit: () => {
      renameSync(renamedDuringWritePath, movedDuringWritePath)
      writeFileSync(replacementDuringWritePath, guardedBefore)
      renameSync(replacementDuringWritePath, renamedDuringWritePath)
    }
  })
  assert(!renamedDuringWrite.ok, 'guarded host write must reject target-path replacement after open')
  assert(
    readFileSync(renamedDuringWritePath, 'utf8') === 'guarded-before\n',
    'replacement at the canonical target path must remain untouched'
  )
  assert(
    readFileSync(movedDuringWritePath, 'utf8') === 'guarded-before\n',
    'the opened inode must remain unchanged when canonical path verification fails before commit'
  )

  const renamedInsideCheckPath = path.join(projectDir, 'guarded-renamed-inside-check.txt')
  const movedInsideCheckPath = path.join(projectDir, 'guarded-original-inside-check.txt')
  const replacementInsideCheckPath = path.join(projectDir, 'guarded-path-inside-check.txt')
  writeFileSync(renamedInsideCheckPath, guardedBefore)
  const renamedInsideCheckStat = statSync(renamedInsideCheckPath, { bigint: true })
  let injectedPreconditionRename = false
  const renamedInsideCheck = await localExecution.writeTextFileLocally({
    cwd: projectDir,
    targetPath: renamedInsideCheckPath,
    content: 'must-not-write-inside-check\n',
    expectedFile: {
      identity: {
        device: renamedInsideCheckStat.dev.toString(),
        inode: renamedInsideCheckStat.ino.toString()
      },
      sha256: createHash('sha256').update(guardedBefore).digest('hex'),
      bytes: guardedBefore.byteLength
    },
    mode: 'restrictedLocal',
    timeoutMs: 10_000,
    beforeGuardedPathVerificationRead: (phase) => {
      if (phase !== 'precondition' || injectedPreconditionRename) return
      injectedPreconditionRename = true
      renameSync(renamedInsideCheckPath, movedInsideCheckPath)
      writeFileSync(replacementInsideCheckPath, guardedBefore)
      renameSync(replacementInsideCheckPath, renamedInsideCheckPath)
    }
  })
  assert(!renamedInsideCheck.ok, 'guarded path verification must reject rename after opening its read fd')
  assert(readFileSync(renamedInsideCheckPath, 'utf8') === 'guarded-before\n', 'replacement path must stay unchanged')
  assert(readFileSync(movedInsideCheckPath, 'utf8') === 'guarded-before\n', 'opened inode must stay unchanged')

  const postCheckPath = path.join(projectDir, 'guarded-renamed-during-postcheck.txt')
  const postCheckMoved = path.join(projectDir, 'guarded-written-inode-after-postcheck-rename.txt')
  const postCheckReplacement = path.join(projectDir, 'guarded-postcheck-replacement.txt')
  writeFileSync(postCheckPath, guardedBefore)
  const postCheckStat = statSync(postCheckPath, { bigint: true })
  let injectedPostconditionRename = false
  const postCheckResult = await localExecution.writeTextFileLocally({
    cwd: projectDir,
    targetPath: postCheckPath,
    content: 'written-before-postcheck\n',
    expectedFile: {
      identity: {
        device: postCheckStat.dev.toString(),
        inode: postCheckStat.ino.toString()
      },
      sha256: createHash('sha256').update(guardedBefore).digest('hex'),
      bytes: guardedBefore.byteLength
    },
    mode: 'restrictedLocal',
    timeoutMs: 10_000,
    beforeGuardedPathVerificationRead: (phase) => {
      if (phase !== 'postcondition' || injectedPostconditionRename) return
      injectedPostconditionRename = true
      renameSync(postCheckPath, postCheckMoved)
      writeFileSync(postCheckReplacement, 'concurrent-postcheck-replacement\n')
      renameSync(postCheckReplacement, postCheckPath)
    }
  })
  assert(!postCheckResult.ok, 'guarded postcondition must not report success after canonical path replacement')
  assert(
    readFileSync(postCheckPath, 'utf8') === 'concurrent-postcheck-replacement\n',
    'canonical replacement must remain untouched after postcondition failure'
  )
  assert(
    readFileSync(postCheckMoved, 'utf8') === 'written-before-postcheck\n',
    'the moved approved inode should expose the write that occurred before postcondition verification'
  )

  const absentParent = path.join(projectDir, 'guarded-absent-parent')
  const absentParentMoved = path.join(projectDir, 'guarded-absent-parent-original')
  const absentOutside = path.join(tempRoot, 'guarded-absent-outside')
  const absentTarget = path.join(absentParent, 'new.txt')
  const approvedProjectRoot = realpathSync(projectDir)
  const approvedProjectRootInfo = statSync(approvedProjectRoot, { bigint: true })
  mkdirSync(absentParent)
  mkdirSync(absentOutside)
  const absentParentEscape = await localExecution.writeTextFileLocally({
    cwd: projectDir,
    targetPath: absentTarget,
    content: 'must-stay-inside-project\n',
    expectedFile: {
      state: 'absent',
      rootPath: approvedProjectRoot,
      rootIdentity: {
        device: approvedProjectRootInfo.dev.toString(),
        inode: approvedProjectRootInfo.ino.toString()
      }
    },
    mode: 'restrictedLocal',
    timeoutMs: 10_000,
    beforeGuardedCommit: () => {
      const tempName = readdirSync(absentParent).find((name) => name.endsWith('.caogen-write.tmp'))
      if (!tempName) throw new Error('absent parent race fixture could not find guarded temp file')
      renameSync(absentParent, absentParentMoved)
      symlinkSync(absentOutside, absentParent, 'dir')
      linkSync(path.join(absentParentMoved, tempName), path.join(absentOutside, tempName))
    }
  })
  assert(!absentParentEscape.ok, 'guarded absent write must reject parent replacement with an outside symlink')
  assert(!existsSync(path.join(absentOutside, 'new.txt')), 'guarded absent write must not publish outside the project')

  const approvedRoot = path.join(tempRoot, 'approved-root')
  const approvedRootMoved = path.join(tempRoot, 'approved-root-original')
  mkdirSync(approvedRoot)
  const approvedRootPath = realpathSync(approvedRoot)
  const approvedRootInfo = statSync(approvedRootPath, { bigint: true })
  renameSync(approvedRoot, approvedRootMoved)
  mkdirSync(approvedRoot)
  const replacedRootWrite = await localExecution.writeTextFileLocally({
    cwd: approvedRoot,
    targetPath: path.join(approvedRoot, 'nested', 'must-not-create.txt'),
    content: 'unapproved-root\n',
    expectedFile: {
      state: 'absent',
      rootPath: approvedRootPath,
      rootIdentity: {
        device: approvedRootInfo.dev.toString(),
        inode: approvedRootInfo.ino.toString()
      }
    },
    mode: 'restrictedLocal',
    timeoutMs: 10_000
  })
  assert(!replacedRootWrite.ok, 'guarded absent write must stay bound to the Effect-approved project root')
  assert(!existsSync(path.join(approvedRoot, 'nested')), 'replacement root must remain untouched')
}

async function verifyCommandTermination(localExecution) {
  const disabledCommand = await localExecution.runLocalCommand({
    command: 'echo must-not-run', cwd: projectDir, mode: 'disabled',
    timeoutMs: 10_000, maxBufferBytes: 1024 * 1024
  })
  assert(!disabledCommand.ok, 'legacy strict migration must keep local commands disabled')
  assert(disabledCommand.modeUsed === 'disabled', 'disabled local command must report the migration mode')
  assert(disabledCommand.commandTermination === 'not_started', 'disabled command must not claim process exit')
  assert(disabledCommand.output.includes('不会自动降级为宿主机执行'), 'disabled command must explain the safety boundary')
  const emptyCommand = await localExecution.runLocalCommand({
    command: '   ', cwd: projectDir, mode: 'restrictedLocal', timeoutMs: 10_000, maxBufferBytes: 1024
  })
  assert(emptyCommand.commandTermination === 'not_started', 'empty command must be classified as not started')
  const preAborted = new AbortController()
  preAborted.abort()
  const abortedCommand = await localExecution.runLocalCommand({
    command: nodeCommand('setTimeout(() => {}, 1000)'), cwd: projectDir, mode: 'restrictedLocal',
    timeoutMs: 10_000, maxBufferBytes: 1024, signal: preAborted.signal
  })
  assert(abortedCommand.commandTermination === 'aborted', 'pre-aborted command must be classified as aborted')
  const timedOutCommand = await localExecution.runLocalCommand({
    command: nodeCommand('setTimeout(() => {}, 1000)'), cwd: projectDir, mode: 'restrictedLocal',
    timeoutMs: 250, maxBufferBytes: 1024
  })
  assert(
    timedOutCommand.commandTermination === 'timed_out',
    `timed-out command must retain its termination cause: ${JSON.stringify({
      ok: timedOutCommand.ok,
      exitCode: timedOutCommand.exitCode,
      commandTermination: timedOutCommand.commandTermination
    })}`
  )
  const outputLimitedCommand = await localExecution.runLocalCommand({
    command: nodeCommand("process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 1000)"),
    cwd: projectDir, mode: 'restrictedLocal', timeoutMs: 10_000, maxBufferBytes: 32
  })
  assert(outputLimitedCommand.commandTermination === 'output_limit', 'output-limited command must retain its termination cause')
  const spawnErrorCommand = await localExecution.runLocalCommand({
    command: 'echo unreachable', cwd: path.join(tempRoot, 'missing-command-cwd'), mode: 'restrictedLocal',
    timeoutMs: 10_000, maxBufferBytes: 1024
  })
  assert(spawnErrorCommand.commandTermination === 'spawn_error', 'spawn failure must not claim process exit')
  const failedExit = await localExecution.runLocalCommand({
    command: nodeCommand('process.exit(7)'), cwd: projectDir, mode: 'restrictedLocal',
    timeoutMs: 10_000, maxBufferBytes: 1024
  })
  assert(failedExit.commandTermination === 'exited', 'nonzero process exit must remain an exited command')
  assert(failedExit.exitCode === 7, 'nonzero process exit must preserve the real exit code')
}

async function verifySafeProjectPath(safePath, localExecution) {
  const outsideDir = path.join(tempRoot, 'outside')
  const outsideFile = path.join(outsideDir, 'secret.txt')
  const linkDir = path.join(projectDir, 'linked-outside')
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(outsideFile, 'outside-secret\n', 'utf8')

  try {
    symlinkSync(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    console.log('skip symlink/junction path jail check: current account cannot create directory link')
    return
  }

  let readRejected = false
  try {
    await safePath.resolveExistingProjectPath(projectDir, path.join('linked-outside', 'secret.txt'))
  } catch {
    readRejected = true
  }
  assert(readRejected, 'safe project path must reject symlink/junction read escape')

  const writeAttempt = await localExecution.writeTextFileLocally({
    cwd: projectDir,
    targetPath: path.join(projectDir, 'linked-outside', 'secret.txt'),
    content: 'owned\n',
    mode: 'restrictedLocal',
    timeoutMs: 10_000
  })
  assert(!writeAttempt.ok, `restricted local write must reject symlink/junction escape: ${writeAttempt.output}`)
  assert(readFileSync(outsideFile, 'utf8') === 'outside-secret\n', 'outside file must remain unchanged')
}

function verifyPermission(permission) {
  const low = permission.classifyToolRisk('read_file', { path: 'src/a.ts' }, projectDir)
  assert(low.level === 'low', `read_file should be low risk, got ${low.level}`)

  const edit = permission.classifyToolRisk('write_file', { path: 'src/a.ts' }, projectDir)
  assert(edit.level === 'medium', `write_file should be medium risk, got ${edit.level}`)

  const preview = permission.classifyToolRisk(
    'search_replace',
    { file_path: 'src/a.ts', replacements: [], dry_run: true },
    projectDir
  )
  assert(preview.level === 'low', `search_replace dry_run should be low risk, got ${preview.level}`)

  const destructive = permission.classifyToolRisk('bash', { command: 'rm -rf /' }, projectDir)
  assert(destructive.level === 'critical', `destructive bash should be critical, got ${destructive.level}`)
  assert(destructive.capabilities.length === 5 && destructive.capabilities.includes('network'),
    'bash must expose the complete composite capability set')

  const escape = permission.classifyToolRisk('read_file', { path: '../secret.txt' }, projectDir)
  assert(escape.level === 'critical', `path escape should be critical, got ${escape.level}`)

  const dagEscape = permission.classifyToolRisk('task_dispatch_dag', { cwd: path.join(tempRoot, 'outside-dag') }, projectDir)
  assert(dagEscape.level === 'critical', `DAG cwd escape should be critical, got ${dagEscape.level}`)

  const deny = permission.evaluateToolPermission(
    settings({ permissionDenylist: 'tool=bash risk>=high' }),
    { toolName: 'bash', input: { command: 'rm -rf /' }, cwd: projectDir }
  )
  assert(deny.kind === 'deny', `denylist should deny high risk bash, got ${deny.kind}`)

  const allow = permission.evaluateToolPermission(
    settings({ permissionAllowlist: 'tool=bash risk<=low' }),
    { toolName: 'bash', input: { command: 'echo safe' }, cwd: projectDir }
  )
  assert(allow.kind === 'neutral', `legacy allowlist must not silently allow composite bash, got ${allow.kind}`)

  const pathAllow = permission.evaluateToolPermission(
    settings({ permissionAllowlist: 'tool=write_file path=src/**' }),
    { toolName: 'write_file', input: { path: 'src/a.ts' }, cwd: projectDir }
  )
  assert(pathAllow.kind === 'allow', `path allowlist should allow src write, got ${pathAllow.kind}`)

  const temporary = permission.evaluateToolPermission(
    settings({ permissionTemporaryAllowlist: `tool=bash risk<=low until=${Date.now() + 60_000}` }),
    { toolName: 'bash', input: { command: 'echo temp' }, cwd: projectDir }
  )
  assert(temporary.kind === 'neutral', `legacy temporary allow must not silently allow composite bash, got ${temporary.kind}`)

  const expired = permission.evaluateToolPermission(
    settings({ permissionTemporaryAllowlist: `tool=bash risk<=low until=${Date.now() - 1}` }),
    { toolName: 'bash', input: { command: 'echo temp' }, cwd: projectDir }
  )
  assert(expired.kind === 'neutral', `expired temporary allow should be neutral, got ${expired.kind}`)

  const structuredAllow = permission.evaluateToolPermission(
    settings({
      permissionRules: [{
        id: 'allow-src-write', enabled: true, effect: 'allow', toolPattern: 'write_*',
        pathPattern: 'src/**', capabilityScope: ['workspaceWrite'], riskLevel: 'medium', riskOperator: 'exact'
      }]
    }),
    { toolName: 'write_file', input: { path: 'src/structured.ts' }, cwd: projectDir }
  )
  assert(structuredAllow.kind === 'allow', `structured rule should allow exact scoped write, got ${structuredAllow.kind}`)
  assert(structuredAllow.matchedRule === '规则 allow-src-write', 'structured decision must identify the matching rule')

  const structuredDeny = permission.evaluateToolPermission(
    settings({
      permissionRules: [
        {
          id: 'allow-shell', enabled: true, effect: 'allow', toolPattern: 'bash', pathPattern: '',
          riskLevel: 'low', riskOperator: 'atMost'
        },
        {
          id: 'deny-all-shell', enabled: true, effect: 'deny', toolPattern: 'bash', pathPattern: '',
          riskOperator: 'exact'
        }
      ]
    }),
    { toolName: 'bash', input: { command: 'echo structured' }, cwd: projectDir }
  )
  assert(structuredDeny.kind === 'deny', 'structured deny must take precedence over structured allow')

  const structuredExpired = permission.evaluateToolPermission(
    settings({
      permissionRules: [{
        id: 'expired-shell', enabled: true, effect: 'allow', toolPattern: 'bash', pathPattern: '',
        riskOperator: 'exact', expiresAt: 9_999
      }]
    }),
    { toolName: 'bash', input: { command: 'echo expired' }, cwd: projectDir, now: 10_000 }
  )
  assert(structuredExpired.kind === 'neutral', 'structured rule must expire at the exact boundary')

  const invalidRules = permission.validatePermissionRules([{
    id: 'typo-rule', enabled: true, effect: 'allow', toolPattern: 'write_file', pathPattern: '',
    riskOperator: 'exact', toolPatern: 'bash'
  }])
  assert(!invalidRules.ok, 'unknown structured fields must fail validation instead of being ignored')
  assert(invalidRules.issues.some((issue) => issue.message.includes('toolPatern')), 'validation must name the unknown field')
  let emptyRuleError = ''
  try {
    permission.normalizePermissionRules([{
      id: 'empty', enabled: true, effect: 'allow', toolPattern: '', pathPattern: '', riskOperator: 'exact'
    }])
  } catch (error) {
    emptyRuleError = error instanceof Error ? error.message : String(error)
  }
  assert(
    emptyRuleError.includes('至少选择工具、路径、语义范围或风险条件之一'),
    `selector-free structured rule must fail closed: ${emptyRuleError}`
  )

  const semanticBashRule = {
    id: 'allow-test-command', enabled: true, effect: 'allow', toolPattern: 'bash', pathPattern: '',
    commandPattern: 'npm test*', networkHostPattern: '', guiApplicationPattern: '', guiWindowPattern: '',
    mcpToolPattern: '', capabilityScope: ['workspaceRead', 'workspaceWrite', 'terminal', 'browser', 'network'],
    requirePostcondition: false, riskLevel: 'medium', riskOperator: 'atMost'
  }
  const semanticBashAllow = permission.evaluateToolPermission(
    settings({ permissionRules: [semanticBashRule] }),
    { toolName: 'bash', input: { command: 'npm test -- --runInBand' }, cwd: projectDir }
  )
  assert(semanticBashAllow.kind === 'allow', 'command semantic rule must match the complete command scope')
  const semanticBashMismatch = permission.evaluateToolPermission(
    settings({ permissionRules: [semanticBashRule] }),
    { toolName: 'bash', input: { command: 'npm publish' }, cwd: projectDir }
  )
  assert(semanticBashMismatch.kind === 'neutral', 'command drift must not match a semantic allow rule')
  const terminalOnlyBash = permission.evaluateToolPermission(
    settings({ permissionRules: [{ ...semanticBashRule, id: 'terminal-only-bash', capabilityScope: ['terminal'] }] }),
    { toolName: 'bash', input: { command: 'npm test -- --runInBand' }, cwd: projectDir }
  )
  assert(terminalOnlyBash.kind === 'neutral', 'terminal-only scope must not allow composite bash')

  const networkRule = {
    id: 'allow-doc-host', enabled: true, effect: 'allow', toolPattern: 'browser_navigate', pathPattern: '',
    commandPattern: '', networkHostPattern: '*.example.com', guiApplicationPattern: '', guiWindowPattern: '',
    mcpToolPattern: '', capabilityScope: ['browser', 'network'], requirePostcondition: false, riskOperator: 'exact'
  }
  const networkAllow = permission.evaluateToolPermission(
    settings({ permissionRules: [networkRule] }),
    { toolName: 'browser_navigate', input: { url: 'https://docs.example.com/guide?token=not-inspected' }, cwd: projectDir }
  )
  assert(networkAllow.kind === 'allow', 'network rule must match the normalized hostname without URL secrets')
  const networkMismatch = permission.evaluateToolPermission(
    settings({ permissionRules: [networkRule] }),
    { toolName: 'browser_navigate', input: { url: 'https://example.net/guide' }, cwd: projectDir }
  )
  assert(networkMismatch.kind === 'neutral', 'network host drift must not match')

  const guiRule = {
    id: 'allow-editor-save', enabled: true, effect: 'allow', toolPattern: 'gui_click', pathPattern: '',
    commandPattern: '', networkHostPattern: '', guiApplicationPattern: 'editor.exe', guiWindowPattern: '*Settings*',
    mcpToolPattern: '', capabilityScope: ['workspaceRead', 'workspaceWrite', 'terminal', 'browser', 'network'],
    requirePostcondition: true, riskLevel: 'high', riskOperator: 'exact'
  }
  const guiInput = {
    processName: 'editor.exe', title: 'Editor Settings', automationId: 'save',
    postcondition: { kind: 'window', state: 'exists', processName: 'editor.exe', title: 'Editor Settings' }
  }
  const guiAllow = permission.evaluateToolPermission(
    settings({ permissionRules: [guiRule] }),
    { toolName: 'gui_click', input: guiInput, cwd: projectDir }
  )
  assert(guiAllow.kind === 'allow', 'GUI rule must match app window and a valid bounded postcondition')
  const guiVisualAllow = permission.evaluateToolPermission(
    settings({ permissionRules: [guiRule] }),
    {
      toolName: 'gui_click',
      input: {
        ...guiInput,
        postcondition: {
          kind: 'visual', state: 'changed', processName: 'editor.exe', title: 'Editor Settings',
          minimumChangedRatio: 0.0001, pixelDifferenceThreshold: 16
        }
      },
      cwd: projectDir
    }
  )
  assert(guiVisualAllow.kind === 'allow', 'GUI rule must accept a same-target bounded visual postcondition')
  for (const [label, input] of [
    ['application', { ...guiInput, processName: 'other.exe' }],
    ['window', { ...guiInput, title: 'Other window' }],
    ['postcondition', { ...guiInput, postcondition: undefined }],
    ['invalid postcondition', { ...guiInput, postcondition: { kind: 'window', state: 'exists' } }],
    ['different postcondition target', {
      ...guiInput,
      postcondition: { kind: 'window', state: 'exists', processName: 'other.exe', title: 'Other window' }
    }],
    ['coordinate precedence', { ...guiInput, automationId: undefined, x: 10, y: 20 }]
  ]) {
    const decision = permission.evaluateToolPermission(
      settings({ permissionRules: [guiRule] }),
      { toolName: 'gui_click', input, cwd: projectDir }
    )
    assert(decision.kind === 'neutral', `${label} drift must not match the GUI semantic rule`)
  }

  const mcpRule = {
    id: 'allow-mcp-read', enabled: true, effect: 'allow', toolPattern: 'mcp_call_tool', pathPattern: '',
    commandPattern: '', networkHostPattern: 'mcp.example.com', guiApplicationPattern: '', guiWindowPattern: '',
    mcpToolPattern: 'read_*', mcpArgumentPointer: '/scope/project', mcpArgumentPattern: 'alpha-*',
    capabilityScope: ['workspaceRead', 'workspaceWrite', 'terminal', 'browser', 'network'],
    requirePostcondition: false, riskLevel: 'high', riskOperator: 'exact'
  }
  const mcpAllow = permission.evaluateToolPermission(
    settings({ permissionRules: [mcpRule] }),
    {
      toolName: 'mcp_call_tool',
      input: {
        url: 'https://mcp.example.com/rpc', toolName: 'read_state',
        arguments: { scope: { project: 'alpha-one' } }
      },
      cwd: projectDir
    }
  )
  assert(mcpAllow.kind === 'allow', 'MCP rule must bind endpoint host, tool name, and argument scope')
  const mcpMismatch = permission.evaluateToolPermission(
    settings({ permissionRules: [mcpRule] }),
    {
      toolName: 'mcp_call_tool',
      input: {
        url: 'https://mcp.example.com/rpc', toolName: 'write_state',
        arguments: { scope: { project: 'alpha-one' } }
      },
      cwd: projectDir
    }
  )
  assert(mcpMismatch.kind === 'neutral', 'MCP tool drift must not match')
  const mcpArgumentMismatch = permission.evaluateToolPermission(
    settings({ permissionRules: [mcpRule] }),
    {
      toolName: 'mcp_call_tool',
      input: {
        url: 'https://mcp.example.com/rpc', toolName: 'read_state',
        arguments: { scope: { project: 'beta-one' } }
      },
      cwd: projectDir
    }
  )
  assert(mcpArgumentMismatch.kind === 'neutral', 'MCP argument drift must not match')

  const dynamicMcpRule = {
    ...mcpRule,
    id: 'allow-dynamic-mcp-read',
    toolPattern: 'mcp__*',
    networkHostPattern: '',
    mcpToolPattern: 'mcp__demo__read_*'
  }
  const dynamicMcpInput = { scope: { project: 'alpha-two' } }
  const dynamicMcpAllow = permission.evaluateToolPermission(
    settings({ permissionRules: [dynamicMcpRule] }),
    { toolName: 'mcp__demo__read_state', input: dynamicMcpInput, cwd: projectDir }
  )
  assert(dynamicMcpAllow.kind === 'allow', 'dynamic MCP rule must bind canonical tool name and direct arguments')
  assert(dynamicMcpAllow.risk.level === 'high', 'dynamic MCP tools must remain high risk')
  assert(dynamicMcpAllow.risk.capabilities.length === 5,
    'dynamic MCP tools must expose the complete composite capability set')
  const malformedDynamicMcp = permission.evaluateToolPermission(
    settings({ permissionRules: [dynamicMcpRule] }),
    { toolName: 'mcp__malformed', input: dynamicMcpInput, cwd: projectDir }
  )
  assert(malformedDynamicMcp.kind === 'neutral', 'malformed MCP names must not match semantic rules')
  assert(malformedDynamicMcp.risk.level === 'high', 'malformed MCP namespace names must not downgrade risk')
  for (const [toolName, input] of [
    ['mcp__other__read_state', dynamicMcpInput],
    ['mcp__demo__read_state', { scope: { project: 'beta-two' } }]
  ]) {
    const decision = permission.evaluateToolPermission(
      settings({ permissionRules: [dynamicMcpRule] }),
      { toolName, input, cwd: projectDir }
    )
    assert(decision.kind === 'neutral', 'dynamic MCP tool or argument drift must not match')
    assert(decision.risk.level === 'high', 'dynamic MCP drift must not reduce risk')
  }

  const invalidSemanticRules = permission.validatePermissionRules([{
    id: 'invalid-host', enabled: true, effect: 'allow', toolPattern: '', pathPattern: '',
    networkHostPattern: 'https://example.com/path', riskOperator: 'exact'
  }])
  assert(!invalidSemanticRules.ok, 'network host selector must reject URLs and paths')
  const invalidPostconditionType = permission.validatePermissionRules([{
    id: 'invalid-postcondition', enabled: true, effect: 'allow', toolPattern: 'gui_*', pathPattern: '',
    requirePostcondition: 'yes', riskOperator: 'exact'
  }])
  assert(!invalidPostconditionType.ok, 'postcondition selector must reject non-boolean values')
  const incompleteMcpArgumentRule = permission.validatePermissionRules([{
    id: 'incomplete-mcp-argument', enabled: true, effect: 'allow', toolPattern: 'mcp__*', pathPattern: '',
    mcpArgumentPointer: '/scope/project', riskOperator: 'exact'
  }])
  assert(!incompleteMcpArgumentRule.ok, 'MCP argument pointer and pattern must be required as a pair')
  const sensitiveMcpPointerRule = permission.validatePermissionRules([{
    id: 'sensitive-mcp-argument', enabled: true, effect: 'allow', toolPattern: 'mcp__*', pathPattern: '',
    mcpArgumentPointer: '/auth/apiKey', mcpArgumentPattern: '*', riskOperator: 'exact'
  }])
  assert(!sensitiveMcpPointerRule.ok, 'MCP argument rules must reject sensitive pointer segments')
  const invalidCapabilityRule = permission.validatePermissionRules([{
    id: 'invalid-capability', enabled: true, effect: 'allow', toolPattern: 'write_file', pathPattern: '',
    capabilityScope: ['workspaceWrite', 'rootAccess'], riskOperator: 'exact'
  }])
  assert(!invalidCapabilityRule.ok, 'capability scope must reject unknown capabilities')
  const duplicateCapabilityRule = permission.validatePermissionRules([{
    id: 'duplicate-capability', enabled: true, effect: 'deny', toolPattern: '', pathPattern: '',
    capabilityScope: ['network', 'network'], riskOperator: 'exact'
  }])
  assert(!duplicateCapabilityRule.ok, 'capability scope must reject duplicate capabilities')

  const denyNetwork = {
    id: 'deny-network-capability', enabled: true, effect: 'deny', toolPattern: '', pathPattern: '',
    capabilityScope: ['network'], riskOperator: 'exact'
  }
  for (const [toolName, input] of [
    ['bash', { command: 'echo composite' }],
    ['mcp_call_tool', { toolName: 'read_state', arguments: {} }],
    ['mcp__demo__read_state', {}],
    ['gui_click', { processName: 'editor.exe', title: 'Editor' }]
  ]) {
    const decision = permission.evaluateToolPermission(
      settings({ permissionRules: [denyNetwork] }),
      { toolName, input, cwd: projectDir }
    )
    assert(decision.kind === 'deny', `network deny scope must block composite tool ${toolName}`)
  }

  const legacyV1CompositeAllow = permission.evaluateToolPermission(
    settings({ permissionRules: [{
      id: 'legacy-v1-bash', enabled: true, effect: 'allow', toolPattern: 'bash', pathPattern: '',
      riskOperator: 'exact'
    }] }),
    { toolName: 'bash', input: { command: 'echo legacy' }, cwd: projectDir }
  )
  assert(legacyV1CompositeAllow.kind === 'neutral', 'v1 composite allow without capability scope must fail closed')

  const migrated = permission.migrateLegacyPermissionRules({
    permissionDenylist: 'tool=bash risk>=high',
    permissionAllowlist: 'tool=write_file path=src/**',
    permissionTemporaryAllowlist: 'tool=git_commit until=20000'
  }, 10_000)
  assert(migrated.length === 3, `legacy migration should preserve three active rules, got ${migrated.length}`)
  assert(migrated[0].effect === 'deny' && migrated[0].riskOperator === 'atLeast', 'legacy deny risk comparison changed')
  assert(migrated[1].expiresAt === 20_000, 'legacy temporary expiry changed')
  assert(migrated[2].pathPattern === 'src/**', 'legacy path scope changed')
  assert(
    migrated.every((rule) => rule.commandPattern === '' && rule.networkHostPattern === '' &&
      rule.guiApplicationPattern === '' && rule.guiWindowPattern === '' &&
      rule.mcpToolPattern === '' && rule.capabilityScope.length === 0 && rule.requirePostcondition === false),
    'legacy rules must migrate with neutral semantic selectors'
  )
}

function verifyAudit(audit) {
  const auditDir = path.join(projectDir, '.caogen')
  const auditPath = path.join(auditDir, 'audit.log')
  mkdirSync(auditDir)
  writeFileSync(auditPath, `${JSON.stringify({
    ts: '2026-01-01T00:00:00.000Z',
    action: 'deny',
    source: 'policy',
    toolName: 'legacy-v0'
  })}\n`, { encoding: 'utf8', mode: 0o600 })

  audit.writeAuditLog(projectDir, {
    action: 'execute',
    source: 'local-execution',
    toolName: 'bash',
    riskLevel: 'low',
    riskReasons: ['smoke'],
    capabilities: ['workspaceRead', 'workspaceWrite', 'terminal', 'browser', 'network'],
    input: { command: 'echo audit' },
    ok: true,
    sandboxMode: 'restrictedLocal',
    modeUsed: 'restrictedLocal',
    sandboxed: false
  })
  const text = readFileSync(auditPath, 'utf8')
  const lines = text.trim().split(/\r?\n/)
  const parsedRecords = lines.map((candidate) => JSON.parse(candidate))
  const line = lines.at(-1)
  assert(line, 'audit log should contain at least one line')
  const record = JSON.parse(line)
  assert(parsedRecords.length === 2, 'legacy v0 and v1 audit records must coexist in one JSONL file')
  assert(parsedRecords[0].schemaVersion === undefined, 'legacy v0 audit record must remain unchanged')
  assert(record.schemaVersion === 1, 'execute audit record must declare schemaVersion 1')
  assert(record.toolName === 'bash', 'audit record toolName mismatch')
  assert(record.action === 'execute', 'audit record action mismatch')
  assert(record.capabilities.length === 5 && record.capabilities.includes('network'),
    'audit record must retain the main-process capability set')
  assert(record.input === undefined, 'audit record must never persist raw input')
  assert(record.inputSummary.startsWith('command bytes='), 'audit record should store only command metadata')
  assert(record.inputDigest && !record.inputSummary.includes('echo audit'), 'audit command summary must use a digest')
  if (process.platform !== 'win32') {
    assert((statSync(auditPath).mode & 0o777) === 0o600, 'project audit log must use mode 0600')
  }

  const tornProjectDir = path.join(tempRoot, 'torn-audit-project')
  const tornAuditDir = path.join(tornProjectDir, '.caogen')
  const tornAuditPath = path.join(tornAuditDir, 'audit.log')
  const tornTail = '{"schemaVersion":1,"action":"deny"'
  mkdirSync(tornAuditDir, { recursive: true })
  writeFileSync(tornAuditPath, tornTail, { encoding: 'utf8', mode: 0o600 })
  audit.writeAuditLog(tornProjectDir, {
    action: 'execute',
    source: 'local-execution',
    toolName: 'torn-tail-recovery'
  })
  const recoveredAudit = readFileSync(tornAuditPath, 'utf8')
  const recoveredLines = recoveredAudit.trim().split(/\r?\n/)
  assert(recoveredAudit.startsWith(`${tornTail}\n`), 'torn audit tail bytes must be retained behind a framing newline')
  assert(JSON.parse(recoveredLines.at(-1)).schemaVersion === 1, 'first record after a torn tail must remain parseable')

  const sentinel = 'AUDIT_SENTINEL_SECRET_7f2d'
  audit.writeAuditLog(projectDir, {
    action: 'ask',
    source: 'permission-mode',
    toolName: 'write_file',
    input: { path: 'src/private.txt', content: sentinel, authorization: `Bearer ${sentinel}` },
    message: `token=${sentinel}`
  })
  const sanitizedText = readFileSync(auditPath, 'utf8')
  assert(!sanitizedText.includes(sentinel), 'audit log must not contain raw secrets or file content')
  const sanitizedRecord = JSON.parse(sanitizedText.trim().split(/\r?\n/).at(-1))
  assert(sanitizedRecord.input === undefined, 'sanitized audit record must omit input property')
  assert(sanitizedRecord.inputSummary.includes('path=src/private.txt'), 'write audit should retain safe target metadata')

  const userDataRoot = path.join(tempRoot, 'user-data')
  audit.configurePermissionAuditUserDataRoot(userDataRoot)
  audit.writeSessionAuditLog({ id: 'view/session', cwd: projectDir, taskStrategy: 'view' }, {
    action: 'deny',
    source: 'task-strategy',
    toolName: 'write_file',
    input: { path: 'must-not-write.txt' }
  })
  const taskAuditPath = path.join(userDataRoot, 'task-audit', 'view_session.jsonl')
  const taskAuditRecord = JSON.parse(readFileSync(taskAuditPath, 'utf8').trim())
  assert(taskAuditRecord.schemaVersion === 1, 'private task audit record must declare schemaVersion 1')
  assert(taskAuditRecord.source === 'task-strategy', 'view audit must retain the task-strategy denial source')
  if (process.platform !== 'win32') {
    assert((statSync(taskAuditPath).mode & 0o777) === 0o600, 'private task audit must use mode 0600')
    assert((statSync(path.dirname(taskAuditPath)).mode & 0o777) === 0o700, 'private task audit directory must use mode 0700')
  }

  const redirectedUserDataRoot = path.join(tempRoot, 'redirected-user-data')
  const redirectTarget = path.join(tempRoot, 'redirect-target')
  mkdirSync(redirectedUserDataRoot)
  mkdirSync(redirectTarget)
  symlinkSync(redirectTarget, path.join(redirectedUserDataRoot, 'task-audit'), process.platform === 'win32' ? 'junction' : 'dir')
  audit.configurePermissionAuditUserDataRoot(redirectedUserDataRoot)
  audit.writeSessionAuditLog({ id: 'redirected', cwd: projectDir, taskStrategy: 'plan' }, {
    action: 'deny',
    source: 'task-strategy',
    toolName: 'write_file'
  })
  assert(
    !existsSync(path.join(redirectTarget, 'redirected.jsonl')),
    'private task audit must reject a pre-positioned symlink or junction directory'
  )
}

function verifyOpenAiToolsBridge(idempotency) {
  const text = readFileSync(path.join(repoRoot, 'src/main/openaiTools.ts'), 'utf8')
  assert(text.includes("options.sandboxMode ?? 'restrictedLocal'"), 'bash must default to restricted local execution')
  assert(text.includes('runLocalCommand'), 'bash must call local command wrapper')
  assert(text.includes('exitCode: result.exitCode'), 'bash must preserve the structured process exit code')
  assert(
    text.includes('commandTermination: result.commandTermination'),
    'bash must preserve the structured command termination cause'
  )
  assert(text.includes('writeTextFileLocally'), 'file writes must call guarded local writer')
  assert(text.includes('localFileWrite'), 'OpenAI file tools must route through localFileWrite')
  for (const marker of ["case 'bash'", "case 'read_file'", "case 'write_file'"]) {
    assert(text.includes(marker), `openaiTools missing ${marker}`)
  }
  const engine = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
  assert(
    engine.match(/commandTermination: exec\.commandTermination/g)?.length === 2,
    'OpenAI Responses and Chat bridges must both emit command termination'
  )
  assert(
    engine.includes('new NativeToolRuntime(this.meta') &&
      engine.includes('this.nativeToolRuntime.executeToolWithPermission(name, input, toolUseId, signal)'),
    'OpenAI engine must delegate every Agent tool through the shared native permission runtime'
  )
  const nativeRuntime = readFileSync(path.join(repoRoot, 'src/main/native-tool-runtime.ts'), 'utf8')
  assert(
    nativeRuntime.includes("settings.sandboxMode === 'disabled' && !disabledModeInspectionCall"),
    'native permission runtime must block every mutating Agent tool while legacy local execution awaits confirmation'
  )
  const anthropicEngine = readFileSync(path.join(repoRoot, 'src/main/anthropicEngine.ts'), 'utf8')
  assert(
    anthropicEngine.includes('commandTermination: execution.commandTermination'),
    'Anthropic bridge must emit command termination'
  )
  const disabledAllowed = [...idempotency.OPENAI_DISABLED_MODE_INSPECTION_TOOLS].sort()
  assert(
    JSON.stringify(disabledAllowed) === JSON.stringify([
      'find_file',
      'list_dir',
      'read_file',
      'search_code',
      'search_symbol',
      'view'
    ]),
    `disabled OpenAI mode must expose only pure project reads: ${disabledAllowed.join(', ')}`
  )
  for (const blocked of ['git_status', 'git_diff', 'run_skill', 'browser_automation_status', 'genesis_orchestrate']) {
    assert(
      !idempotency.isDisabledModeInspectionToolCall(blocked),
      `disabled OpenAI mode must not classify ${blocked} as a pure read`
    )
  }
}

function verifyLocalExecutionBoundary() {
  const executionSource = readFileSync(path.join(repoRoot, 'src/main/sandbox/local-execution.ts'), 'utf8')
  for (const marker of [
    'resolveWritableProjectPath',
    'safeOpenFlags(constants.O_RDWR)',
    'verifyFileWritePostcondition',
    'guarded target path or content changed',
    'guarded target postcondition mismatch after local write',
    'if (forceKillTimer) clearTimeout(forceKillTimer)',
    'if (options.signal?.aborted) abort()',
    'terminationRequested = true'
  ]) {
    assert(executionSource.includes(marker), `local execution missing ${marker}`)
  }
  const settingsSource = readFileSync(path.join(repoRoot, 'src/main/settings.ts'), 'utf8')
  const legacyStrictMode = ['strict', 'Docker'].join('')
  assert(settingsSource.includes(`raw === '${legacyStrictMode}'`), 'settings must migrate the legacy strict mode')
  assert(settingsSource.includes("return 'disabled'"), 'legacy strict mode must migrate to a fail-closed confirmation state')
  assert(settingsSource.includes("raw === 'restrictedLocal' || raw === 'standardSystem'"), 'legacy standard mode should remain local')
  const packageJson = readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  assert(!packageJson.includes('resources/sandbox/**/*'), 'package must not ship removed container resources')
}

function nodeCommand(source) {
  const encodedSource = Buffer.from(source, 'utf8').toString('base64')
  const bootstrap = `eval(Buffer.from('${encodedSource}','base64').toString())`
  if (process.platform === 'win32') return `"${process.execPath}" -e "${bootstrap}"`
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(bootstrap)}`
}

function verifySecuritySettingsUi() {
  const text = readFileSync(path.join(repoRoot, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8')
  for (const marker of [
    'localExecutionLabel',
    'legacyDockerMigrationWarning',
    "set('sandboxMode', 'restrictedLocal')",
    'permissionRulesTitle',
    'addPermissionRule',
    'updatePermissionRule',
    'commandPattern',
    'networkHostPattern',
    'guiApplicationPattern',
    'guiWindowPattern',
    'mcpToolPattern',
    'mcpArgumentPointer',
    'mcpArgumentPattern',
    'capabilityScope',
    'permissionRuleCapabilities',
    'requirePostcondition',
    'permissionRuleMissingSelector'
  ]) {
    assert(text.includes(marker), `settings UI missing ${marker}`)
  }
  for (const legacyField of ['permissionAllowlist', 'permissionDenylist', 'permissionTemporaryAllowlist', 'allowedTools', 'disallowedTools']) {
    assert(!text.includes(`value={draft.${legacyField}}`), `settings UI must not expose raw legacy field ${legacyField}`)
  }
  assert(!text.includes(['strict', 'Docker'].join('')), 'settings UI must not expose the removed strict mode')
}

function settings(patch = {}) {
  return {
    allowedTools: '',
    disallowedTools: '',
    permissionAllowlist: '',
    permissionDenylist: '',
    permissionTemporaryAllowlist: '',
    permissionRulesVersion: 2,
    permissionRules: [],
    ...patch
  }
}

function findCompiled(fileName) {
  const stack = [outDir]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = requireFromSmoke('node:fs').readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === fileName) return full
    }
  }
  throw new Error(`compiled file not found: ${fileName}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
