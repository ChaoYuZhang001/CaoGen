import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { EffectRecord, EffectTarget } from '../../shared/types'
import {
  isolatedRemoteGitEnv,
  withSafeLocalGitConfig,
  withSafeRemoteGitConfig
} from '../git/safe-git'
import { resolveWritableProjectPathSync } from '../utils/safe-project-path'
import { normalizeToolName, stableValueDigest } from './tool-idempotency'

const GIT_LOCAL_TIMEOUT_MS = 15_000
const GIT_SCAN_TIMEOUT_MS = 30_000
const GIT_REMOTE_TIMEOUT_MS = 30_000
const MAX_GIT_OUTPUT = 8 * 1024 * 1024
const GIT_CANDIDATE_CONCURRENCY = 4
const MAX_GIT_COMMIT_CANDIDATES = 64
const GIT_COMMIT_RECONCILIATION_BUDGET_MS = 30_000
const MAX_FILE_RECONCILIATION_BYTES = 64 * 1024 * 1024
export const EFFECT_RECONCILER_VERSION = 'effect-reconciler-v1'

interface GitRunResult {
  ok: boolean
  status: number | null
  stdout: string
  error: string
}

export interface EffectDescriptor {
  target: EffectTarget
  targetDigest: string
  intentDigest: string
  inputDigest: string
  reconcilability: EffectRecord['reconcilability']
}

export interface EffectReconciliationResult {
  kind: 'confirmed' | 'not_applied' | 'unresolved'
  evidenceDigest: string
  verifier: string
  reason: string
}

export async function buildEffectDescriptor(input: {
  toolName: string
  toolInput: Record<string, unknown>
  cwd: string
}): Promise<EffectDescriptor> {
  const toolName = normalizeToolName(input.toolName)
  const inputDigest = stableValueDigest(input.toolInput)
  let target: EffectTarget

  if (toolName === 'write_file') {
    target = await fileWriteTarget(input.cwd, input.toolInput)
  } else if (toolName === 'git_commit') {
    target = await gitCommitTarget(input.cwd, input.toolInput)
  } else if (toolName === 'git_push') {
    target = await gitPushTarget(input.cwd, input.toolInput)
  } else {
    target = { kind: 'unsupported', toolName }
  }

  const targetDigest = stableValueDigest(target)
  return {
    target,
    targetDigest,
    inputDigest,
    intentDigest: stableValueDigest({ toolName, targetDigest, inputDigest }),
    reconcilability: target.kind === 'unsupported' ? 'opaque' : 'queryable'
  }
}

export async function reconcileEffect(effect: EffectRecord): Promise<EffectReconciliationResult> {
  try {
    const observedTargetDigest = stableValueDigest(effect.target)
    const observedIntentDigest = stableValueDigest({
      toolName: effect.toolName,
      targetDigest: effect.targetDigest,
      inputDigest: effect.inputDigest
    })
    if (observedTargetDigest !== effect.targetDigest || observedIntentDigest !== effect.intentDigest) {
      return unresolved({ kind: 'integrity_error', reason: 'EffectRecord 摘要校验失败，禁止读取或重放目标' })
    }
    if (effect.target.kind === 'file_content') return await reconcileFileContent(effect.target)
    if (effect.target.kind === 'git_commit') return await reconcileGitCommit(effect.target)
    if (effect.target.kind === 'git_push') return await reconcileGitPush(effect.target)
    return unresolved({
      kind: 'unsupported',
      toolName: effect.target.toolName,
      reason: '该副作用没有注册只读查询器，禁止自动重放'
    })
  } catch (error) {
    return unresolved({
      kind: effect.target.kind,
      reason: error instanceof Error ? error.message : String(error)
    })
  }
}

async function fileWriteTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget> {
  const rawPath = stringValue(toolInput.path ?? toolInput.file_path)
  const content = String(toolInput.content ?? '')
  const resolved = resolveWritableProjectPathSync(cwd, rawPath)
  let preState: 'absent' | 'file' = 'absent'
  let preSha256: string | undefined
  let preBytes: number | undefined
  if (existsSync(resolved.fullPath)) {
    const info = lstatSync(resolved.fullPath)
    if (!info.isFile()) throw new Error('write_file 目标已存在但不是普通文件')
    preState = 'file'
    preBytes = info.size
    if (info.size <= MAX_FILE_RECONCILIATION_BYTES) {
      preSha256 = await sha256File(resolved.fullPath)
    }
  }
  const expected = Buffer.from(content, 'utf8')
  return {
    kind: 'file_content',
    rootPath: resolved.root,
    relativePath: resolved.relativePath,
    preState,
    preSha256,
    preBytes,
    expectedSha256: sha256(expected),
    expectedBytes: expected.byteLength
  }
}

async function gitCommitTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget> {
  const repoRoot = await resolveRepoRoot(cwd)
  const branch = await gitText(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const preHead = await gitText(repoRoot, ['rev-parse', 'HEAD'])
  const stagedDiff = await gitTextAllowEmpty(repoRoot, [
    'diff',
    '--cached',
    '--binary',
    '--full-index',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames'
  ])
  if (!stagedDiff) {
    throw new Error('没有已暂存的改动；git_commit 已在建立效果 lease 前停止')
  }
  const stagedDiffDigest = stableValueDigest(stagedDiff)
  const message = stringValue(toolInput.message)
  return {
    kind: 'git_commit',
    repoRoot,
    branch,
    preHead,
    stagedDiffDigest,
    messageDigest: stableValueDigest(message.trim())
  }
}

async function gitPushTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget> {
  const repoRoot = await resolveRepoRoot(cwd)
  const requestedBranch = optionalString(toolInput.branch)
  const branch = requestedBranch ?? await gitText(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const remoteText = await gitText(repoRoot, ['remote'])
  const remotes = remoteText
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (!remote) throw new Error('未配置 Git remote，无法建立 push 效果记录')
  const pushUrls = await gitLines(repoRoot, ['remote', 'get-url', '--push', '--all', remote])
  if (pushUrls.length !== 1) throw new Error('Git push 自动对账只支持唯一 push URL')
  const pushUrl = pushUrls[0]
  const intendedSha = await gitText(repoRoot, ['rev-parse', branch])
  const ref = `refs/heads/${branch}`
  return {
    kind: 'git_push',
    repoRoot,
    remote,
    pushUrlDigest: stableValueDigest(sanitizeRemoteUrl(pushUrl)),
    branch,
    ref,
    intendedSha
  }
}

async function reconcileFileContent(
  target: Extract<EffectTarget, { kind: 'file_content' }>
): Promise<EffectReconciliationResult> {
  const resolved = resolveWritableProjectPathSync(target.rootPath, target.relativePath)
  if (realpathSync(resolved.root) !== realpathSync(target.rootPath)) {
    return unresolved({ kind: target.kind, reason: '项目根目录身份已变化' })
  }
  if (!existsSync(resolved.fullPath)) {
    const payload = { kind: target.kind, observedState: 'absent', relativePath: target.relativePath }
    return target.preState === 'absent'
      ? notApplied(payload, '目标仍不存在，已证明写入没有发生')
      : unresolved({ ...payload, reason: '目标文件在对账时缺失' })
  }
  const info = lstatSync(resolved.fullPath)
  if (!info.isFile()) {
    return unresolved({ kind: target.kind, observedState: 'non_file', relativePath: target.relativePath })
  }
  const observedBytes = info.size
  const payload = {
    kind: target.kind,
    relativePath: target.relativePath,
    observedState: 'file',
    observedBytes
  }
  const couldBeExpected = observedBytes === target.expectedBytes
  const couldBePreState =
    target.preState === 'file' &&
    target.preBytes === observedBytes &&
    typeof target.preSha256 === 'string'
  if (!couldBeExpected && !couldBePreState) {
    return unresolved({ ...payload, reason: '文件大小既不匹配执行前状态，也不匹配预期状态' })
  }
  if (observedBytes > MAX_FILE_RECONCILIATION_BYTES) {
    return unresolved({
      ...payload,
      maxHashBytes: MAX_FILE_RECONCILIATION_BYTES,
      reason: '目标文件超过自动对账哈希上限，已转人工确认'
    })
  }
  const observedSha256 = await sha256File(resolved.fullPath)
  const hashedPayload = { ...payload, observedSha256 }
  if (observedSha256 === target.expectedSha256 && couldBeExpected) {
    return confirmed(hashedPayload, '文件内容与预期摘要完全一致')
  }
  if (
    target.preState === 'file' &&
    target.preSha256 === observedSha256
  ) {
    return notApplied(hashedPayload, '文件仍是执行前内容，已授权后续生成新 lease 重试')
  }
  return unresolved({ ...hashedPayload, reason: '文件既不是执行前状态，也不是预期状态' })
}

async function reconcileGitCommit(
  target: Extract<EffectTarget, { kind: 'git_commit' }>
): Promise<EffectReconciliationResult> {
  const deadline = Date.now() + GIT_COMMIT_RECONCILIATION_BUDGET_MS
  const currentRoot = await resolveRepoRoot(target.repoRoot)
  if (realpathSync(currentRoot) !== realpathSync(target.repoRoot)) {
    return unresolved({ kind: target.kind, reason: 'Git 仓库身份已变化' })
  }
  const revList = await gitRun(
    target.repoRoot,
    ['rev-list', '--all', '--reflog', '--parents'],
    [0],
    GIT_SCAN_TIMEOUT_MS
  )
  if (!revList.ok) return unresolved({ kind: target.kind, reason: revList.error })
  const candidateShas: string[] = []
  for (const line of revList.stdout.split(/\r?\n/)) {
    const [sha, ...parents] = line.trim().split(/\s+/)
    if (!sha || parents[0] !== target.preHead) continue
    candidateShas.push(sha)
  }
  const uniqueCandidateShas = [...new Set(candidateShas)]
  if (uniqueCandidateShas.length > MAX_GIT_COMMIT_CANDIDATES) {
    return unresolved({
      kind: target.kind,
      candidateCount: uniqueCandidateShas.length,
      candidateLimit: MAX_GIT_COMMIT_CANDIDATES,
      reason: '匹配 preHead 的 commit 候选过多，已停止自动对账'
    })
  }
  const inspected = await mapWithConcurrency(
    uniqueCandidateShas,
    GIT_CANDIDATE_CONCURRENCY,
    async (sha): Promise<{ sha?: string; error?: string }> => {
      try {
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) return { error: 'commit 对账总预算已耗尽' }
        const timeoutMs = Math.max(1, Math.min(GIT_LOCAL_TIMEOUT_MS, remainingMs))
        const [stagedDiff, message, reachable] = await Promise.all([
          gitTextAllowEmpty(target.repoRoot, [
            'diff-tree',
            '--binary',
            '--full-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--no-commit-id',
            '-p',
            target.preHead,
            sha
          ], timeoutMs),
          gitText(target.repoRoot, ['show', '-s', '--format=%B', sha], timeoutMs),
          gitRun(
            target.repoRoot,
            ['merge-base', '--is-ancestor', sha, `refs/heads/${target.branch}`],
            [0, 1],
            timeoutMs
          )
        ])
        if (!reachable.ok) return { error: reachable.error }
        if (stableValueDigest(stagedDiff) !== target.stagedDiffDigest) return {}
        if (stableValueDigest(message.trim()) !== target.messageDigest) return {}
        return reachable.status === 0 ? { sha } : {}
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  const inspectionError = inspected.find((item) => item.error)?.error
  if (inspectionError) {
    return unresolved({ kind: target.kind, reason: `候选 commit 查询失败: ${inspectionError}` })
  }
  const candidates = inspected.flatMap((item) => item.sha ? [item.sha] : [])
  const payload = {
    kind: target.kind,
    branch: target.branch,
    preHead: target.preHead,
    stagedDiffDigest: target.stagedDiffDigest,
    candidates: [...new Set(candidates)].sort()
  }
  if (payload.candidates.length === 1) return confirmed(payload, '找到唯一且仍可从原分支到达的匹配 commit')
  return unresolved({
    ...payload,
    reason: payload.candidates.length === 0 ? '未找到唯一可确认的 commit' : '找到多个匹配 commit，禁止自动选择'
  })
}

async function reconcileGitPush(
  target: Extract<EffectTarget, { kind: 'git_push' }>
): Promise<EffectReconciliationResult> {
  const currentPushUrls = await gitLines(target.repoRoot, ['remote', 'get-url', '--push', '--all', target.remote])
  if (currentPushUrls.length !== 1) {
    return unresolved({ kind: target.kind, remote: target.remote, reason: 'Git remote 当前存在多个 push URL' })
  }
  const currentPushUrl = currentPushUrls[0]
  const currentUrlDigest = stableValueDigest(sanitizeRemoteUrl(currentPushUrl))
  if (currentUrlDigest !== target.pushUrlDigest) {
    return unresolved({ kind: target.kind, remote: target.remote, reason: 'push URL 身份已变化' })
  }
  let probeUrl: string
  try {
    probeUrl = normalizeRemoteProbeUrl(target.repoRoot, currentPushUrl)
  } catch (error) {
    return unresolved({
      kind: target.kind,
      remote: target.remote,
      reason: error instanceof Error ? error.message : String(error)
    })
  }
  const probe = await gitRemoteRun(
    ['ls-remote', '--heads', probeUrl, target.ref],
    [0, 2],
    GIT_REMOTE_TIMEOUT_MS
  )
  if (!probe.ok && probe.status !== 2) {
    return unresolved({ kind: target.kind, remote: target.remote, ref: target.ref, reason: probe.error })
  }
  const observedSha = parseRemoteSha(probe.stdout, target.ref)
  const payload = { kind: target.kind, remote: target.remote, ref: target.ref, observedSha }
  if (observedSha === target.intendedSha) return confirmed(payload, '远端 ref 与预期 SHA 完全一致')
  return unresolved({
    ...payload,
    reason: observedSha ? '远端 ref 已指向其他 SHA' : '远端 ref 不存在或无法确认'
  })
}

function confirmed(payload: unknown, reason: string): EffectReconciliationResult {
  return {
    kind: 'confirmed',
    evidenceDigest: stableValueDigest(payload),
    verifier: EFFECT_RECONCILER_VERSION,
    reason
  }
}

function notApplied(payload: unknown, reason: string): EffectReconciliationResult {
  return {
    kind: 'not_applied',
    evidenceDigest: stableValueDigest(payload),
    verifier: EFFECT_RECONCILER_VERSION,
    reason
  }
}

function unresolved(payload: unknown): EffectReconciliationResult {
  const reason = typeof payload === 'object' && payload && 'reason' in payload
    ? String((payload as { reason: unknown }).reason)
    : '外部状态无法确认'
  return {
    kind: 'unresolved',
    evidenceDigest: stableValueDigest(payload),
    verifier: EFFECT_RECONCILER_VERSION,
    reason
  }
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  const root = await gitText(cwd, ['rev-parse', '--show-toplevel'])
  return realpathSync(root)
}

function parseRemoteSha(output: string, ref: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const [sha, remoteRef] = line.trim().split(/\s+/)
    if (sha && remoteRef === ref) return sha
  }
  return undefined
}

async function gitText(cwd: string, args: string[], timeoutMs = GIT_LOCAL_TIMEOUT_MS): Promise<string> {
  const result = await gitRun(cwd, args, [0], timeoutMs)
  if (!result.ok) throw new Error(result.error)
  const text = result.stdout.trim()
  if (!text) throw new Error(`git ${args[0]} 未返回结果`)
  return text
}

async function gitTextAllowEmpty(
  cwd: string,
  args: string[],
  timeoutMs = GIT_LOCAL_TIMEOUT_MS
): Promise<string> {
  const result = await gitRun(cwd, args, [0], timeoutMs)
  if (!result.ok) throw new Error(result.error)
  return result.stdout
}

async function gitLines(cwd: string, args: string[], timeoutMs = GIT_LOCAL_TIMEOUT_MS): Promise<string[]> {
  const result = await gitRun(cwd, args, [0], timeoutMs)
  if (!result.ok) throw new Error(result.error)
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function gitRun(
  cwd: string,
  args: string[],
  allowStatuses: number[] = [0],
  timeoutMs = GIT_LOCAL_TIMEOUT_MS
): Promise<GitRunResult> {
  return new Promise((resolveResult) => {
    execFile('git', withSafeLocalGitConfig(['-C', cwd, ...args]), {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      env: {
        ...process.env,
        GCM_INTERACTIVE: 'Never',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0'
      }
    }, (error, stdoutValue, stderrValue) => {
      resolveResult(gitRunResult(args, allowStatuses, timeoutMs, error, stdoutValue, stderrValue))
    })
  })
}

function gitRemoteRun(
  args: string[],
  allowStatuses: number[] = [0],
  timeoutMs = GIT_REMOTE_TIMEOUT_MS
): Promise<GitRunResult> {
  let isolatedCwd: string
  try {
    isolatedCwd = mkdtempSync(join(tmpdir(), 'caogen-git-probe-'))
  } catch (error) {
    return Promise.resolve({
      ok: false,
      status: null,
      stdout: '',
      error: `无法创建隔离的 Git 远端探针目录:${error instanceof Error ? error.message : String(error)}`
    })
  }
  return new Promise((resolveResult) => {
    const env = isolatedRemoteGitEnv(process.env)
    env.GIT_CEILING_DIRECTORIES = isolatedCwd
    env.GIT_DISCOVERY_ACROSS_FILESYSTEM = '0'
    execFile('git', withSafeRemoteGitConfig(args), {
      cwd: isolatedCwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      env
    }, (error, stdoutValue, stderrValue) => {
      try {
        resolveResult(gitRunResult(args, allowStatuses, timeoutMs, error, stdoutValue, stderrValue))
      } finally {
        rmSync(isolatedCwd, { recursive: true, force: true })
      }
    })
  })
}

function gitRunResult(
  args: string[],
  allowStatuses: number[],
  timeoutMs: number,
  error: Error | null,
  stdoutValue: string | Buffer,
  stderrValue: string | Buffer
): GitRunResult {
  const failure = error as (Error & {
    code?: string | number
    killed?: boolean
    signal?: string
  }) | null
  const stdout = String(stdoutValue ?? '')
  const stderr = String(stderrValue ?? '')
  const status = failure
    ? typeof failure.code === 'number'
      ? failure.code
      : null
    : 0
  const timedOut = !!failure && (
    failure.code === 'ETIMEDOUT' ||
    (failure.killed === true && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  )
  const ok = status !== null && allowStatuses.includes(status)
  return {
    ok,
    status,
    stdout,
    error: timedOut
      ? `git ${args[0]} timed out after ${timeoutMs}ms`
      : redactGitError(stderr.trim() || failure?.message || stdout.trim() || `git ${args[0]} failed`)
  }
}

function normalizeRemoteProbeUrl(repoRoot: string, value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Git push URL 为空，已停止自动对账')
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(trimmed)) {
    throw new Error('Git remote helper 协议可能执行外部命令，已停止自动对账')
  }
  if (isAbsolute(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    if (!new Set(['file:', 'git:', 'http:', 'https:', 'ssh:']).has(url.protocol)) {
      throw new Error(`Git push URL 协议 ${url.protocol} 不允许自动对账`)
    }
    return trimmed
  } catch (error) {
    if (error instanceof Error && error.message.includes('不允许自动对账')) throw error
  }
  if (/^(?:[^@\s/:]+@)?[^:\s/]+:.+$/.test(trimmed)) return trimmed
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
    throw new Error('Git push URL 使用未知协议，已停止自动对账')
  }
  return resolve(repoRoot, trimmed)
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await worker(items[index])
      }
    }
  )
  await Promise.all(workers)
  return results
}

function sanitizeRemoteUrl(value: string): string {
  const trimmed = value.trim()
  try {
    const url = new URL(trimmed)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return trimmed.replace(/^[^@\s]+@/, '')
  }
}

function redactGitError(value: string): string {
  return value
    .replace(/\b(?:https?|ssh|git|file):\/\/[^\s'"<>]+/gi, (match) => sanitizeRemoteUrl(match))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b[^\s'"<>@]+@([A-Za-z0-9.-]+(?::[^\s'"<>]+)?)/g, '$1')
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('效果描述缺少必需字符串参数')
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
