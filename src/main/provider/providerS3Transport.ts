import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig
} from '@aws-sdk/client-s3'
import {
  MAX_PROVIDER_SYNC_BYTES,
  parseProviderProfileSyncEnvelope,
  providerProfileSyncTextDigest,
  serializeProviderProfileSyncEnvelope,
  type SyncEnvelope
} from './providerProfileSync'

const PROTOCOL_PREFIX = 'provider-profile/v1'
const CURRENT_FILE = 'current.json'
const HISTORY_PREFIX = 'history'
const REQUEST_TIMEOUT_MS = 30_000

export interface ProviderS3TransportConfig {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  forcePathStyle: boolean
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}

export interface ProviderS3RemoteSnapshot {
  envelope: SyncEnvelope
  raw: string
  fileDigest: string
  etag?: string
}

export async function testProviderS3Transport(config: ProviderS3TransportConfig): Promise<void> {
  const context = transportContext(config)
  try {
    await context.client.send(new HeadObjectCommand({ Bucket: context.bucket, Key: currentKey(context) }))
  } catch (error) {
    if (!isNotFound(error)) throw s3Error('test connection', error)
  } finally {
    context.client.destroy()
  }
}

export async function readProviderS3Remote(
  config: ProviderS3TransportConfig
): Promise<ProviderS3RemoteSnapshot | undefined> {
  const context = transportContext(config)
  try {
    return await readRemoteWithContext(context, currentKey(context))
  } finally {
    context.client.destroy()
  }
}

export async function listProviderS3History(config: ProviderS3TransportConfig): Promise<ProviderS3RemoteSnapshot[]> {
  const context = transportContext(config)
  try {
    const prefix = historyKeyPrefix(context)
    let response
    try {
      response = await context.client.send(new ListObjectsV2Command({
        Bucket: context.bucket,
        Prefix: prefix,
        MaxKeys: 50
      }))
    } catch (error) {
      throw s3Error('list history', error)
    }
    const keys = (response.Contents ?? [])
      .filter((item): item is typeof item & { Key: string } => Boolean(item.Key?.startsWith(prefix) && item.Key.endsWith('.json')))
      .sort((left, right) => Number(right.LastModified ?? 0) - Number(left.LastModified ?? 0))
      .slice(0, 20)
      .map((item) => item.Key)
    const history: ProviderS3RemoteSnapshot[] = []
    for (const key of keys) {
      const snapshot = await readRemoteWithContext(context, key)
      if (snapshot) history.push(snapshot)
    }
    return history.sort((left, right) => right.envelope.createdAt.localeCompare(left.envelope.createdAt))
  } finally {
    context.client.destroy()
  }
}

export async function readProviderS3History(
  config: ProviderS3TransportConfig,
  revisionId: string
): Promise<ProviderS3RemoteSnapshot | undefined> {
  const context = transportContext(config)
  try {
    return await readRemoteWithContext(context, `${historyKeyPrefix(context)}${safeRevisionId(revisionId)}.json`)
  } finally {
    context.client.destroy()
  }
}

export async function publishProviderS3Remote(
  config: ProviderS3TransportConfig,
  envelope: SyncEnvelope,
  expected: ProviderS3RemoteSnapshot | undefined
): Promise<ProviderS3RemoteSnapshot> {
  const context = transportContext(config)
  try {
    const raw = serializeProviderProfileSyncEnvelope(envelope)
    await putImmutableHistory(context, envelope.revisionId, raw)
    if (expected && !expected.etag) {
      throw new Error('S3 did not provide an ETag; refusing to overwrite remote configuration')
    }
    try {
      await context.client.send(new PutObjectCommand({
        Bucket: context.bucket,
        Key: currentKey(context),
        Body: raw,
        ContentType: 'application/json; charset=utf-8',
        ...(expected ? { IfMatch: expected.etag } : { IfNoneMatch: '*' })
      }))
    } catch (error) {
      if (isPreconditionFailed(error)) throw new Error('S3 remote configuration changed after preview')
      throw s3Error('publish', error)
    }
    const verified = await readRemoteWithContext(context, currentKey(context))
    if (!verified || verified.envelope.revisionId !== envelope.revisionId
      || verified.envelope.payloadDigest !== envelope.payloadDigest) {
      throw new Error('S3 publish verification failed')
    }
    return verified
  } finally {
    context.client.destroy()
  }
}

export function normalizeProviderS3Config(input: ProviderS3TransportConfig): ProviderS3TransportConfig {
  const endpoint = normalizeEndpoint(input.endpoint)
  const region = boundedText(input.region || 'us-east-1', 128, 'S3 region')
  const bucket = boundedText(input.bucket, 255, 'S3 bucket')
  if (/[\s/\\\0-\x1f\x7f]/.test(bucket)) throw new Error('S3 bucket is invalid')
  const accessKeyId = boundedText(input.accessKeyId, 512, 'S3 Access Key ID')
  const secretAccessKey = boundedText(input.secretAccessKey, 8_192, 'S3 Secret Access Key')
  const sessionToken = boundedText(input.sessionToken, 16_384, 'S3 session token', true)
  return {
    endpoint,
    region,
    bucket,
    prefix: normalizePrefix(input.prefix),
    forcePathStyle: Boolean(input.forcePathStyle),
    accessKeyId,
    secretAccessKey,
    sessionToken
  }
}

export function providerS3EndpointLabel(config: Pick<ProviderS3TransportConfig, 'endpoint' | 'bucket' | 'region'>): string {
  if (config.endpoint) {
    const url = new URL(normalizeEndpoint(config.endpoint))
    return `${config.bucket} @ ${url.port ? `${url.hostname}:${url.port}` : url.hostname}`
  }
  return `${config.bucket} @ ${boundedText(config.region, 128, 'S3 region')}`
}

interface TransportContext {
  client: S3Client
  bucket: string
  objectPrefix: string
}

function transportContext(config: ProviderS3TransportConfig): TransportContext {
  const normalized = normalizeProviderS3Config(config)
  const clientConfig: S3ClientConfig = {
    region: normalized.region,
    forcePathStyle: normalized.forcePathStyle,
    requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS, connectionTimeout: REQUEST_TIMEOUT_MS },
    credentials: {
      accessKeyId: normalized.accessKeyId,
      secretAccessKey: normalized.secretAccessKey,
      ...(normalized.sessionToken ? { sessionToken: normalized.sessionToken } : {})
    },
    ...(normalized.endpoint ? { endpoint: normalized.endpoint } : {})
  }
  return {
    client: new S3Client(clientConfig),
    bucket: normalized.bucket,
    objectPrefix: [normalized.prefix, PROTOCOL_PREFIX].filter(Boolean).join('/')
  }
}

async function putImmutableHistory(context: TransportContext, revisionId: string, raw: string): Promise<void> {
  const key = `${context.objectPrefix}/${HISTORY_PREFIX}/${safeRevisionId(revisionId)}.json`
  try {
    await context.client.send(new PutObjectCommand({
      Bucket: context.bucket,
      Key: key,
      Body: raw,
      ContentType: 'application/json; charset=utf-8',
      IfNoneMatch: '*'
    }))
    return
  } catch (error) {
    if (!isPreconditionFailed(error)) throw s3Error('publish history', error)
  }
  const existing = await readRemoteWithContext(context, key)
  if (!existing || existing.fileDigest !== providerProfileSyncTextDigest(raw)) {
    throw new Error('S3 history revision already exists with different content')
  }
}

async function readRemoteWithContext(
  context: TransportContext,
  key: string
): Promise<ProviderS3RemoteSnapshot | undefined> {
  let response
  try {
    response = await context.client.send(new GetObjectCommand({ Bucket: context.bucket, Key: key }))
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw s3Error('read', error)
  }
  if (response.ContentLength !== undefined && response.ContentLength > MAX_PROVIDER_SYNC_BYTES) {
    throw new Error('S3 Provider sync response exceeds 4 MB')
  }
  if (!response.Body) throw new Error('S3 Provider sync response has no body')
  const bytes = await response.Body.transformToByteArray()
  if (bytes.byteLength > MAX_PROVIDER_SYNC_BYTES) throw new Error('S3 Provider sync response exceeds 4 MB')
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return {
    envelope: parseProviderProfileSyncEnvelope(raw),
    raw,
    fileDigest: providerProfileSyncTextDigest(raw),
    etag: normalizedEtag(response.ETag)
  }
}

function currentKey(context: TransportContext): string {
  return `${context.objectPrefix}/${CURRENT_FILE}`
}

function historyKeyPrefix(context: TransportContext): string {
  return `${context.objectPrefix}/${HISTORY_PREFIX}/`
}

function normalizeEndpoint(value: string): string {
  const raw = boundedText(value, 2_048, 'S3 endpoint', true).trim()
  if (!raw) return ''
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('S3 endpoint is invalid') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('S3 endpoint must use HTTP(S) without credentials, query, or fragment')
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new Error('Public S3 endpoints must use HTTPS')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString()
}

function normalizePrefix(value: string): string {
  const raw = boundedText(value || 'caogen-sync', 512, 'S3 prefix')
  const segments = raw.replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.length === 0 || segments.length > 12
    || segments.some((segment) => segment === '.' || segment === '..' || /[\0-\x1f\x7f]/.test(segment))) {
    throw new Error('S3 prefix is invalid')
  }
  return segments.join('/')
}

function boundedText(value: string, maxLength: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid`)
  const normalized = allowEmpty ? value : value.trim()
  if (!allowEmpty && !normalized) throw new Error(`${label} is required`)
  return normalized
}

function safeRevisionId(value: string): string {
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(value)) throw new Error('Provider sync revision is invalid')
  return value
}

function normalizedEtag(value: string | undefined): string | undefined {
  if (!value || value.length > 512 || /[\0\r\n]/.test(value)) return undefined
  return value
}

function isLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value)
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return candidate?.name === 'NotFound' || candidate?.name === 'NoSuchKey' || candidate?.$metadata?.httpStatusCode === 404
}

function isPreconditionFailed(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return candidate?.name === 'PreconditionFailed' || candidate?.$metadata?.httpStatusCode === 412
}

function s3Error(operation: string, error: unknown): Error {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  const status = candidate?.$metadata?.httpStatusCode
  if (status === 401 || status === 403 || candidate?.name === 'InvalidAccessKeyId' || candidate?.name === 'SignatureDoesNotMatch') {
    return new Error('S3 authentication or object permission failed')
  }
  return new Error(`S3 ${operation} failed${status ? ` with HTTP ${status}` : ''}`)
}
