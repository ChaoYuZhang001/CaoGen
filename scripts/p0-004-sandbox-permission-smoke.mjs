#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

  const sandbox = requireFromSmoke(findCompiled('docker-sandbox.js'))
  const safePath = requireFromSmoke(findCompiled('safe-project-path.js'))
  const permission = requireFromSmoke(findCompiled('tool-permission.js'))
  const audit = requireFromSmoke(findCompiled('audit-log.js'))

  await verifySandbox(sandbox)
  await verifySafeProjectPath(safePath, sandbox)
  verifyPermission(permission)
  verifyAudit(audit)
  verifyOpenAiToolsBridge()
  verifyClaudePermissionBridge()
  verifySecuritySettingsUi()
  verifyDockerSandboxImage()

  console.log('p0-004 sandbox/permission smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileModules() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/sandbox/docker-sandbox.ts',
      'src/main/sandbox/system-sandbox.ts',
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

async function verifySandbox(sandbox) {
  const standard = await sandbox.runSandboxedCommand({
    command: 'echo caogen-p0-004',
    cwd: projectDir,
    mode: 'standardSystem',
    timeoutMs: 10_000,
    maxBufferBytes: 1024 * 1024
  })
  assert(standard.ok, `standard shell should pass: ${standard.output}`)
  assert(standard.output.includes('caogen-p0-004'), 'standard shell output missing marker')
  assert(standard.sandboxed === false, 'standard shell should not be marked sandboxed')

  const blocked = await sandbox.runSandboxedCommand({
    command: 'echo docker-fallback-ok',
    cwd: projectDir,
    mode: 'strictDocker',
    timeoutMs: 10_000,
    maxBufferBytes: 1024 * 1024,
    dockerBinary: path.join(tempRoot, 'missing-docker-binary')
  })
  assert(!blocked.ok, 'strict Docker should fail closed when Docker is unavailable by default')
  assert(blocked.modeUsed === 'strictDocker', `expected strictDocker blocked mode, got ${blocked.modeUsed}`)
  assert(blocked.sandboxed === false, 'blocked strict Docker must disclose it was not sandboxed')
  assert(blocked.output.includes('strictDocker blocked'), 'blocked strict Docker output should be explicit')

  const fallback = await sandbox.runSandboxedCommand({
    command: 'echo docker-fallback-ok',
    cwd: projectDir,
    mode: 'strictDocker',
    timeoutMs: 10_000,
    maxBufferBytes: 1024 * 1024,
    dockerBinary: path.join(tempRoot, 'missing-docker-binary'),
    allowStrictDockerFallback: true
  })
  assert(fallback.ok, `strict Docker fallback should run system command: ${fallback.output}`)
  assert(fallback.modeUsed === 'standardSystem', `expected standardSystem fallback, got ${fallback.modeUsed}`)
  assert(fallback.sandboxed === false, 'fallback must disclose that it was not sandboxed')
  assert(fallback.fallbackReason?.includes('Docker 不可用'), 'fallback reason should mention Docker unavailable')
  assert(fallback.output.includes('docker-fallback-ok'), 'fallback output missing marker')

  const fileBlocked = await sandbox.writeTextFileWithSandbox({
    cwd: projectDir,
    targetPath: path.join(projectDir, 'sandbox-write-blocked.txt'),
    content: 'should-not-write\n',
    mode: 'strictDocker',
    timeoutMs: 10_000,
    dockerBinary: path.join(tempRoot, 'missing-docker-binary')
  })
  assert(!fileBlocked.ok, 'strict Docker file writes should fail closed when Docker is unavailable by default')
  assert(fileBlocked.modeUsed === 'strictDocker', `expected file blocked mode strictDocker, got ${fileBlocked.modeUsed}`)
  assert(!existsSync(path.join(projectDir, 'sandbox-write-blocked.txt')), 'blocked strict Docker write must not create file')

  const fileFallback = await sandbox.writeTextFileWithSandbox({
    cwd: projectDir,
    targetPath: path.join(projectDir, 'sandbox-write.txt'),
    content: 'sandbox-file-fallback-ok\n',
    mode: 'strictDocker',
    timeoutMs: 10_000,
    dockerBinary: path.join(tempRoot, 'missing-docker-binary'),
    allowStrictDockerFallback: true
  })
  assert(fileFallback.ok, `strict Docker file fallback should write: ${fileFallback.output}`)
  assert(fileFallback.modeUsed === 'standardSystem', `expected file fallback mode standardSystem, got ${fileFallback.modeUsed}`)
  assert(fileFallback.sandboxed === false, 'file fallback must disclose that it was not sandboxed')
  assert(fileFallback.fallbackReason?.includes('Docker 不可用'), 'file fallback reason should mention Docker unavailable')
  assert(readFileSync(path.join(projectDir, 'sandbox-write.txt'), 'utf8') === 'sandbox-file-fallback-ok\n', 'file fallback content mismatch')
}

async function verifySafeProjectPath(safePath, sandbox) {
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

  const writeAttempt = await sandbox.writeTextFileWithSandbox({
    cwd: projectDir,
    targetPath: path.join(projectDir, 'linked-outside', 'secret.txt'),
    content: 'owned\n',
    mode: 'standardSystem',
    timeoutMs: 10_000
  })
  assert(!writeAttempt.ok, `standardSystem write must reject symlink/junction escape: ${writeAttempt.output}`)
  assert(readFileSync(outsideFile, 'utf8') === 'outside-secret\n', 'outside file must remain unchanged')
}

function verifyPermission(permission) {
  const low = permission.classifyToolRisk('read_file', { path: 'src/a.ts' }, projectDir)
  assert(low.level === 'low', `read_file should be low risk, got ${low.level}`)

  const edit = permission.classifyToolRisk('write_file', { path: 'src/a.ts' }, projectDir)
  assert(edit.level === 'medium', `write_file should be medium risk, got ${edit.level}`)

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
    source: 'sandbox',
    toolName: 'bash',
    riskLevel: 'low',
    riskReasons: ['smoke'],
    input: { command: 'echo audit' },
    ok: true,
    sandboxMode: 'standardSystem',
    modeUsed: 'standardSystem',
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
  assert(text.includes("options.sandboxMode ?? 'loose'"), 'bash must default to loose')
  assert(text.includes('runSandboxedCommand'), 'bash must call sandbox command wrapper')
  assert(text.includes('writeTextFileWithSandbox'), 'file writes must call sandbox file writer')
  assert(text.includes('sandboxedFileWrite'), 'OpenAI file tools must route through sandboxedFileWrite')
  for (const marker of ["case 'bash'", "case 'read_file'", "case 'write_file'"]) {
    assert(text.includes(marker), `openaiTools missing ${marker}`)
  }
}

function verifyDockerSandboxImage() {
  const sandboxSource = readFileSync(path.join(repoRoot, 'src/main/sandbox/docker-sandbox.ts'), 'utf8')
  for (const marker of [
    "DEFAULT_DOCKER_IMAGE = 'caogen-sandbox:latest'",
    "'--cap-drop'",
    "'ALL'",
    "'--security-opt'",
    "'no-new-privileges'",
    "'--read-only'",
    "'--tmpfs'",
    "'--cpus'",
    "'--memory'",
    "'--pids-limit'",
    "'--user'",
    "'node'",
    'if (forceKillTimer) clearTimeout(forceKillTimer)',
    'if (options.signal?.aborted) abort()',
    'terminationRequested = true'
  ]) {
    assert(sandboxSource.includes(marker), `docker sandbox missing ${marker}`)
  }
  const dockerfile = readFileSync(path.join(repoRoot, 'resources/sandbox/Dockerfile'), 'utf8')
  for (const marker of ['FROM node:22-alpine', 'ripgrep', 'git', 'python3', 'go', 'rust', 'USER node']) {
    assert(dockerfile.includes(marker), `Dockerfile missing ${marker}`)
  }
  const settingsSource = readFileSync(path.join(repoRoot, 'src/main/settings.ts'), 'utf8')
  assert(settingsSource.includes("sandboxDockerImage: 'caogen-sandbox:latest'"), 'settings should default to caogen-sandbox image')
  const packageJson = readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  assert(packageJson.includes('resources/sandbox/**/*'), 'package should include sandbox resources')
}

function verifyClaudePermissionBridge() {
  const text = readFileSync(path.join(repoRoot, 'src/main/agentSession.ts'), 'utf8')
  for (const marker of [
    'evaluateToolPermission',
    'writeAuditLog',
    'CLAUDE_HOST_MUTATION_TOOLS',
    "settings.sandboxMode === 'strictDocker'",
    'fail-closed'
  ]) {
    assert(text.includes(marker), `Claude permission bridge missing ${marker}`)
  }
}

function verifySecuritySettingsUi() {
  const text = readFileSync(path.join(repoRoot, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8')
  for (const marker of [
    'draft.sandboxMode',
    'sandboxDockerImage',
    'permissionAllowlist',
    'permissionDenylist',
    'permissionTemporaryAllowlist'
  ]) {
    assert(text.includes(marker), `settings UI missing ${marker}`)
  }
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
