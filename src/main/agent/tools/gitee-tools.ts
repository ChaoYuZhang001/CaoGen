export interface GiteeRepositoryRef {
  owner: string
  repo: string
}

export interface GiteePullRequestInput extends GiteeRepositoryRef {
  title: string
  head: string
  base: string
  body?: string
  draft?: boolean
}

export interface GiteeIssueInput extends GiteeRepositoryRef {
  title: string
  body?: string
  labels?: string[]
  assignee?: string
  collaborators?: string[]
}

export interface GiteeApiRequest {
  method: 'POST'
  url: string
  headers: Record<string, string>
  body: GiteeCreatePullRequestPayload | GiteeCreateIssuePayload
}

export interface GiteeSendOptions {
  accessToken?: string
  baseApiUrl?: string
  dryRun?: boolean
  timeoutMs?: number
}

export interface GiteeSendResult {
  ok: boolean
  dryRun: boolean
  sent: boolean
  request: GiteeApiRequest
  status?: number
  responseText?: string
  error?: string
}

export interface GiteeCreatePullRequestPayload {
  access_token?: string
  title: string
  head: string
  base: string
  body?: string
  draft?: boolean
}

export interface GiteeCreateIssuePayload {
  access_token?: string
  title: string
  body?: string
  labels?: string
  assignee?: string
  collaborators?: string
}

const DEFAULT_API_URL = 'https://gitee.com/api/v5'
const DEFAULT_WEB_URL = 'https://gitee.com'
const DEFAULT_TIMEOUT_MS = 10_000

export function buildGiteePullRequestUrl(input: GiteePullRequestInput, webBaseUrl = DEFAULT_WEB_URL): string {
  const repo = normalizeRepo(input)
  const url = new URL(`${trimTrailingSlash(webBaseUrl)}/${encodePath(repo.owner)}/${encodePath(repo.repo)}/pulls/new`)
  url.searchParams.set('pull_request[head]', requiredText(input.head, 'head'))
  url.searchParams.set('pull_request[base]', requiredText(input.base, 'base'))
  url.searchParams.set('pull_request[title]', requiredText(input.title, 'title'))
  if (input.body?.trim()) url.searchParams.set('pull_request[body]', input.body.trim())
  return url.toString()
}

export function buildGiteeIssueUrl(input: GiteeIssueInput, webBaseUrl = DEFAULT_WEB_URL): string {
  const repo = normalizeRepo(input)
  const url = new URL(`${trimTrailingSlash(webBaseUrl)}/${encodePath(repo.owner)}/${encodePath(repo.repo)}/issues/new`)
  url.searchParams.set('issue[title]', requiredText(input.title, 'title'))
  if (input.body?.trim()) url.searchParams.set('issue[body]', input.body.trim())
  const labels = uniqueTrimmed(input.labels)
  if (labels.length > 0) url.searchParams.set('issue[labels]', labels.join(','))
  return url.toString()
}

export function buildGiteeCreatePullRequestPayload(
  input: GiteePullRequestInput,
  accessToken?: string
): GiteeCreatePullRequestPayload {
  const payload: GiteeCreatePullRequestPayload = {
    title: requiredText(input.title, 'title'),
    head: requiredText(input.head, 'head'),
    base: requiredText(input.base, 'base')
  }
  if (input.body?.trim()) payload.body = input.body.trim()
  if (input.draft === true) payload.draft = true
  if (accessToken?.trim()) payload.access_token = accessToken.trim()
  return payload
}

export function buildGiteeCreateIssuePayload(input: GiteeIssueInput, accessToken?: string): GiteeCreateIssuePayload {
  const payload: GiteeCreateIssuePayload = {
    title: requiredText(input.title, 'title')
  }
  if (input.body?.trim()) payload.body = input.body.trim()
  const labels = uniqueTrimmed(input.labels)
  const collaborators = uniqueTrimmed(input.collaborators)
  if (labels.length > 0) payload.labels = labels.join(',')
  if (input.assignee?.trim()) payload.assignee = input.assignee.trim()
  if (collaborators.length > 0) payload.collaborators = collaborators.join(',')
  if (accessToken?.trim()) payload.access_token = accessToken.trim()
  return payload
}

export function buildGiteePullRequestApiRequest(input: GiteePullRequestInput, options: GiteeSendOptions = {}): GiteeApiRequest {
  const repo = normalizeRepo(input)
  return {
    method: 'POST',
    url: `${trimTrailingSlash(options.baseApiUrl ?? DEFAULT_API_URL)}/repos/${encodePath(repo.owner)}/${encodePath(repo.repo)}/pulls`,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: buildGiteeCreatePullRequestPayload(input, options.accessToken)
  }
}

export function buildGiteeIssueApiRequest(input: GiteeIssueInput, options: GiteeSendOptions = {}): GiteeApiRequest {
  const repo = normalizeRepo(input)
  return {
    method: 'POST',
    url: `${trimTrailingSlash(options.baseApiUrl ?? DEFAULT_API_URL)}/repos/${encodePath(repo.owner)}/${encodePath(repo.repo)}/issues`,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: buildGiteeCreateIssuePayload(input, options.accessToken)
  }
}

export async function sendGiteePullRequest(input: GiteePullRequestInput, options: GiteeSendOptions = {}): Promise<GiteeSendResult> {
  return sendGiteeApiRequest(buildGiteePullRequestApiRequest(input, options), options)
}

export async function sendGiteeIssue(input: GiteeIssueInput, options: GiteeSendOptions = {}): Promise<GiteeSendResult> {
  return sendGiteeApiRequest(buildGiteeIssueApiRequest(input, options), options)
}

async function sendGiteeApiRequest(request: GiteeApiRequest, options: GiteeSendOptions): Promise<GiteeSendResult> {
  const dryRun = options.dryRun !== false || !options.accessToken?.trim()

  // 默认 dry-run：没有显式 token 或 dryRun:false 时只返回请求结构。
  if (dryRun) return { ok: true, dryRun: true, sent: false, request }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal
    })
    const responseText = await response.text()
    return { ok: response.ok, dryRun: false, sent: true, request, status: response.status, responseText }
  } catch (error) {
    return { ok: false, dryRun: false, sent: false, request, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

function normalizeRepo(input: GiteeRepositoryRef): GiteeRepositoryRef {
  return {
    owner: requiredText(input.owner, 'owner'),
    repo: requiredText(input.repo, 'repo').replace(/\.git$/i, '')
  }
}

function uniqueTrimmed(values?: string[]): string[] {
  return [...new Set(values?.map((item) => item.trim()).filter(Boolean) ?? [])]
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function encodePath(value: string): string {
  return encodeURIComponent(value)
}

function requiredText(value: string, name: string): string {
  const text = value.trim()
  if (!text) throw new Error(`${name} 不能为空`)
  return text
}
