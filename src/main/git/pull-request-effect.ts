import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EffectTarget, FileSystemIdentity } from '../../shared/types'
import { stableValueDigest } from '../task/tool-idempotency'
import {
  isolatedLocalGitEnv,
  isolatedRemoteGitEnv,
  withSafeLocalGitConfig,
  withSafeRemoteGitConfig
} from './safe-git'

const LOCAL_TIMEOUT_MS = 15_000
const REMOTE_TIMEOUT_MS = 30_000
const CLI_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 16 * 1024 * 1024
const MAX_GITHUB_RESULTS = 1_000
const MAX_GITLAB_RESULTS = 100

export type PullRequestEffectTarget = Extract<EffectTarget, { kind: 'pull_request_create' }>
export type PullRequestProvider = PullRequestEffectTarget['provider']
export type PullRequestTool = 'gh' | 'glab'

export interface PullRequestCapability {
  available: boolean
  provider?: PullRequestProvider
  tool?: PullRequestTool
  message?: string
}

export interface PullRequestEffectObservation {
  complete: boolean
  records: PullRequestObservationRecord[]
  error?: string
}

export interface PullRequestObservationRecord {
  id: string
  url: string
  state: string
  sourceBranch: string
  baseBranch: string
  headSha?: string
  body: string
}

interface PullRequestExecutionInput {
  target: PullRequestEffectTarget
  title: string
  body: string
}

interface ValidatedPullRequestExecution {
  title: string
  body: string
}

interface PullRequestCliCommand {
  args: string[]
  env: Record<string, string>
}

export type PullRequestEffectExecutionResult =
  | {
      ok: true
      repoRoot: string
      provider: PullRequestProvider
      tool: PullRequestTool
      branch: string
      base: string
      url: string
      existing?: boolean
    }
  | { ok: false; error: string; repoRoot?: string; details?: string }

export async function buildPullRequestEffectTarget(input: {
  cwd: string
  title: string
  body: string
  base?: string
}): Promise<PullRequestEffectTarget> {
  const repo = await inspectRepository(input.cwd)
  const title = requiredText(input.title, 'PR 标题')
  const body = typeof input.body === 'string' ? input.body : ''
  const sourceBranch = await gitText(repo.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  await assertBranchName(repo.repoRoot, sourceBranch, 'source branch')
  const sourceSha = await gitText(repo.repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const baseBranch = input.base?.trim() || await defaultBaseBranch(repo)
  await assertBranchName(repo.repoRoot, baseBranch, 'base branch')
  const remoteSourceSha = await remoteBranchSha(repo, sourceBranch)
  if (remoteSourceSha !== sourceSha) {
    throw new Error(`远端分支 ${repo.remote}/${sourceBranch} 不存在或未指向当前 HEAD；请先显式调用 git_push`)
  }
  const titleDigest = stableValueDigest(title)
  const bodyDigest = stableValueDigest(body)
  const repositoryDigest = stableValueDigest({
    provider: repo.provider,
    host: repo.host,
    projectPath: repo.projectPath,
    remoteUrlDigest: repo.remoteUrlDigest
  })
  const markerSeed = stableValueDigest({
    schema: 'caogen-pr-v1',
    provider: repo.provider,
    host: repo.host,
    projectPath: repo.projectPath,
    sourceBranch,
    sourceSha,
    baseBranch,
    titleDigest,
    bodyDigest
  })
  const target: PullRequestEffectTarget = {
    kind: 'pull_request_create',
    provider: repo.provider,
    repoRoot: repo.repoRoot,
    repoRootIdentity: fileSystemIdentity(repo.repoRoot),
    remote: repo.remote,
    remoteUrlDigest: repo.remoteUrlDigest,
    host: repo.host,
    projectPath: repo.projectPath,
    repositoryDigest,
    sourceBranch,
    sourceSha,
    baseBranch,
    titleDigest,
    bodyDigest,
    marker: `<!-- caogen-effect:pull-request:v1:${markerSeed} -->`
  }
  const observation = await queryPullRequestEffectTarget(target)
  if (!observation.complete) throw new Error(observation.error ?? 'PR/MR 远端状态查询不完整')
  const exact = exactMarkerRecords(target, observation.records)
  if (exact.length > 1) throw new Error('同一 Effect marker 匹配多个 PR/MR，已阻止继续执行')
  if (exact.length === 0 && observation.records.length > 0) {
    throw new Error(`source branch ${sourceBranch} 已存在其他 PR/MR，已阻止重复创建`)
  }
  return target
}

export function inspectPullRequestCapability(cwd: string): PullRequestCapability {
  try {
    const repoRoot = syncGitText(cwd, ['rev-parse', '--show-toplevel'])
    const remote = preferredRemoteSync(repoRoot)
    if (!remote) return { available: false, message: '未配置 Git remote，无法创建 PR/MR' }
    const url = syncGitText(repoRoot, ['remote', 'get-url', remote])
    const parsed = parseRemoteUrl(url)
    if (!parsed.provider || !parsed.host || !parsed.projectPath) {
      return { available: false, message: '当前 remote 不是受支持的 GitHub/GitLab 仓库' }
    }
    const tool = toolForProvider(parsed.provider)
    if (!commandExists(tool)) {
      return {
        available: false,
        provider: parsed.provider,
        tool,
        message: `已识别 ${parsed.provider} remote，但本机未检测到 ${tool}`
      }
    }
    return { available: true, provider: parsed.provider, tool }
  } catch (error) {
    return { available: false, message: errorText(error) }
  }
}

export async function queryPullRequestEffectTarget(
  target: PullRequestEffectTarget
): Promise<PullRequestEffectObservation> {
  const tool = toolForProvider(target.provider)
  if (!commandExists(tool)) {
    return { complete: false, records: [], error: `本机未检测到 ${tool}，无法对账 PR/MR` }
  }
  const command: { args: string[]; env: Record<string, string> } = target.provider === 'github'
    ? {
        args: [
          'pr', 'list',
          '--repo', repoSelector(target),
          '--state', 'all',
          '--head', target.sourceBranch,
          '--limit', String(MAX_GITHUB_RESULTS),
          '--json', 'number,url,state,headRefName,headRefOid,baseRefName,body'
        ],
        env: { GH_PROMPT_DISABLED: '1', ...(target.host !== 'github.com' ? { GH_HOST: target.host } : {}) }
      }
    : {
        args: [
          'api',
          '--hostname', target.host,
          '--method', 'GET',
          `projects/${encodeURIComponent(target.projectPath)}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(target.sourceBranch)}&per_page=${MAX_GITLAB_RESULTS}`
        ],
        env: { GITLAB_HOST: target.host }
      }
  const result = await cliRun(tool, command.args, target.repoRoot, command.env)
  if (!result.ok) return { complete: false, records: [], error: result.error }
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    if (!Array.isArray(parsed)) throw new Error('CLI 未返回 JSON 数组')
    const limit = target.provider === 'github' ? MAX_GITHUB_RESULTS : MAX_GITLAB_RESULTS
    const records = parsed.map((item) => parseObservationRecord(target.provider, item))
    if (records.some((item) => item.sourceBranch !== target.sourceBranch)) {
      throw new Error('CLI 返回了 source branch 不匹配的记录')
    }
    if (records.length >= limit) {
      return { complete: false, records, error: `PR/MR 查询达到 ${limit} 条上限，禁止把截断结果用于对账` }
    }
    return { complete: true, records }
  } catch (error) {
    return { complete: false, records: [], error: `PR/MR 查询结果无效:${errorText(error)}` }
  }
}

export async function executePullRequestEffectTarget(
  input: PullRequestExecutionInput
): Promise<PullRequestEffectExecutionResult> {
  const { target } = input
  try {
    const execution = await validatePullRequestExecution(input)
    const preflightResult = await pullRequestPreflightResult(target)
    if (preflightResult) return preflightResult
    return await createPullRequest(target, execution)
  } catch (error) {
    return failure(errorText(error), target.repoRoot)
  }
}

async function validatePullRequestExecution(
  input: PullRequestExecutionInput
): Promise<ValidatedPullRequestExecution> {
  const { target } = input
  const repo = await inspectRepository(target.repoRoot)
  assertApprovedRepository(repo, target)
  const title = requiredText(input.title, 'PR 标题')
  const body = typeof input.body === 'string' ? input.body : ''
  assertApprovedPullRequestIntent(title, body, target)
  await assertApprovedSourceState(repo, target)
  return { title, body }
}

function assertApprovedRepository(repo: InspectedRepository, target: PullRequestEffectTarget): void {
  const matches =
    repo.repoRoot === target.repoRoot &&
    sameFileSystemIdentity(fileSystemIdentity(repo.repoRoot), target.repoRootIdentity) &&
    repo.remote === target.remote &&
    repo.remoteUrlDigest === target.remoteUrlDigest &&
    repo.provider === target.provider &&
    repo.host === target.host &&
    repo.projectPath === target.projectPath
  if (!matches) throw new Error('Git 仓库或 remote 身份已偏离效果审批时状态')
}

function assertApprovedPullRequestIntent(
  title: string,
  body: string,
  target: PullRequestEffectTarget
): void {
  if (stableValueDigest(title) !== target.titleDigest || stableValueDigest(body) !== target.bodyDigest) {
    throw new Error('PR 标题或正文已偏离效果审批时意图')
  }
}

async function assertApprovedSourceState(
  repo: InspectedRepository,
  target: PullRequestEffectTarget
): Promise<void> {
  const branch = await gitText(repo.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const headSha = await gitText(repo.repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (branch !== target.sourceBranch || headSha !== target.sourceSha) {
    throw new Error('PR source branch 或 HEAD 已偏离效果审批时状态')
  }
  if (await remoteBranchSha(repo, target.sourceBranch) !== target.sourceSha) {
    throw new Error('远端 source branch 已偏离效果审批时 SHA')
  }
}

async function pullRequestPreflightResult(
  target: PullRequestEffectTarget
): Promise<PullRequestEffectExecutionResult | null> {
  const observation = await queryPullRequestEffectTarget(target)
  if (!observation.complete) return failure(observation.error ?? 'PR/MR 前置查询不完整', target.repoRoot)
  const exact = exactMarkerRecords(target, observation.records)
  if (exact.length === 1) return existingPullRequestResult(target, exact[0].url)
  if (exact.length > 1 || observation.records.length > 0) {
    return failure('source branch 已存在其他或重复 PR/MR，已阻止创建', target.repoRoot)
  }
  return null
}

function existingPullRequestResult(
  target: PullRequestEffectTarget,
  url: string
): PullRequestEffectExecutionResult {
  return {
    ok: true,
    repoRoot: target.repoRoot,
    provider: target.provider,
    tool: toolForProvider(target.provider),
    branch: target.sourceBranch,
    base: target.baseBranch,
    url,
    existing: true
  }
}

async function createPullRequest(
  target: PullRequestEffectTarget,
  execution: ValidatedPullRequestExecution
): Promise<PullRequestEffectExecutionResult> {
  const tool = toolForProvider(target.provider)
  const command = createPullRequestCommand(target, execution)
  const created = await cliRun(tool, command.args, target.repoRoot, command.env, CLI_TIMEOUT_MS)
  if (!created.ok) return failure(`${tool} 创建 PR/MR 失败`, target.repoRoot, created.error)
  const url = extractUrl(created.stdout) ?? extractUrl(created.stderr)
  if (!url) return failure(`${tool} 创建完成但未返回 PR/MR URL`, target.repoRoot)
  return createdPullRequestResult(target, tool, url)
}

function createPullRequestCommand(
  target: PullRequestEffectTarget,
  execution: ValidatedPullRequestExecution
): PullRequestCliCommand {
  const markedBody = appendMarker(execution.body, target.marker)
  if (target.provider === 'github') {
    return {
      args: [
        'pr', 'create',
        '--repo', repoSelector(target),
        '--head', target.sourceBranch,
        '--base', target.baseBranch,
        '--title', execution.title,
        '--body', markedBody
      ],
      env: { GH_PROMPT_DISABLED: '1', ...(target.host !== 'github.com' ? { GH_HOST: target.host } : {}) }
    }
  }
  return {
    args: [
      'mr', 'create',
      '--repo', `${target.host}/${target.projectPath}`,
      '--source-branch', target.sourceBranch,
      '--target-branch', target.baseBranch,
      '--title', execution.title,
      '--description', markedBody,
      '--yes'
    ],
    env: { GITLAB_HOST: target.host }
  }
}

function createdPullRequestResult(
  target: PullRequestEffectTarget,
  tool: PullRequestTool,
  url: string
): PullRequestEffectExecutionResult {
  return {
    ok: true,
    repoRoot: target.repoRoot,
    provider: target.provider,
    tool,
    branch: target.sourceBranch,
    base: target.baseBranch,
    url
  }
}

export function exactMarkerRecords(
  target: PullRequestEffectTarget,
  records: PullRequestObservationRecord[]
): PullRequestObservationRecord[] {
  return records.filter((record) =>
    record.body.includes(target.marker) &&
    record.sourceBranch === target.sourceBranch &&
    record.baseBranch === target.baseBranch
  )
}

interface InspectedRepository {
  repoRoot: string
  remote: string
  remoteUrl: string
  remoteUrlDigest: string
  provider: PullRequestProvider
  host: string
  projectPath: string
}

async function inspectRepository(cwd: string): Promise<InspectedRepository> {
  const repoRoot = realpathSync(await gitText(cwd, ['rev-parse', '--show-toplevel']))
  const remotes = (await gitText(repoRoot, ['remote']))
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (!remote) throw new Error('未配置 Git remote，无法创建 PR/MR')
  const urls = await gitLines(repoRoot, ['remote', 'get-url', '--all', remote])
  if (urls.length !== 1) throw new Error('PR/MR 自动对账只支持唯一 remote URL')
  const remoteUrl = urls[0]
  const parsed = parseRemoteUrl(remoteUrl)
  if (!parsed.provider || !parsed.host || !parsed.projectPath) {
    throw new Error('当前 remote 不是受支持的 GitHub/GitLab 仓库')
  }
  const tool = toolForProvider(parsed.provider)
  if (!commandExists(tool)) throw new Error(`已识别 ${parsed.provider} remote，但本机未检测到 ${tool}`)
  return {
    repoRoot,
    remote,
    remoteUrl,
    remoteUrlDigest: stableValueDigest(sanitizeRemoteUrl(remoteUrl)),
    provider: parsed.provider,
    host: parsed.host,
    projectPath: parsed.projectPath
  }
}

async function defaultBaseBranch(repo: InspectedRepository): Promise<string> {
  const symbolic = await gitRun(
    repo.repoRoot,
    ['symbolic-ref', '--quiet', '--short', `refs/remotes/${repo.remote}/HEAD`],
    [0, 1]
  )
  if (symbolic.status === 0) {
    const value = symbolic.stdout.trim()
    const prefix = `${repo.remote}/`
    if (value.startsWith(prefix) && value.length > prefix.length) return value.slice(prefix.length)
  }
  for (const candidate of ['main', 'master', 'develop']) {
    if (await remoteBranchSha(repo, candidate)) return candidate
  }
  throw new Error('无法确定 PR/MR base branch，请显式提供 base')
}

async function remoteBranchSha(repo: InspectedRepository, branch: string): Promise<string | undefined> {
  const url = normalizeRemoteProbeUrl(repo.repoRoot, repo.remoteUrl)
  const ref = `refs/heads/${branch}`
  const result = await remoteGitRun(['ls-remote', '--heads', url, ref], [0, 2])
  if (!result.ok && result.status !== 2) throw new Error(result.error)
  for (const line of result.stdout.split(/\r?\n/)) {
    const [sha, observedRef] = line.trim().split(/\s+/)
    if (sha && observedRef === ref) return sha
  }
  return undefined
}

function parseRemoteUrl(value: string): {
  provider?: PullRequestProvider
  host?: string
  projectPath?: string
} {
  const trimmed = value.trim()
  let host = ''
  let rawPath = ''
  try {
    const url = new URL(trimmed)
    host = url.hostname.toLowerCase()
    rawPath = url.pathname
  } catch {
    const scp = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(trimmed)
    if (!scp) return {}
    host = scp[1].toLowerCase()
    rawPath = scp[2]
  }
  const projectPath = rawPath.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!host || !projectPath || !projectPath.includes('/')) return {}
  if (host === 'github.com' || host.endsWith('.github.com')) {
    return { provider: 'github', host, projectPath }
  }
  if (host === 'gitlab.com' || host.includes('gitlab')) {
    return { provider: 'gitlab', host, projectPath }
  }
  return {}
}

function parseObservationRecord(provider: PullRequestProvider, value: unknown): PullRequestObservationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PR/MR 记录必须是对象')
  const record = value as Record<string, unknown>
  if (provider === 'github') {
    return {
      id: requiredScalar(record.number, 'number'),
      url: requiredText(record.url, 'url'),
      state: requiredText(record.state, 'state'),
      sourceBranch: requiredText(record.headRefName, 'headRefName'),
      baseBranch: requiredText(record.baseRefName, 'baseRefName'),
      headSha: optionalText(record.headRefOid),
      body: typeof record.body === 'string' ? record.body : ''
    }
  }
  return {
    id: requiredScalar(record.iid, 'iid'),
    url: requiredText(record.web_url, 'web_url'),
    state: requiredText(record.state, 'state'),
    sourceBranch: requiredText(record.source_branch, 'source_branch'),
    baseBranch: requiredText(record.target_branch, 'target_branch'),
    headSha: optionalText(record.sha),
    body: typeof record.description === 'string' ? record.description : ''
  }
}

function repoSelector(target: PullRequestEffectTarget): string {
  return target.host === 'github.com' ? target.projectPath : `${target.host}/${target.projectPath}`
}

function appendMarker(body: string, marker: string): string {
  if (body.includes(marker)) return body
  return body ? `${body.replace(/\s+$/, '')}\n\n${marker}` : marker
}

function toolForProvider(provider: PullRequestProvider): PullRequestTool {
  return provider === 'github' ? 'gh' : 'glab'
}

function commandExists(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(probe, [command], { stdio: 'ignore', timeout: LOCAL_TIMEOUT_MS })
  return result.status === 0
}

function preferredRemoteSync(repoRoot: string): string | null {
  const names = syncGitText(repoRoot, ['remote'])
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
  return names.includes('origin') ? 'origin' : names[0] ?? null
}

function syncGitText(cwd: string, args: string[]): string {
  const result = spawnSync('git', withSafeLocalGitConfig(['-C', cwd, ...args]), {
    encoding: 'utf8',
    timeout: LOCAL_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: isolatedLocalGitEnv(process.env)
  })
  if (result.error || result.status !== 0) {
    throw new Error(redactError(String(result.stderr || result.error?.message || `git ${args[0]} failed`)))
  }
  const output = String(result.stdout ?? '').trim()
  if (!output) throw new Error(`git ${args[0]} 未返回结果`)
  return output
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const result = await gitRun(cwd, args)
  if (!result.ok) throw new Error(result.error)
  const output = result.stdout.trim()
  if (!output) throw new Error(`git ${args[0]} 未返回结果`)
  return output
}

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const result = await gitRun(cwd, args)
  if (!result.ok) throw new Error(result.error)
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

interface CommandResult {
  ok: boolean
  status: number | null
  stdout: string
  stderr: string
  error: string
}

function gitRun(
  cwd: string,
  args: string[],
  allowedStatuses: number[] = [0]
): Promise<CommandResult> {
  return commandRun(
    'git',
    withSafeLocalGitConfig(['-C', cwd, ...args]),
    undefined,
    isolatedLocalGitEnv(process.env),
    LOCAL_TIMEOUT_MS,
    allowedStatuses
  )
}

function remoteGitRun(args: string[], allowedStatuses: number[]): Promise<CommandResult> {
  const isolatedCwd = mkdtempSync(join(tmpdir(), 'caogen-pr-probe-'))
  const env = isolatedRemoteGitEnv(process.env)
  env.GIT_CEILING_DIRECTORIES = isolatedCwd
  env.GIT_DISCOVERY_ACROSS_FILESYSTEM = '0'
  return commandRun(
    'git',
    withSafeRemoteGitConfig(args),
    isolatedCwd,
    env,
    REMOTE_TIMEOUT_MS,
    allowedStatuses
  ).finally(() => rmSync(isolatedCwd, { recursive: true, force: true }))
}

function cliRun(
  command: PullRequestTool,
  args: string[],
  cwd: string,
  envPatch: Record<string, string>,
  timeoutMs = REMOTE_TIMEOUT_MS
): Promise<CommandResult> {
  return commandRun(command, args, cwd, { ...process.env, ...envPatch }, timeoutMs, [0])
}

function commandRun(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  allowedStatuses: number[]
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_OUTPUT,
      windowsHide: true
    }, (error, stdoutValue, stderrValue) => {
      const failure = error as (Error & { code?: string | number; killed?: boolean }) | null
      const stdout = String(stdoutValue ?? '')
      const stderr = String(stderrValue ?? '')
      const status = failure ? (typeof failure.code === 'number' ? failure.code : null) : 0
      const timedOut = failure?.code === 'ETIMEDOUT' || failure?.killed === true
      const ok = status !== null && allowedStatuses.includes(status)
      resolveResult({
        ok,
        status,
        stdout,
        stderr,
        error: timedOut
          ? `${command} timed out after ${timeoutMs}ms`
          : redactError(stderr.trim() || failure?.message || stdout.trim() || `${command} failed`)
      })
    })
  })
}

function normalizeRemoteProbeUrl(repoRoot: string, value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Git remote URL 为空')
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(trimmed)) throw new Error('Git remote helper 协议不允许自动对账')
  try {
    const url = new URL(trimmed)
    if (!new Set(['file:', 'git:', 'http:', 'https:', 'ssh:']).has(url.protocol)) {
      throw new Error(`Git remote URL 协议 ${url.protocol} 不允许自动对账`)
    }
    return trimmed
  } catch (error) {
    if (error instanceof Error && error.message.includes('不允许自动对账')) throw error
  }
  if (/^(?:[^@\s/:]+@)?[^:\s/]+:.+$/.test(trimmed)) return trimmed
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) throw new Error('Git remote URL 使用未知协议')
  return resolve(repoRoot, trimmed)
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

function redactError(value: string): string {
  return value
    .replace(/\b(?:https?|ssh|git|file):\/\/[^\s'"<>]+/gi, (match) => sanitizeRemoteUrl(match))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b[^\s'"<>@]+@([A-Za-z0-9.-]+(?::[^\s'"<>]+)?)/g, '$1')
}

function fileSystemIdentity(path: string): FileSystemIdentity {
  const stats = statSync(path, { bigint: true })
  return { device: stats.dev.toString(), inode: stats.ino.toString() }
}

function sameFileSystemIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

async function assertBranchName(repoRoot: string, value: string, label: string): Promise<void> {
  const result = await gitRun(repoRoot, ['check-ref-format', '--branch', value], [0, 1])
  if (!result.ok || result.status !== 0) throw new Error(`${label} 无效:${value}`)
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.includes('\0')) throw new Error(`${label} 不能为空或包含非法字符`)
  return text
}

function requiredScalar(value: unknown, label: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw new Error(`${label} 缺失`)
  }
  return String(value)
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function extractUrl(value: string): string | null {
  const match = /https?:\/\/\S+/i.exec(value)
  return match ? match[0].replace(/[),.;]+$/, '') : null
}

function failure(error: string, repoRoot?: string, details?: string): PullRequestEffectExecutionResult {
  return { ok: false, error, ...(repoRoot ? { repoRoot } : {}), ...(details ? { details: redactError(details) } : {}) }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
