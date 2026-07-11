import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { resolveWritableProjectPath } from '../utils/safe-project-path'

export type SandboxMode = 'strictDocker' | 'standardSystem' | 'loose'

export interface SandboxCommandOptions {
  command: string
  cwd: string
  mode: SandboxMode
  timeoutMs: number
  maxBufferBytes: number
  dockerImage?: string
  dockerBinary?: string
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
  dockerRegistryMirror?: string
  allowStrictDockerFallback?: boolean
  signal?: AbortSignal
}

export interface SandboxCommandResult {
  ok: boolean
  output: string
  exitCode: number
  modeUsed: SandboxMode
  sandboxed: boolean
  fallbackReason?: string
}

export interface SandboxFileWriteOptions {
  cwd: string
  targetPath: string
  content: string
  mode: SandboxMode
  timeoutMs: number
  dockerImage?: string
  dockerBinary?: string
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
  dockerRegistryMirror?: string
  allowStrictDockerFallback?: boolean
  signal?: AbortSignal
  expectedFile?: SandboxFileWritePrecondition
  beforeGuardedCommit?: () => Promise<void> | void
  beforeGuardedPathVerificationRead?: (
    phase: 'precondition' | 'postcondition',
    targetPath: string
  ) => Promise<void> | void
}

export type SandboxFileWritePrecondition =
  | {
      state?: 'file'
      identity: { device: string; inode: string }
      sha256: string
      bytes: number
    }
  | {
      state: 'absent'
      rootPath: string
      rootIdentity: { device: string; inode: string }
    }

interface GuardedParentPath {
  rootPath: string
  rootIdentity: { device: string; inode: string }
  parentPath: string
  parentIdentity: { device: string; inode: string }
  targetPath: string
}

interface ExecFileResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
  errorMessage?: string
}

export const DEFAULT_DOCKER_IMAGE = 'caogen-sandbox:latest'
const DEFAULT_DOCKER_CPUS = '2'
const DEFAULT_DOCKER_MEMORY = '2g'
const DEFAULT_DOCKER_PIDS = '256'
const DOCKER_WORKSPACE = '/workspace'
const SANDBOX_WRITE_SCRIPT = `
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const payload = JSON.parse(fs.readFileSync('/caogen/payload.json', 'utf8'));
const root = path.resolve('${DOCKER_WORKSPACE}');
const finalTarget = path.resolve(root, payload.targetRelPath);
if (finalTarget !== root && !finalTarget.startsWith(root + path.sep)) {
  throw new Error('target path escapes workspace');
}
const target = payload.guardedTarget ? '/caogen/target' : finalTarget;
fs.mkdirSync(path.dirname(finalTarget), { recursive: true });
if (!payload.expectedFile) {
  fs.writeFileSync(target, payload.content, 'utf8');
} else {
  const targetInfo = fs.lstatSync(target);
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
    throw new Error('guarded target is not a regular file');
  }
  const noFollow = process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
    ? fs.constants.O_NOFOLLOW
    : 0;
  const nonBlock = process.platform !== 'win32' && typeof fs.constants.O_NONBLOCK === 'number'
    ? fs.constants.O_NONBLOCK
    : 0;
  const fd = fs.openSync(target, fs.constants.O_RDWR | noFollow | nonBlock);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (payload.expectedFile.state !== 'absent') {
      const current = fs.readFileSync(fd);
      const digest = crypto.createHash('sha256').update(current).digest('hex');
      if (current.byteLength !== payload.expectedFile.bytes || digest !== payload.expectedFile.sha256) {
        throw new Error('guarded target content changed before write');
      }
    }
    const output = Buffer.from(payload.content, 'utf8');
    fs.ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < output.length) {
      const written = fs.writeSync(fd, output, offset, output.length - offset, offset);
      if (written <= 0) throw new Error('guarded file write made no progress');
      offset += written;
    }
    fs.ftruncateSync(fd, output.length);
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('guarded target identity changed during write');
    }
  } finally {
    fs.closeSync(fd);
  }
  if (payload.expectedFile.state === 'absent') {
    const guardPath = path.resolve(root, payload.guardRelPath);
    if (guardPath !== root && !guardPath.startsWith(root + path.sep)) {
      throw new Error('guard path escapes workspace');
    }
    fs.linkSync(guardPath, finalTarget);
  }
}
`

export async function runSandboxedCommand(options: SandboxCommandOptions): Promise<SandboxCommandResult> {
  if (options.signal?.aborted) return abortedResult(options.mode)
  const command = options.command.trim()
  if (!command) {
    return {
      ok: false,
      output: '命令不能为空',
      exitCode: 1,
      modeUsed: options.mode,
      sandboxed: options.mode === 'strictDocker'
    }
  }

  if (options.mode === 'strictDocker') {
    const dockerBinary = options.dockerBinary ?? 'docker'
    const dockerAvailable = await isDockerAvailable(dockerBinary, options.signal)
    if (dockerAvailable) {
      const image = resolveDockerImage(options.dockerImage?.trim() || DEFAULT_DOCKER_IMAGE, options)
      const imageAvailable = await isDockerImageAvailable(dockerBinary, image, options.signal)
      if (!imageAvailable) return handleStrictDockerUnavailable(options, command, `Docker image unavailable:${image}`)
      return runDockerCommand({ ...options, command, dockerBinary })
    }

    const fallbackReason = `Docker 不可用,已降级为 standardSystem:${dockerBinary}`
    return handleStrictDockerUnavailable(options, command, fallbackReason)
  }

  return runSystemCommand({ ...options, command })
}

export async function writeTextFileWithSandbox(options: SandboxFileWriteOptions): Promise<SandboxCommandResult> {
  if (options.signal?.aborted) return abortedResult(options.mode)
  const safePath = await resolveWritableProjectPath(options.cwd, options.targetPath).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error)
  }))
  if ('error' in safePath) {
    return {
      ok: false,
      output: `target path escapes workspace:${options.targetPath}; ${safePath.error}`,
      exitCode: 1,
      modeUsed: options.mode,
      sandboxed: false
    }
  }
  const cwd = safePath.root
  const targetPath = safePath.fullPath
  const relPath = safePath.relativePath
  const safeOptions = { ...options, cwd, targetPath }

  if (options.mode !== 'strictDocker') {
    return writeTextFileOnHost(safeOptions, options.mode)
  }

  const dockerBinary = options.dockerBinary ?? 'docker'
  const dockerAvailable = await isDockerAvailable(dockerBinary, options.signal)
  if (!dockerAvailable) {
    return writeTextFileWithFallback(safeOptions, `Docker 不可用,已降级为 standardSystem:${dockerBinary}`)
  }

  const image = resolveDockerImage(options.dockerImage?.trim() || DEFAULT_DOCKER_IMAGE, options)
  const imageAvailable = await isDockerImageAvailable(dockerBinary, image, options.signal)
  if (!imageAvailable) {
    return writeTextFileWithFallback(safeOptions, `Docker image unavailable:${image}`)
  }

  const payloadDir = await mkdtemp(join(tmpdir(), 'caogen-sandbox-write-'))
  const payloadPath = join(payloadDir, `${randomUUID()}.json`)
  const guardPath = options.expectedFile
    ? join(dirname(targetPath), `.${randomUUID()}.caogen-sandbox.guard`)
    : undefined
  const guardRelPath = guardPath ? relative(cwd, guardPath) : undefined
  let guardIdentity: { device: string; inode: string } | undefined
  let guardedParent: GuardedParentPath | undefined
  try {
    if (guardPath && options.expectedFile) {
      guardedParent = await captureGuardedParentPath(
        cwd,
        targetPath,
        isAbsentFilePrecondition(options.expectedFile)
          ? { rootPath: options.expectedFile.rootPath, rootIdentity: options.expectedFile.rootIdentity }
          : undefined
      )
      await verifyGuardedParentPath(guardedParent)
      if (isAbsentFilePrecondition(options.expectedFile)) {
        await verifyAbsentFilePrecondition(targetPath)
        await writeFile(guardPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o666, signal: options.signal })
      } else {
        await link(targetPath, guardPath)
        await verifyFileWritePrecondition(guardPath, options.expectedFile)
      }
      guardIdentity = await readFileIdentity(guardPath)
      await options.beforeGuardedCommit?.()
      await verifyGuardedParentPath(guardedParent)
      if (isAbsentFilePrecondition(options.expectedFile)) {
        await verifyAbsentFilePrecondition(targetPath)
      } else {
        await verifyFileWritePrecondition(
          targetPath,
          options.expectedFile,
          () => options.beforeGuardedPathVerificationRead?.('precondition', targetPath)
        )
      }
    }
    await writeFile(
      payloadPath,
      JSON.stringify({
        targetRelPath: relPath.split(sep).join('/'),
        content: options.content,
        expectedFile: options.expectedFile,
        guardedTarget: !!guardPath,
        guardRelPath: guardRelPath?.split(sep).join('/')
      }),
      { encoding: 'utf8', mode: 0o644, signal: options.signal }
    )
    const mirrorEnv = buildChinaMirrorEnv(options)
    const result = await execFilePromise(
      dockerBinary,
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=512m',
        '--cpus',
        DEFAULT_DOCKER_CPUS,
        '--memory',
        DEFAULT_DOCKER_MEMORY,
        '--pids-limit',
        DEFAULT_DOCKER_PIDS,
        '--user',
        'node',
        ...dockerEnvArgs(mirrorEnv),
        '-v',
        `${payloadPath}:/caogen/payload.json:ro`,
        ...(guardPath ? ['-v', `${guardPath}:/caogen/target`] : []),
        '-v',
        `${cwd}:${DOCKER_WORKSPACE}`,
        '-w',
        DOCKER_WORKSPACE,
        image,
        'node',
        '-e',
        SANDBOX_WRITE_SCRIPT
      ],
      {
        cwd,
        timeoutMs: options.timeoutMs,
        maxBufferBytes: 512 * 1024,
        env: mergeProcessEnv(mirrorEnv),
        signal: options.signal
      }
    )
    if (result.ok && options.expectedFile && guardIdentity) {
      try {
        if (guardedParent) await verifyGuardedParentPath(guardedParent)
        await verifyFileWritePostcondition(
          targetPath,
          guardIdentity,
          options.content,
          () => options.beforeGuardedPathVerificationRead?.('postcondition', targetPath)
        )
      } catch (error) {
        return {
          ok: false,
          output: error instanceof Error ? error.message : String(error),
          exitCode: 1,
          modeUsed: 'strictDocker',
          sandboxed: true
        }
      }
    }
    const formatted = formatResult(result, 'strictDocker', true)
    return {
      ...formatted,
      output: result.ok ? `已通过 Docker 沙箱写入 ${relPath}` : formatted.output
    }
  } finally {
    if (guardPath) await rm(guardPath, { force: true }).catch(() => undefined)
    await rm(payloadDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function isDockerAvailable(dockerBinary: string, signal?: AbortSignal): Promise<boolean> {
  const result = await execFilePromise(dockerBinary, ['version', '--format', '{{.Server.Version}}'], {
    cwd: process.cwd(),
    timeoutMs: 3_000,
    maxBufferBytes: 256 * 1024,
    signal
  })
  return result.ok
}

async function isDockerImageAvailable(dockerBinary: string, image: string, signal?: AbortSignal): Promise<boolean> {
  const result = await execFilePromise(dockerBinary, ['image', 'inspect', image], {
    cwd: process.cwd(),
    timeoutMs: 3_000,
    maxBufferBytes: 256 * 1024,
    signal
  })
  return result.ok
}

async function handleStrictDockerUnavailable(
  options: SandboxCommandOptions,
  command: string,
  fallbackReason: string
): Promise<SandboxCommandResult> {
  if (options.allowStrictDockerFallback !== true) {
    return {
      ok: false,
      output: `[sandbox strictDocker blocked] ${fallbackReason}\n严格 Docker 沙箱未运行;为避免误以为处于隔离环境,默认不自动降级。`,
      exitCode: 1,
      modeUsed: 'strictDocker',
      sandboxed: false,
      fallbackReason
    }
  }
  const fallback = await runSystemCommand({ ...options, command, mode: 'standardSystem' })
  return {
    ...fallback,
    output: `[sandbox fallback] ${fallbackReason}\n${fallback.output}`,
    fallbackReason
  }
}

async function runDockerCommand(
  options: SandboxCommandOptions & { command: string; dockerBinary: string }
): Promise<SandboxCommandResult> {
  const image = resolveDockerImage(options.dockerImage?.trim() || DEFAULT_DOCKER_IMAGE, options)
  const mirrorEnv = buildChinaMirrorEnv(options)
  const result = await execFilePromise(
    options.dockerBinary,
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=512m',
      '--cpus',
      DEFAULT_DOCKER_CPUS,
      '--memory',
      DEFAULT_DOCKER_MEMORY,
      '--pids-limit',
      DEFAULT_DOCKER_PIDS,
      '--user',
      'node',
      ...dockerEnvArgs(mirrorEnv),
      '-v',
      `${options.cwd}:/workspace`,
      '-w',
      '/workspace',
      image,
      '/bin/sh',
      '-lc',
      options.command
    ],
    {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxBufferBytes: options.maxBufferBytes,
      env: mergeProcessEnv(mirrorEnv),
      signal: options.signal
    }
  )
  return formatResult(result, 'strictDocker', true)
}

async function writeTextFileWithFallback(
  options: SandboxFileWriteOptions,
  fallbackReason: string
): Promise<SandboxCommandResult> {
  if (options.allowStrictDockerFallback !== true) {
    return {
      ok: false,
      output: `[sandbox strictDocker blocked] ${fallbackReason}\n严格 Docker 沙箱未运行;为避免误以为处于隔离环境,默认不自动降级。`,
      exitCode: 1,
      modeUsed: 'strictDocker',
      sandboxed: false,
      fallbackReason
    }
  }
  const fallback = await writeTextFileOnHost(options, 'standardSystem')
  return {
    ...fallback,
    output: `[sandbox fallback] ${fallbackReason}\n${fallback.output}`,
    fallbackReason
  }
}

async function writeTextFileOnHost(
  options: SandboxFileWriteOptions,
  modeUsed: SandboxMode
): Promise<SandboxCommandResult> {
  try {
    if (options.signal?.aborted) return abortedResult(modeUsed)
    if (options.expectedFile) {
      await writeGuardedTextFileOnHost(options)
    } else {
      await mkdir(dirname(options.targetPath), { recursive: true })
      await writeFile(options.targetPath, options.content, { encoding: 'utf8', signal: options.signal })
    }
    return {
      ok: true,
      output: `已写入 ${relative(resolve(options.cwd), resolve(options.targetPath))}`,
      exitCode: 0,
      modeUsed,
      sandboxed: false
    }
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      modeUsed,
      sandboxed: false
    }
  }
}

async function verifyFileWritePrecondition(
  targetPath: string,
  expected: Exclude<SandboxFileWritePrecondition, { state: 'absent' }>,
  beforeRead?: () => Promise<void> | void
): Promise<void> {
  const observation = await readStablePathFile(
    targetPath,
    expected.identity,
    'before write',
    beforeRead
  )
  if (
    observation.content.byteLength !== expected.bytes ||
    createHash('sha256').update(observation.content).digest('hex') !== expected.sha256
  ) {
    throw new Error('guarded target content changed before write')
  }
}

async function verifyFileWritePostcondition(
  targetPath: string,
  expectedIdentity: { device: string; inode: string },
  content: string,
  beforeRead?: () => Promise<void> | void
): Promise<void> {
  const observation = await readStablePathFile(
    targetPath,
    expectedIdentity,
    'after write',
    beforeRead
  )
  const output = Buffer.from(content, 'utf8')
  if (observation.content.byteLength !== output.byteLength || !observation.content.equals(output)) {
    throw new Error('guarded target postcondition mismatch after Docker write')
  }
}

async function readStablePathFile(
  targetPath: string,
  expectedIdentity: { device: string; inode: string },
  phase: string,
  beforeRead?: () => Promise<void> | void
): Promise<{ content: Buffer }> {
  const handle = await open(targetPath, safeOpenFlags(constants.O_RDONLY))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`guarded target is not a regular file ${phase}`)
    if (
      before.dev.toString() !== expectedIdentity.device ||
      before.ino.toString() !== expectedIdentity.inode
    ) {
      throw new Error(`guarded target identity changed ${phase}`)
    }
    await beforeRead?.()
    const content = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const currentPath = await lstat(targetPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (
      !currentPath ||
      currentPath.isSymbolicLink() ||
      !currentPath.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== currentPath.dev ||
      before.ino !== currentPath.ino ||
      after.size !== currentPath.size ||
      after.mtimeNs !== currentPath.mtimeNs ||
      after.ctimeNs !== currentPath.ctimeNs ||
      BigInt(content.byteLength) !== before.size
    ) {
      throw new Error(`guarded target path or content changed ${phase}`)
    }
    return { content }
  } finally {
    await handle.close()
  }
}

async function writeGuardedTextFileOnHost(options: SandboxFileWriteOptions): Promise<void> {
  const expected = options.expectedFile
  if (!expected) throw new Error('guarded file write is missing its precondition')
  if (isAbsentFilePrecondition(expected)) {
    await writeAbsentTextFileOnHost(options)
    return
  }
  const guardedParent = await captureGuardedParentPath(options.cwd, options.targetPath)
  const handle = await open(options.targetPath, safeOpenFlags(constants.O_RDWR))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('guarded target is not a regular file')
    if (
      before.dev.toString() !== expected.identity.device ||
      before.ino.toString() !== expected.identity.inode
    ) {
      throw new Error('guarded target identity changed before write')
    }
    const current = await handle.readFile()
    if (
      current.byteLength !== expected.bytes ||
      createHash('sha256').update(current).digest('hex') !== expected.sha256
    ) {
      throw new Error('guarded target content changed before write')
    }
    if (options.signal?.aborted) throw new Error('操作已中断')
    await options.beforeGuardedCommit?.()
    await verifyGuardedParentPath(guardedParent)
    await verifyFileWritePrecondition(
      options.targetPath,
      expected,
      () => options.beforeGuardedPathVerificationRead?.('precondition', options.targetPath)
    )
    const output = Buffer.from(options.content, 'utf8')
    await handle.truncate(0)
    let offset = 0
    while (offset < output.length) {
      const written = await handle.write(output, offset, output.length - offset, offset)
      if (written.bytesWritten <= 0) throw new Error('guarded file write made no progress')
      offset += written.bytesWritten
    }
    await handle.truncate(output.length)
    await handle.sync()
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('guarded target identity changed during write')
    }
    await verifyGuardedParentPath(guardedParent)
    await verifyFileWritePostcondition(
      options.targetPath,
      fileIdentity(before),
      options.content,
      () => options.beforeGuardedPathVerificationRead?.('postcondition', options.targetPath)
    )
  } finally {
    await handle.close()
  }
}

async function writeAbsentTextFileOnHost(options: SandboxFileWriteOptions): Promise<void> {
  const expected = options.expectedFile
  if (!expected || !isAbsentFilePrecondition(expected)) {
    throw new Error('guarded absent write is missing its approved root identity')
  }
  const guardedParent = await captureGuardedParentPath(options.cwd, options.targetPath, {
    rootPath: expected.rootPath,
    rootIdentity: expected.rootIdentity
  })
  await verifyAbsentFilePrecondition(options.targetPath)
  const tempPath = join(dirname(options.targetPath), `.${randomUUID()}.caogen-write.tmp`)
  const noFollow = process.platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number'
    ? constants.O_NOFOLLOW
    : 0
  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o666
  )
  try {
    const output = Buffer.from(options.content, 'utf8')
    let offset = 0
    while (offset < output.length) {
      if (options.signal?.aborted) throw new Error('操作已中断')
      const written = await handle.write(output, offset, output.length - offset, offset)
      if (written.bytesWritten <= 0) throw new Error('guarded file write made no progress')
      offset += written.bytesWritten
    }
    await handle.sync()
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) throw new Error('guarded temporary target is not a regular file')
    if (options.signal?.aborted) throw new Error('操作已中断')
    await options.beforeGuardedCommit?.()
    await verifyGuardedParentPath(guardedParent)
    await verifyAbsentFilePrecondition(options.targetPath)
    try {
      await link(tempPath, options.targetPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('guarded target appeared before write')
      }
      throw error
    }
    await verifyGuardedParentPath(guardedParent)
    await verifyFileWritePostcondition(
      options.targetPath,
      fileIdentity(info),
      options.content,
      () => options.beforeGuardedPathVerificationRead?.('postcondition', options.targetPath)
    )
  } finally {
    await handle.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

async function readFileIdentity(targetPath: string): Promise<{ device: string; inode: string }> {
  const handle = await open(targetPath, safeOpenFlags(constants.O_RDONLY))
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) throw new Error('guarded target is not a regular file')
    return fileIdentity(info)
  } finally {
    await handle.close()
  }
}

async function verifyAbsentFilePrecondition(targetPath: string): Promise<void> {
  const existing = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new Error('guarded target appeared before write')
}

async function captureGuardedParentPath(
  cwd: string,
  targetPath: string,
  approvedRoot?: { rootPath: string; rootIdentity: { device: string; inode: string } }
): Promise<GuardedParentPath> {
  const initial = await resolveWritableProjectPath(cwd, targetPath)
  if (approvedRoot) await verifyApprovedRoot(initial.root, approvedRoot)
  await mkdir(dirname(targetPath), { recursive: true })
  const resolved = await resolveWritableProjectPath(cwd, targetPath)
  if (approvedRoot) await verifyApprovedRoot(resolved.root, approvedRoot)
  const parentPath = dirname(resolved.fullPath)
  const [rootInfo, parentInfo] = await Promise.all([
    lstat(resolved.root, { bigint: true }),
    lstat(parentPath, { bigint: true })
  ])
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('guarded project root is not a stable directory')
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error('guarded target parent is not a stable directory')
  }
  return {
    rootPath: resolved.root,
    rootIdentity: fileIdentity(rootInfo),
    parentPath,
    parentIdentity: fileIdentity(parentInfo),
    targetPath: resolved.fullPath
  }
}

async function verifyApprovedRoot(
  observedRootPath: string,
  expected: { rootPath: string; rootIdentity: { device: string; inode: string } }
): Promise<void> {
  if (observedRootPath !== expected.rootPath) {
    throw new Error('guarded project root path differs from the approved Effect')
  }
  const info = await lstat(observedRootPath, { bigint: true })
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    !sameFileIdentity(fileIdentity(info), expected.rootIdentity)
  ) {
    throw new Error('guarded project root identity differs from the approved Effect')
  }
}

async function verifyGuardedParentPath(expected: GuardedParentPath): Promise<void> {
  const resolved = await resolveWritableProjectPath(expected.rootPath, expected.targetPath)
  if (
    resolved.root !== expected.rootPath ||
    resolved.fullPath !== expected.targetPath ||
    dirname(resolved.fullPath) !== expected.parentPath
  ) {
    throw new Error('guarded target parent path changed before commit')
  }
  const [rootInfo, parentInfo] = await Promise.all([
    lstat(resolved.root, { bigint: true }),
    lstat(expected.parentPath, { bigint: true })
  ])
  if (
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    !parentInfo.isDirectory() ||
    !sameFileIdentity(fileIdentity(rootInfo), expected.rootIdentity) ||
    !sameFileIdentity(fileIdentity(parentInfo), expected.parentIdentity)
  ) {
    throw new Error('guarded target parent identity changed before commit')
  }
}

function fileIdentity(info: { dev: number | bigint; ino: number | bigint }): { device: string; inode: string } {
  return { device: String(info.dev), inode: String(info.ino) }
}

function sameFileIdentity(
  left: { device: string; inode: string },
  right: { device: string; inode: string }
): boolean {
  return left.device === right.device && left.inode === right.inode
}

function safeOpenFlags(baseFlags: number): number {
  let flags = baseFlags
  if (process.platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW
  if (process.platform !== 'win32' && typeof constants.O_NONBLOCK === 'number') flags |= constants.O_NONBLOCK
  return flags
}

function isAbsentFilePrecondition(
  expected: SandboxFileWritePrecondition
): expected is Extract<SandboxFileWritePrecondition, { state: 'absent' }> {
  return expected.state === 'absent'
}

async function runSystemCommand(
  options: SandboxCommandOptions & { command: string }
): Promise<SandboxCommandResult> {
  const shell = process.platform === 'win32' ? 'cmd' : '/bin/sh'
  const args = process.platform === 'win32' ? ['/c', options.command] : ['-c', options.command]
  const result = await execFilePromise(shell, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxBufferBytes: options.maxBufferBytes,
    env: mergeProcessEnv(buildChinaMirrorEnv(options)),
    signal: options.signal
  })
  return formatResult(result, options.mode, false)
}

function formatResult(result: ExecFileResult, modeUsed: SandboxMode, sandboxed: boolean): SandboxCommandResult {
  const output = [
    result.stdout,
    result.stderr ? `[stderr]\n${result.stderr}` : '',
    result.errorMessage && result.exitCode !== 0 ? `[exit ${result.exitCode}] ${result.errorMessage}` : ''
  ]
    .filter(Boolean)
    .join('\n')
    .trim()
  return {
    ok: result.ok,
    output: output || '(无输出)',
    exitCode: result.exitCode,
    modeUsed,
    sandboxed
  }
}

export function buildChinaMirrorEnv(options: {
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
}): Record<string, string> {
  if (options.chinaMirrorEnabled !== true) return {}
  const env: Record<string, string> = {}
  const npmRegistry = options.npmRegistry?.trim()
  const pipIndexUrl = options.pipIndexUrl?.trim()
  if (npmRegistry) env.NPM_CONFIG_REGISTRY = npmRegistry
  if (pipIndexUrl) env.PIP_INDEX_URL = pipIndexUrl
  return env
}

function dockerEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`])
}

function mergeProcessEnv(env: Record<string, string>): NodeJS.ProcessEnv | undefined {
  return Object.keys(env).length > 0 ? { ...process.env, ...env } : undefined
}

export function resolveDockerImage(
  image: string,
  options: { chinaMirrorEnabled?: boolean; dockerRegistryMirror?: string }
): string {
  const mirror = options.dockerRegistryMirror?.trim().replace(/\/+$/, '')
  if (options.chinaMirrorEnabled !== true || !mirror || hasRegistryHost(image)) return image
  return `${mirror}/${image}`
}

function hasRegistryHost(image: string): boolean {
  const parts = image.split('/')
  if (parts.length < 2) return false
  const first = parts[0] ?? ''
  return first.includes('.') || first.includes(':') || first === 'localhost'
}

function execFilePromise(
  file: string,
  args: string[],
  options: {
    cwd: string
    timeoutMs: number
    maxBufferBytes: number
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
  }
): Promise<ExecFileResult> {
  return new Promise((resolvePromise) => {
    if (options.signal?.aborted) {
      resolvePromise({ ok: false, stdout: '', stderr: '', exitCode: 1, errorMessage: '操作已中断' })
      return
    }
    let aborted = options.signal?.aborted === true
    let timedOut = false
    let overflowed = false
    let settled = false
    let outputBytes = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let child: ChildProcess | undefined
    let forceKillTimer: NodeJS.Timeout | undefined
    let terminationRequested = false
    const finish = (result: ExecFileResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      options.signal?.removeEventListener('abort', abort)
      resolvePromise(result)
    }
    const terminate = (): void => {
      if (!child || terminationRequested) return
      terminationRequested = true
      forceKillTimer = terminateProcessTree(child)
    }
    const abort = (): void => {
      aborted = true
      terminate()
    }
    const collect = (chunks: Buffer[], value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const remaining = Math.max(0, options.maxBufferBytes - outputBytes)
      if (remaining > 0) {
        const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
        chunks.push(kept)
        outputBytes += kept.byteLength
      }
      if (chunk.byteLength > remaining && !overflowed) {
        overflowed = true
        terminate()
      }
    }
    child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', (error) => {
      finish({
        ok: false,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: 1,
        errorMessage: error.message
      })
    })
    child.once('close', (code) => {
      const errorMessage = aborted
        ? '操作已中断'
        : timedOut
          ? `操作超时(${options.timeoutMs}ms)`
          : overflowed
            ? `输出超过限制(${options.maxBufferBytes} bytes)`
            : code === 0
              ? undefined
              : `进程退出码 ${code ?? 1}`
      finish({
        ok: code === 0 && !aborted && !timedOut && !overflowed,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: typeof code === 'number' ? code : 1,
        errorMessage
      })
    })
    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeoutMs)
    timeout.unref()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })
}

function abortedResult(modeUsed: SandboxMode): SandboxCommandResult {
  return {
    ok: false,
    output: '操作已中断',
    exitCode: 1,
    modeUsed,
    sandboxed: false
  }
}

function terminateProcessTree(child: ChildProcess): NodeJS.Timeout | undefined {
  const pid = child.pid
  if (!pid) return undefined
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => undefined)
    return undefined
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const forceKill = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, 500)
  forceKill.unref()
  return forceKill
}

function exitCodeFromError(err: Error | null): number {
  if (!err) return 0
  const withCode = err as NodeJS.ErrnoException & { code?: unknown }
  return typeof withCode.code === 'number' ? withCode.code : 1
}
