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

  await verifyLocalExecution(localExecution)
  await verifySafeProjectPath(safePath, localExecution)
  verifyPermission(permission)
  verifyAudit(audit)
  verifyOpenAiToolsBridge()
  verifyClaudePermissionBridge()
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
  const disabledCommand = await localExecution.runLocalCommand({
    command: 'echo must-not-run',
    cwd: projectDir,
    mode: 'disabled',
    timeoutMs: 10_000,
    maxBufferBytes: 1024 * 1024
  })
  assert(!disabledCommand.ok, 'legacy strict migration must keep local commands disabled')
  assert(disabledCommand.modeUsed === 'disabled', 'disabled local command must report the migration mode')
  assert(disabledCommand.output.includes('不会自动降级为宿主机执行'), 'disabled command must explain the safety boundary')

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
  assert(allow.kind === 'allow', `allowlist should allow low risk bash, got ${allow.kind}`)

  const pathAllow = permission.evaluateToolPermission(
    settings({ permissionAllowlist: 'tool=write_file path=src/**' }),
    { toolName: 'write_file', input: { path: 'src/a.ts' }, cwd: projectDir }
  )
  assert(pathAllow.kind === 'allow', `path allowlist should allow src write, got ${pathAllow.kind}`)

  const temporary = permission.evaluateToolPermission(
    settings({ permissionTemporaryAllowlist: `tool=bash risk<=low until=${Date.now() + 60_000}` }),
    { toolName: 'bash', input: { command: 'echo temp' }, cwd: projectDir }
  )
  assert(temporary.kind === 'allow', `temporary allow should pass, got ${temporary.kind}`)

  const expired = permission.evaluateToolPermission(
    settings({ permissionTemporaryAllowlist: `tool=bash risk<=low until=${Date.now() - 1}` }),
    { toolName: 'bash', input: { command: 'echo temp' }, cwd: projectDir }
  )
  assert(expired.kind === 'neutral', `expired temporary allow should be neutral, got ${expired.kind}`)
}

function verifyAudit(audit) {
  audit.writeAuditLog(projectDir, {
    action: 'execute',
    source: 'local-execution',
    toolName: 'bash',
    riskLevel: 'low',
    riskReasons: ['smoke'],
    input: { command: 'echo audit' },
    ok: true,
    sandboxMode: 'restrictedLocal',
    modeUsed: 'restrictedLocal',
    sandboxed: false
  })
  const text = readFileSync(path.join(projectDir, '.caogen', 'audit.log'), 'utf8')
  const line = text.trim().split(/\r?\n/).at(-1)
  assert(line, 'audit log should contain at least one line')
  const record = JSON.parse(line)
  assert(record.toolName === 'bash', 'audit record toolName mismatch')
  assert(record.action === 'execute', 'audit record action mismatch')
  assert(record.input === undefined, 'audit record must never persist raw input')
  assert(record.inputSummary.startsWith('command bytes='), 'audit record should store only command metadata')
  assert(record.inputDigest && !record.inputSummary.includes('echo audit'), 'audit command summary must use a digest')

  const sentinel = 'AUDIT_SENTINEL_SECRET_7f2d'
  audit.writeAuditLog(projectDir, {
    action: 'ask',
    source: 'permission-mode',
    toolName: 'write_file',
    input: { path: 'src/private.txt', content: sentinel, authorization: `Bearer ${sentinel}` },
    message: `token=${sentinel}`
  })
  const sanitizedText = readFileSync(path.join(projectDir, '.caogen', 'audit.log'), 'utf8')
  assert(!sanitizedText.includes(sentinel), 'audit log must not contain raw secrets or file content')
  const sanitizedRecord = JSON.parse(sanitizedText.trim().split(/\r?\n/).at(-1))
  assert(sanitizedRecord.input === undefined, 'sanitized audit record must omit input property')
  assert(sanitizedRecord.inputSummary.includes('path=src/private.txt'), 'write audit should retain safe target metadata')
}

function verifyOpenAiToolsBridge() {
  const text = readFileSync(path.join(repoRoot, 'src/main/openaiTools.ts'), 'utf8')
  assert(text.includes("options.sandboxMode ?? 'restrictedLocal'"), 'bash must default to restricted local execution')
  assert(text.includes('runLocalCommand'), 'bash must call local command wrapper')
  assert(text.includes('writeTextFileLocally'), 'file writes must call guarded local writer')
  assert(text.includes('localFileWrite'), 'OpenAI file tools must route through localFileWrite')
  for (const marker of ["case 'bash'", "case 'read_file'", "case 'write_file'"]) {
    assert(text.includes(marker), `openaiTools missing ${marker}`)
  }
  const engine = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
  assert(
    engine.includes("settings.sandboxMode === 'disabled' && !readOnlyCall"),
    'OpenAI engine must block every mutating Agent tool while legacy local execution awaits confirmation'
  )
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

function verifyClaudePermissionBridge() {
  const text = readFileSync(path.join(repoRoot, 'src/main/agentSession.ts'), 'utf8')
  for (const marker of [
    'evaluateToolPermission',
    'writeAuditLog',
    'authorizeClaudeTool',
    "settings.sandboxMode === 'disabled' && !CLAUDE_READ_TOOLS.has(toolName)",
    "settings.sandboxMode !== 'disabled'"
  ]) {
    assert(text.includes(marker), `Claude permission bridge missing ${marker}`)
  }
}

function verifySecuritySettingsUi() {
  const text = readFileSync(path.join(repoRoot, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8')
  for (const marker of [
    'localExecutionLabel',
    'legacyDockerMigrationWarning',
    "set('sandboxMode', 'restrictedLocal')",
    'permissionAllowlist',
    'permissionDenylist',
    'permissionTemporaryAllowlist'
  ]) {
    assert(text.includes(marker), `settings UI missing ${marker}`)
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
