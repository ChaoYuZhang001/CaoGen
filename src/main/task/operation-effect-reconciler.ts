import { realpathSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { EffectTarget, FileSystemIdentity } from '../../shared/types'
import {
  exactMarkerRecords,
  queryPullRequestEffectTarget
} from '../git/pull-request-effect'
import type { EffectReconciliationResult } from './effect-reconciliation-result'
import { stableValueDigest } from './tool-idempotency'

const GIT_SCAN_TIMEOUT_MS = 30_000
const MAX_PATCH_RECONCILIATION_BYTES = 100 * 1024 * 1024
const MAX_PATCH_CHANGED_PATHS = 4_096

interface GitRunResult {
  ok: boolean
  status: number | null
  stdout: string
  error: string
}

type ObservedFile =
  | { state: 'absent' }
  | {
      state: 'file'
      identity: FileSystemIdentity
      bytes: number
      sha256?: string
    }

export interface OperationEffectReconcilerContext {
  resolveRepoRoot(cwd: string): Promise<string>
  resolveGitDirectory(repoRoot: string, args: string[]): Promise<string>
  gitText(cwd: string, args: string[], timeoutMs?: number): Promise<string>
  gitLines(cwd: string, args: string[], timeoutMs?: number): Promise<string[]>
  gitRun(
    cwd: string,
    args: string[],
    allowStatuses?: number[],
    timeoutMs?: number,
    input?: string
  ): Promise<GitRunResult>
  readFileObservation(filePath: string, maxHashBytes: number): Promise<ObservedFile>
  fileSystemIdentity(path: string): FileSystemIdentity
  sameFileSystemIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean
  sanitizeRemoteUrl(value: string): string
  sha256(value: string | Buffer): string
  confirmed(payload: unknown, reason: string): EffectReconciliationResult
  notApplied(payload: unknown, reason: string): EffectReconciliationResult
  unresolved(payload: unknown): EffectReconciliationResult
}

interface PatchRepositories {
  repoRoot: string
  gitCommonDir: string
  worktreePath: string
}

interface FrozenPatchCommits {
  baseSha: string
  headSha: string
  preHead: string
}

interface PatchArtifact {
  patchPath: string
  identity: FileSystemIdentity
  sha256: string
  bytes: number
  text: string
}

interface ReconciliationRepositories extends PatchRepositories {
  worktreeCommonDir: string
}

export async function buildWorktreePatchApplyTarget(
  cwd: string,
  toolInput: Record<string, unknown>,
  context: OperationEffectReconcilerContext
): Promise<EffectTarget> {
  const repositories = await resolvePatchRepositories(cwd, toolInput, context)
  const commits = await freezePatchCommits(repositories, toolInput, context)
  const artifact = await observePatchArtifact(toolInput, context)
  const mode = patchOperationMode(toolInput.direction)
  const changedPaths = await inspectPreparedPatch(repositories.repoRoot, artifact.text, mode, context)
  return {
    kind: 'worktree_patch_apply',
    repoRoot: repositories.repoRoot,
    repoRootIdentity: context.fileSystemIdentity(repositories.repoRoot),
    gitCommonDir: repositories.gitCommonDir,
    gitCommonDirIdentity: context.fileSystemIdentity(repositories.gitCommonDir),
    worktreePath: repositories.worktreePath,
    worktreeRootIdentity: context.fileSystemIdentity(repositories.worktreePath),
    ...commits,
    patchPath: artifact.patchPath,
    patchFileIdentity: artifact.identity,
    patchSha256: artifact.sha256,
    patchBytes: artifact.bytes,
    changedPaths,
    mode
  }
}

function patchOperationMode(value: unknown): 'apply' | 'reverse' {
  if (value === undefined || value === 'apply') return 'apply'
  if (value === 'reverse') return 'reverse'
  throw new Error('worktree patch direction 必须是 apply 或 reverse')
}

async function resolvePatchRepositories(
  cwd: string,
  toolInput: Record<string, unknown>,
  context: OperationEffectReconcilerContext
): Promise<PatchRepositories> {
  const repoRoot = await context.resolveRepoRoot(cwd)
  const requestedRepoRoot = realpathSync(resolve(requiredString(toolInput.repoRoot ?? toolInput.repo_root)))
  if (repoRoot !== requestedRepoRoot) throw new Error('worktree patch 的 repoRoot 与当前执行目录不一致')
  const requestedWorktreePath = requiredString(toolInput.worktreePath ?? toolInput.worktree_path)
  const worktreePath = await context.resolveRepoRoot(requestedWorktreePath)
  if (worktreePath !== realpathSync(resolve(requestedWorktreePath))) {
    throw new Error('worktreePath 必须是 Git worktree 根目录')
  }
  const gitCommonDir = await context.resolveGitDirectory(repoRoot, ['rev-parse', '--git-common-dir'])
  const worktreeCommonDir = await context.resolveGitDirectory(worktreePath, ['rev-parse', '--git-common-dir'])
  if (gitCommonDir !== worktreeCommonDir) throw new Error('worktree patch 来源不属于目标仓库')
  return { repoRoot, gitCommonDir, worktreePath }
}

async function freezePatchCommits(
  repositories: PatchRepositories,
  toolInput: Record<string, unknown>,
  context: OperationEffectReconcilerContext
): Promise<FrozenPatchCommits> {
  const baseSha = await frozenCommit(
    repositories.worktreePath,
    requiredString(toolInput.baseSha ?? toolInput.base_sha),
    'baseSha',
    context
  )
  const headSha = await frozenCommit(
    repositories.worktreePath,
    requiredString(toolInput.headSha ?? toolInput.head_sha),
    'headSha',
    context
  )
  const currentWorktreeHead = await context.gitText(
    repositories.worktreePath,
    ['rev-parse', '--verify', 'HEAD^{commit}']
  )
  if (currentWorktreeHead !== headSha) throw new Error('worktree HEAD 已偏离准备 patch 时状态')
  const preHead = await context.gitText(repositories.repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
  return { baseSha, headSha, preHead }
}

async function frozenCommit(
  repoRoot: string,
  value: string,
  label: string,
  context: OperationEffectReconcilerContext
): Promise<string> {
  const resolved = await context.gitText(repoRoot, ['rev-parse', '--verify', `${value}^{commit}`])
  if (resolved !== value) throw new Error(`${label} 必须是完整且不可变的 commit SHA`)
  return resolved
}

async function observePatchArtifact(
  toolInput: Record<string, unknown>,
  context: OperationEffectReconcilerContext
): Promise<PatchArtifact> {
  const rawPatchPath = resolve(requiredString(toolInput.patchPath ?? toolInput.patch_path))
  const rawPatchStats = await lstat(rawPatchPath, { bigint: true })
  if (rawPatchStats.isSymbolicLink() || !rawPatchStats.isFile()) {
    throw new Error('worktree patch artifact 必须是非符号链接的普通文件')
  }
  const patchPath = realpathSync(rawPatchPath)
  const observation = await context.readFileObservation(patchPath, MAX_PATCH_RECONCILIATION_BYTES)
  if (observation.state !== 'file' || typeof observation.sha256 !== 'string') {
    throw new Error(`worktree patch 超过自动保护上限 ${MAX_PATCH_RECONCILIATION_BYTES} bytes`)
  }
  if (observation.bytes === 0) throw new Error('worktree patch 为空，不需要建立外部效果')
  const requestedDigest = optionalString(toolInput.patchSha256 ?? toolInput.patch_sha256)
  if (requestedDigest && requestedDigest !== observation.sha256) {
    throw new Error('worktree patch artifact 摘要与调用参数不一致')
  }
  const patch = await readFile(patchPath)
  if (patch.byteLength !== observation.bytes || context.sha256(patch) !== observation.sha256) {
    throw new Error('worktree patch artifact 在效果描述期间发生变化')
  }
  return {
    patchPath,
    identity: observation.identity,
    sha256: observation.sha256,
    bytes: observation.bytes,
    text: patch.toString('utf8')
  }
}

async function inspectPreparedPatch(
  repoRoot: string,
  patchText: string,
  mode: 'apply' | 'reverse',
  context: OperationEffectReconcilerContext
): Promise<string[]> {
  const forwardApplicable = await patchApplicable(repoRoot, patchText, false, context)
  const reverseApplicable = await patchApplicable(repoRoot, patchText, true, context)
  if (mode === 'reverse') {
    if (!reverseApplicable) throw new Error('worktree reverse patch 在建立效果 lease 前已无法应用')
    if (forwardApplicable) {
      throw new Error('worktree reverse patch 在执行前已呈现可正向应用状态，无法证明尚未执行')
    }
  } else {
    if (!forwardApplicable) throw new Error('worktree patch 在建立效果 lease 前已无法应用')
    if (reverseApplicable) {
      throw new Error('worktree patch 在执行前已呈现可反向应用状态，无法证明尚未执行')
    }
  }
  const changedPaths = await patchChangedPaths(repoRoot, patchText, context)
  if (changedPaths.length === 0) throw new Error('worktree patch 没有可识别的改动路径')
  return changedPaths
}

async function patchApplicable(
  repoRoot: string,
  patchText: string,
  reverse: boolean,
  context: OperationEffectReconcilerContext
): Promise<boolean> {
  const args = ['apply', ...(reverse ? ['-R'] : []), '--check', '--whitespace=nowarn', '-']
  const result = await context.gitRun(repoRoot, args, [0, 1], GIT_SCAN_TIMEOUT_MS, patchText)
  if (!result.ok) throw new Error(result.error)
  return result.status === 0
}

async function patchChangedPaths(
  repoRoot: string,
  patchText: string,
  context: OperationEffectReconcilerContext
): Promise<string[]> {
  const result = await context.gitRun(
    repoRoot,
    ['apply', '--numstat', '-z', '-'],
    [0],
    GIT_SCAN_TIMEOUT_MS,
    patchText
  )
  if (!result.ok) throw new Error(`无法枚举 worktree patch 路径:${result.error}`)
  return collectChangedPaths(repoRoot, result.stdout.split('\0'))
}

function collectChangedPaths(repoRoot: string, tokens: string[]): string[] {
  const paths = new Set<string>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    index += collectChangedPath(repoRoot, tokens, index, paths)
    if (paths.size > MAX_PATCH_CHANGED_PATHS) {
      throw new Error(`worktree patch 改动路径超过自动保护上限 ${MAX_PATCH_CHANGED_PATHS}`)
    }
  }
  return [...paths].sort()
}

function collectChangedPath(
  repoRoot: string,
  tokens: string[],
  index: number,
  paths: Set<string>
): number {
  const token = tokens[index]
  const firstTab = token.indexOf('\t')
  const secondTab = firstTab >= 0 ? token.indexOf('\t', firstTab + 1) : -1
  if (secondTab < 0) throw new Error('worktree patch numstat 输出格式无效')
  const inlinePath = token.slice(secondTab + 1)
  if (inlinePath) {
    addPatchPath(paths, repoRoot, inlinePath)
    return 0
  }
  const oldPath = tokens[index + 1]
  const newPath = tokens[index + 2]
  if (!oldPath || !newPath) throw new Error('worktree patch rename/copy 路径不完整')
  addPatchPath(paths, repoRoot, oldPath)
  addPatchPath(paths, repoRoot, newPath)
  return 2
}

function addPatchPath(paths: Set<string>, repoRoot: string, value: string): void {
  const normalized = value.split('\\').join('/')
  const fullPath = resolve(repoRoot, normalized)
  const relativePath = relative(repoRoot, fullPath).split('\\').join('/')
  if (!relativePath || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error(`worktree patch 路径越界:${value}`)
  }
  paths.add(relativePath)
}

export async function reconcileWorktreePatchApply(
  target: Extract<EffectTarget, { kind: 'worktree_patch_apply' }>,
  context: OperationEffectReconcilerContext
): Promise<EffectReconciliationResult> {
  const repositories = await resolveReconciliationRepositories(target, context)
  if (!repositoriesMatchTarget(repositories, target, context)) {
    return context.unresolved({ kind: target.kind, reason: 'worktree patch 的仓库或文件系统身份已变化' })
  }
  const [currentHead, currentWorktreeHead] = await Promise.all([
    context.gitText(repositories.repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    context.gitText(repositories.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])
  ])
  if (currentHead !== target.preHead || currentWorktreeHead !== target.headSha) {
    return context.unresolved({
      kind: target.kind,
      currentHead,
      currentWorktreeHead,
      reason: '目标 HEAD 或来源 worktree HEAD 已偏离执行前状态'
    })
  }
  const artifact = await readReconciliationArtifact(target, context)
  if (!artifact) {
    return context.unresolved({ kind: target.kind, reason: 'worktree patch artifact 已缺失、替换或内容发生变化' })
  }
  return reconcilePatchState(target, repositories.repoRoot, artifact, context)
}

async function resolveReconciliationRepositories(
  target: Extract<EffectTarget, { kind: 'worktree_patch_apply' }>,
  context: OperationEffectReconcilerContext
): Promise<ReconciliationRepositories> {
  const repoRoot = await context.resolveRepoRoot(target.repoRoot)
  const worktreePath = await context.resolveRepoRoot(target.worktreePath)
  const gitCommonDir = await context.resolveGitDirectory(repoRoot, ['rev-parse', '--git-common-dir'])
  const worktreeCommonDir = await context.resolveGitDirectory(worktreePath, ['rev-parse', '--git-common-dir'])
  return { repoRoot, worktreePath, gitCommonDir, worktreeCommonDir }
}

function repositoriesMatchTarget(
  current: ReconciliationRepositories,
  target: Extract<EffectTarget, { kind: 'worktree_patch_apply' }>,
  context: OperationEffectReconcilerContext
): boolean {
  return [
    current.repoRoot === realpathSync(target.repoRoot),
    current.worktreePath === realpathSync(target.worktreePath),
    current.gitCommonDir === realpathSync(target.gitCommonDir),
    current.worktreeCommonDir === current.gitCommonDir,
    context.sameFileSystemIdentity(context.fileSystemIdentity(current.repoRoot), target.repoRootIdentity),
    context.sameFileSystemIdentity(context.fileSystemIdentity(current.gitCommonDir), target.gitCommonDirIdentity),
    context.sameFileSystemIdentity(context.fileSystemIdentity(current.worktreePath), target.worktreeRootIdentity)
  ].every(Boolean)
}

async function readReconciliationArtifact(
  target: Extract<EffectTarget, { kind: 'worktree_patch_apply' }>,
  context: OperationEffectReconcilerContext
): Promise<string | undefined> {
  const observation = await context.readFileObservation(target.patchPath, MAX_PATCH_RECONCILIATION_BYTES)
  if (!artifactObservationMatches(observation, target, context)) return undefined
  const patch = await readFile(target.patchPath)
  if (patch.byteLength !== target.patchBytes || context.sha256(patch) !== target.patchSha256) {
    throw new Error('worktree patch artifact 在对账读取期间发生变化')
  }
  return patch.toString('utf8')
}

function artifactObservationMatches(
  observation: ObservedFile,
  target: Extract<EffectTarget, { kind: 'worktree_patch_apply' }>,
  context: OperationEffectReconcilerContext
): boolean {
  if (observation.state !== 'file' || typeof observation.sha256 !== 'string') return false
  return [
    observation.bytes === target.patchBytes,
    observation.sha256 === target.patchSha256,
    context.sameFileSystemIdentity(observation.identity, target.patchFileIdentity)
  ].every(Boolean)
}

async function reconcilePatchState(
  target: Extract<EffectTarget, { kind: 'worktree_patch_apply' }>,
  repoRoot: string,
  patchText: string,
  context: OperationEffectReconcilerContext
): Promise<EffectReconciliationResult> {
  const [forwardApplicable, reverseApplicable] = await Promise.all([
    patchApplicable(repoRoot, patchText, false, context),
    patchApplicable(repoRoot, patchText, true, context)
  ])
  const payload = {
    kind: target.kind,
    mode: target.mode ?? 'apply',
    repoRoot: target.repoRoot,
    preHead: target.preHead,
    patchSha256: target.patchSha256,
    changedPaths: target.changedPaths,
    forwardApplicable,
    reverseApplicable
  }
  if ((target.mode ?? 'apply') === 'reverse') {
    if (forwardApplicable && !reverseApplicable) {
      return context.confirmed(payload, '目标工作区只允许正向应用冻结 patch，已确认反向 patch 生效')
    }
    if (!forwardApplicable && reverseApplicable) {
      return context.notApplied(payload, '目标工作区仍只允许反向应用冻结 patch，已确认反向 patch 未生效')
    }
  } else {
    if (!forwardApplicable && reverseApplicable) {
      return context.confirmed(payload, '目标工作区只允许反向应用冻结 patch，已确认 patch 生效')
    }
    if (forwardApplicable && !reverseApplicable) {
      return context.notApplied(payload, '目标工作区仍允许正向应用且不能反向应用，已确认 patch 未生效')
    }
  }
  return context.unresolved({
    ...payload,
    reason: forwardApplicable
      ? '冻结 patch 同时可正向和反向应用，目标状态存在歧义'
      : '冻结 patch 正向和反向均不可应用，目标状态已漂移'
  })
}

export async function reconcilePullRequestCreate(
  target: Extract<EffectTarget, { kind: 'pull_request_create' }>,
  context: OperationEffectReconcilerContext
): Promise<EffectReconciliationResult> {
  const currentRoot = await context.resolveRepoRoot(target.repoRoot)
  if (!pullRequestRepositoryMatches(currentRoot, target, context)) {
    return context.unresolved({ kind: target.kind, reason: 'PR/MR 本地仓库身份已变化' })
  }
  const currentUrls = await context.gitLines(currentRoot, ['remote', 'get-url', '--all', target.remote])
  if (!pullRequestRemoteMatches(currentUrls, target, context)) {
    return context.unresolved({ kind: target.kind, remote: target.remote, reason: 'PR/MR remote URL 身份已变化' })
  }
  const observation = await queryPullRequestEffectTarget(target)
  if (!observation.complete) {
    return context.unresolved({
      kind: target.kind,
      repositoryDigest: target.repositoryDigest,
      sourceBranch: target.sourceBranch,
      reason: observation.error ?? 'PR/MR 查询结果不完整'
    })
  }
  return classifyPullRequestObservation(target, observation.records, context)
}

function pullRequestRepositoryMatches(
  currentRoot: string,
  target: Extract<EffectTarget, { kind: 'pull_request_create' }>,
  context: OperationEffectReconcilerContext
): boolean {
  return [
    currentRoot === realpathSync(target.repoRoot),
    context.sameFileSystemIdentity(context.fileSystemIdentity(currentRoot), target.repoRootIdentity)
  ].every(Boolean)
}

function pullRequestRemoteMatches(
  currentUrls: string[],
  target: Extract<EffectTarget, { kind: 'pull_request_create' }>,
  context: OperationEffectReconcilerContext
): boolean {
  if (currentUrls.length !== 1) return false
  return stableValueDigest(context.sanitizeRemoteUrl(currentUrls[0])) === target.remoteUrlDigest
}

function classifyPullRequestObservation(
  target: Extract<EffectTarget, { kind: 'pull_request_create' }>,
  records: Awaited<ReturnType<typeof queryPullRequestEffectTarget>>['records'],
  context: OperationEffectReconcilerContext
): EffectReconciliationResult {
  const exact = exactMarkerRecords(target, records)
  const payload = pullRequestEvidence(target, records, exact)
  if (exact.length === 1) {
    return context.confirmed(payload, '找到唯一 exact marker/source/base PR/MR，已确认创建副作用发生')
  }
  if (exact.length > 1) {
    return context.unresolved({ ...payload, reason: '同一 Effect marker 匹配多个 PR/MR，无法唯一对账' })
  }
  if (records.length > 0) {
    return context.unresolved({ ...payload, reason: 'source branch 存在其他 PR/MR，但没有 exact marker' })
  }
  return context.unresolved({
    ...payload,
    reason: '未观察到 PR/MR；平台不提供可证明历史上从未创建的幂等查询，禁止自动重放'
  })
}

function pullRequestEvidence(
  target: Extract<EffectTarget, { kind: 'pull_request_create' }>,
  records: Awaited<ReturnType<typeof queryPullRequestEffectTarget>>['records'],
  exact: Awaited<ReturnType<typeof queryPullRequestEffectTarget>>['records']
): Record<string, unknown> {
  return {
    kind: target.kind,
    repositoryDigest: target.repositoryDigest,
    sourceBranch: target.sourceBranch,
    sourceSha: target.sourceSha,
    baseBranch: target.baseBranch,
    markerDigest: stableValueDigest(target.marker),
    exact: exact.map((record) => ({
      id: record.id,
      url: record.url,
      state: record.state,
      headSha: record.headSha,
      headDrift: !!record.headSha && record.headSha !== target.sourceSha
    })),
    observedCount: records.length
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('效果描述缺少必需字符串参数')
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
