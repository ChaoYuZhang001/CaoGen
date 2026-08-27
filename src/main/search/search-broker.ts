import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/** The two search implementations that are part of the 1.0 contract. */
export type SearchBrokerMode = 'model_native' | 'byok_search_adapter'

/** A failed search is never represented as a successful, source-backed answer. */
export type SearchBrokerFailureState =
  | 'no_results'
  | 'timeout'
  | 'no_credentials'
  | 'egress_denied'
  | 'provider_failure'
  | 'unknown_result'

export interface SearchBrokerRequest {
  query: string
  mode: SearchBrokerMode
  /** An explicit operation identity enables replay after a process restart. */
  operationId?: string
  /** Alias accepted by callers that use request rather than operation terminology. */
  requestId?: string
  /** Assistant first-task calls may omit both fields. */
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
  limit?: number
  signal?: AbortSignal
}

export interface SearchProviderRequest {
  query: string
  mode: SearchBrokerMode
  operationId: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  limit: number
  signal?: AbortSignal
}

/**
 * The Broker never treats a URL or summary returned by a model as evidence by
 * itself. Each candidate is fetched again through the Broker's bounded URL
 * policy before it becomes a citation.
 */
export interface SearchProviderCandidate {
  url: string
  title?: string
  /** Provider snippets are advisory only and are not used as citation content. */
  summary?: string
}

export interface SearchProviderResponse {
  status?: 'success' | SearchBrokerFailureState
  results?: readonly SearchProviderCandidate[]
  message?: string
}

export interface SearchProviderAdapter {
  /** A missing or unavailable BYOK adapter yields `no_credentials`. */
  available?: boolean | (() => boolean | Promise<boolean>)
  search(input: SearchProviderRequest): Promise<SearchProviderResponse>
}

export interface SearchBrokerCitation {
  url: string
  fetchedAt: number
  summary: string
  /** Bare lowercase SHA-256 of the bytes fetched from `url`. */
  contentSha256: string
  /** Stable human-readable citation derived from the fetched URL and digest. */
  citation: string
  /** Null is explicit for the Assistant first-task/no-Project path. */
  projectId: string | null
  goalId: string | null
  workItemId: string | null
  runId: string | null
  evidenceId: string
}

export interface SearchBrokerEvidenceRecord {
  evidenceId: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
  kind: 'research_source'
  title: string
  summary: string
  uri: string
  mediaType: string
  verifier: 'caogen-search-broker'
  observedAt: number
  contentDigest: string
  metadata: {
    mode: SearchBrokerMode
    fetchedAt: number
    contentSha256: string
    citation: string
  }
}

export interface SearchBrokerIdempotencyStore {
  get(operationId: string): Promise<SearchBrokerResult | undefined> | SearchBrokerResult | undefined
  put(operationId: string, result: SearchBrokerResult): Promise<void> | void
}

export interface SearchBrokerOptions {
  modelNative?: SearchProviderAdapter
  byokSearchAdapter?: SearchProviderAdapter
  fetchImpl?: typeof fetch
  /** Injected wall clock for deterministic tests and replay audits. */
  now?: () => number
  clock?: { now(): number }
  /** Injected stable IDs; default IDs are content-addressed and replay-safe. */
  idFactory?: (kind: 'operation' | 'evidence', input: string) => string
  /** Tests and local policy callers may supply a DNS/public-address checker. */
  publicEndpointChecker?: (url: URL) => Promise<void> | void
  /**
   * Optional canonical Evidence batch writer. It runs only after every source
   * candidate has been fetched and verified, so callers can commit the batch
   * transactionally without exposing Evidence for a failed search.
   */
  evidenceWriter?: (records: readonly SearchBrokerEvidenceRecord[]) => Promise<void> | void
  /** An injected store is the only persistence mechanism used by this module. */
  idempotencyStore?: SearchBrokerIdempotencyStore
  timeoutMs?: number
  maxResponseBytes?: number
}

export interface SearchBrokerSuccess {
  ok: true
  status: 'success'
  mode: SearchBrokerMode
  operationId: string
  projectId: string | null
  goalId: string | null
  workItemId: string | null
  runId: string | null
  artifactId?: string
  /** Every item has the complete SEARCH-001 evidence field set. */
  results: readonly SearchBrokerCitation[]
  citations: readonly SearchBrokerCitation[]
  /** Convenience aliases for the first result used by simple Assistant views. */
  url: string
  fetchedAt: number
  summary: string
  contentSha256: string
  citation: string
  evidenceId: string
  idempotentReplay: boolean
}

export interface SearchBrokerFailure {
  ok: false
  status: SearchBrokerFailureState
  mode: SearchBrokerMode
  operationId: string
  projectId: string | null
  goalId: string | null
  workItemId: string | null
  runId: string | null
  artifactId?: string
  results: readonly []
  citations: readonly []
  message: string
  idempotentReplay: boolean
}

export type SearchBrokerResult = SearchBrokerSuccess | SearchBrokerFailure

interface FetchMaterial {
  bytes: Uint8Array
  text: string
}

interface SearchBrokerDependencies {
  fetchImpl: typeof fetch
  now: () => number
  idFactory: (kind: 'operation' | 'evidence', input: string) => string
  publicEndpointChecker: (url: URL) => Promise<void>
  timeoutMs: number
  maxResponseBytes: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const MAX_QUERY_CHARS = 512
const MAX_SUMMARY_CHARS = 320

/**
 * CaoGen-owned, provider-neutral web-search boundary. It deliberately does
 * not import Project/session stores: callers bind the returned evidence to
 * their canonical ledger through `evidenceWriter` when that context exists.
 */
export class SearchBroker {
  private readonly options: SearchBrokerOptions
  private readonly dependencies: SearchBrokerDependencies
  private readonly ephemeralStore = new Map<string, SearchBrokerResult>()

  constructor(options: SearchBrokerOptions = {}) {
    this.options = options
    this.dependencies = {
      fetchImpl: options.fetchImpl ?? fetch,
      now: options.clock?.now.bind(options.clock) ?? options.now ?? Date.now,
      idFactory: options.idFactory ?? defaultIdFactory,
      publicEndpointChecker: async (url: URL): Promise<void> => {
        if (options.publicEndpointChecker) {
          await options.publicEndpointChecker(url)
          return
        }
        await assertPublicEndpoint(url)
      },
      timeoutMs: finitePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS),
      maxResponseBytes: finitePositive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES)
    }
  }

  async search(input: SearchBrokerRequest): Promise<SearchBrokerResult> {
    const mode = input.mode
    const query = normalizeQuery(input.query)
    const projectId = optionalText(input.projectId)
    const goalId = optionalText(input.goalId)
    const workItemId = optionalText(input.workItemId)
    const runId = optionalText(input.runId)
    const artifactId = optionalText(input.artifactId)
    const limit = normalizeLimit(input.limit)
    const operationId = this.operationId(input, query, mode, projectId, runId)
    const store = this.options.idempotencyStore
    const replay = store
      ? await store.get(operationId)
      : this.ephemeralStore.get(operationId)
    if (replay) return withReplayFlag(replay)

    const result = await this.executeSearch({
      query,
      mode,
      operationId,
      projectId,
      goalId,
      workItemId,
      runId,
      artifactId,
      limit,
      signal: input.signal
    })
    if (store) await store.put(operationId, result)
    else this.ephemeralStore.set(operationId, result)
    return result
  }

  /** Alias for orchestration callers that use execute terminology. */
  execute(input: SearchBrokerRequest): Promise<SearchBrokerResult> {
    return this.search(input)
  }

  private async executeSearch(input: SearchProviderRequest & { artifactId?: string }): Promise<SearchBrokerResult> {
    if (!input.query) {
      return failure('unknown_result', input, 'Search query is empty; no source-backed result was produced.')
    }
    if (input.signal?.aborted) {
      return failure('timeout', input, 'Search timed out before it started.')
    }

    const adapter = input.mode === 'model_native' ? this.options.modelNative : this.options.byokSearchAdapter
    if (!adapter) {
      return failure(
        input.mode === 'byok_search_adapter' ? 'no_credentials' : 'provider_failure',
        input,
        input.mode === 'byok_search_adapter'
          ? 'No BYOK search credentials are configured.'
          : 'The model-native search provider is unavailable.'
      )
    }
    if (input.mode === 'byok_search_adapter' && !(await adapterAvailable(adapter))) {
      return failure('no_credentials', input, 'No BYOK search credentials are configured.')
    }

    let response: SearchProviderResponse
    try {
      response = await withTimeout(
        adapter.search(input),
        this.dependencies.timeoutMs,
        input.signal
      )
    } catch (error) {
      return failure(classifyError(error), input, failureMessage(classifyError(error)))
    }
    if (!response || typeof response !== 'object') {
      return failure('unknown_result', input, 'The search provider returned an unknown result.')
    }
    const providerState = response.status
    if (providerState && providerState !== 'success') {
      return failure(providerState, input, response.message ?? failureMessage(providerState))
    }
    if (!response || !Array.isArray(response.results)) {
      return failure('unknown_result', input, 'The search provider returned an unknown result.')
    }
    if (response.results.length === 0) {
      return failure('no_results', input, 'The search provider returned no results.')
    }

    const citations: SearchBrokerCitation[] = []
    const evidenceRecords: SearchBrokerEvidenceRecord[] = []
    for (const candidate of response.results.slice(0, input.limit)) {
      if (!candidate || typeof candidate.url !== 'string' || !candidate.url.trim()) {
        return failure('unknown_result', input, 'The search provider returned an unverified result.')
      }
      let url: URL
      try {
        url = publicHttpsUrl(candidate.url)
        await this.dependencies.publicEndpointChecker(url)
      } catch {
        return failure('egress_denied', input, 'The search result URL is not an allowed public HTTPS endpoint.')
      }

      let material: FetchMaterial
      try {
        material = await this.fetchMaterial(url, input.signal)
      } catch (error) {
        const state = classifyError(error)
        return failure(state, input, failureMessage(state))
      }
      const fetchedAt = this.dependencies.now()
      const contentSha256 = createHash('sha256').update(material.bytes).digest('hex')
      const summary = materialSummary(material.text)
      if (!summary) {
        return failure('unknown_result', input, 'The fetched search source was empty or undecodable.')
      }
      const evidenceId = this.dependencies.idFactory(
        'evidence',
        `${input.operationId}\0${url.toString()}\0${contentSha256}`
      )
      const citation = `[${url.toString()}] (sha256:${contentSha256})`
      const item: SearchBrokerCitation = {
        url: url.toString(),
        fetchedAt,
        summary,
        contentSha256,
        citation,
        projectId: input.projectId ?? null,
        goalId: input.goalId ?? null,
        workItemId: input.workItemId ?? null,
        runId: input.runId ?? null,
        evidenceId
      }
      evidenceRecords.push({
        evidenceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.goalId ? { goalId: input.goalId } : {}),
        ...(input.workItemId ? { workItemId: input.workItemId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
        kind: 'research_source',
        title: `Web search source: ${url.hostname}`,
        summary,
        uri: item.url,
        mediaType: 'text/plain',
        verifier: 'caogen-search-broker',
        observedAt: fetchedAt,
        // Workflow Evidence stores the canonical digest as bare lowercase SHA-256;
        // the human-facing citation retains the `sha256:` label.
        contentDigest: contentSha256,
        metadata: {
          mode: input.mode,
          fetchedAt,
          contentSha256,
          citation
        }
      })
      citations.push(item)
    }

    const first = citations[0]
    if (!first) return failure('no_results', input, 'The search provider returned no results.')
    if (this.options.evidenceWriter) {
      try {
        await this.options.evidenceWriter(evidenceRecords)
      } catch {
        return failure('provider_failure', input, 'Search evidence could not be recorded.')
      }
    }
    return {
      ok: true,
      status: 'success',
      mode: input.mode,
      operationId: input.operationId,
      projectId: input.projectId ?? null,
      goalId: input.goalId ?? null,
      workItemId: input.workItemId ?? null,
      runId: input.runId ?? null,
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      results: citations,
      citations,
      url: first.url,
      fetchedAt: first.fetchedAt,
      summary: first.summary,
      contentSha256: first.contentSha256,
      citation: first.citation,
      evidenceId: first.evidenceId,
      idempotentReplay: false
    }
  }

  private operationId(
    input: SearchBrokerRequest,
    query: string,
    mode: SearchBrokerMode,
    projectId?: string,
    runId?: string
  ): string {
    const explicit = optionalText(input.operationId) ?? optionalText(input.requestId)
    if (explicit) return explicit
    return this.dependencies.idFactory(
      'operation',
      `${mode}\0${query}\0${projectId ?? ''}\0${runId ?? ''}`
    )
  }

  private async fetchMaterial(url: URL, signal?: AbortSignal): Promise<FetchMaterial> {
    const response = await withTimeout(
      this.dependencies.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal
      }),
      this.dependencies.timeoutMs,
      signal
    )
    if (response.status >= 300 && response.status < 400) {
      throw new SearchBrokerError('egress_denied', 'Search redirects are not accepted.')
    }
    if (!response.ok) {
      throw new SearchBrokerError('provider_failure', `Search source returned HTTP ${response.status}.`)
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType && !contentType.includes('text/') && !contentType.includes('json')) {
      throw new SearchBrokerError('provider_failure', 'Search source is not text or JSON.')
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength && Number(contentLength) > this.dependencies.maxResponseBytes) {
      throw new SearchBrokerError('provider_failure', 'Search source exceeds the 1 MiB limit.')
    }
    const bytes = await readBoundedResponse(response, this.dependencies.maxResponseBytes)
    return { bytes, text: Buffer.from(bytes).toString('utf8') }
  }
}

export function createSearchBroker(options: SearchBrokerOptions = {}): SearchBroker {
  return new SearchBroker(options)
}

class SearchBrokerError extends Error {
  constructor(readonly state: SearchBrokerFailureState, message: string) {
    super(message)
    this.name = 'SearchBrokerError'
  }
}

function failure(
  status: SearchBrokerFailureState,
  input: SearchProviderRequest & { artifactId?: string },
  message: string
): SearchBrokerFailure {
  return {
    ok: false,
    status,
    mode: input.mode,
    operationId: input.operationId,
    projectId: input.projectId ?? null,
    goalId: input.goalId ?? null,
    workItemId: input.workItemId ?? null,
    runId: input.runId ?? null,
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    results: [],
    citations: [],
    message,
    idempotentReplay: false
  }
}

function withReplayFlag(result: SearchBrokerResult): SearchBrokerResult {
  return { ...result, idempotentReplay: true }
}

async function adapterAvailable(adapter: SearchProviderAdapter): Promise<boolean> {
  if (typeof adapter.available === 'function') return Boolean(await adapter.available())
  return adapter.available !== false
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new SearchBrokerError('timeout', 'Search timed out.')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SearchBrokerError('timeout', 'Search timed out.')), timeoutMs)
    if (signal) {
      abort = () => reject(new SearchBrokerError('timeout', 'Search timed out.'))
      signal.addEventListener('abort', abort, { once: true })
    }
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && abort) signal.removeEventListener('abort', abort)
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new SearchBrokerError('provider_failure', 'Search source exceeds the 1 MiB limit.')
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytesRead = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytesRead += next.value.byteLength
      if (bytesRead > maxBytes) throw new SearchBrokerError('provider_failure', 'Search source exceeds the 1 MiB limit.')
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  return new Uint8Array(joined)
}

function normalizeQuery(value: string): string {
  const query = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return query.slice(0, MAX_QUERY_CHARS)
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT
  if (!Number.isFinite(value) || value < 1) return 1
  return Math.min(MAX_LIMIT, Math.floor(value))
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function materialSummary(text: string): string {
  const normalized = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.slice(0, MAX_SUMMARY_CHARS)
}

function defaultIdFactory(kind: 'operation' | 'evidence', input: string): string {
  const digest = createHash('sha256').update(input).digest('hex').slice(0, 32)
  return `search-${kind}:${digest}`
}

function classifyError(error: unknown): SearchBrokerFailureState {
  if (error instanceof SearchBrokerError) return error.state
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return 'timeout'
  return 'provider_failure'
}

function failureMessage(status: SearchBrokerFailureState): string {
  switch (status) {
    case 'no_results': return 'The search provider returned no results.'
    case 'timeout': return 'Search timed out.'
    case 'no_credentials': return 'No BYOK search credentials are configured.'
    case 'egress_denied': return 'Search egress was denied by the public HTTPS policy.'
    case 'provider_failure': return 'The search provider failed before a verified result was produced.'
    case 'unknown_result': return 'The search provider returned an unknown result.'
  }
}

function publicHttpsUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SearchBrokerError('egress_denied', 'Search URL is invalid.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new SearchBrokerError('egress_denied', 'Search URL must be credential-free HTTPS on port 443.')
  }
  for (const [name, queryValue] of url.searchParams.entries()) {
    if (/(?:api[_-]?key|auth(?:orization)?|bearer|credential|password|secret|token|signature)/i.test(name) ||
        /(?:secret|token|password|api[_-]?key)=/i.test(`${name}=${queryValue}`)) {
      throw new SearchBrokerError('egress_denied', 'Search URL cannot carry credentials in the query.')
    }
  }
  url.hash = ''
  return url
}

async function assertPublicEndpoint(url: URL): Promise<void> {
  const host = url.hostname.toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host)) {
    throw new SearchBrokerError('egress_denied', 'Search endpoint must use a public host.')
  }
  const addresses = await lookup(host, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new SearchBrokerError('egress_denied', 'Search endpoint resolved to a private address.')
  }
}

function isPrivateAddress(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (!isIP(normalized)) return false
  if (normalized.includes(':')) {
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('::ffff:127.')
  }
  const octets = normalized.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 198 && octets[1] >= 18 && octets[1] <= 19) ||
    (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
    (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
    octets[0] >= 224
}
