import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ConnectorReadResult, ConnectorSourceCitation } from '../../shared/project-workspace-types'

interface ProjectConnectorCacheRecord {
  schemaVersion: 1
  projectId: string
  resourceId: string
  citation: ConnectorSourceCitation
  authorizationDigest: string
  bytes: number
  cachedAt: number
  contentFile: string
}

export interface ProjectConnectorCachedRead extends ConnectorReadResult<string> {
  authorizationDigest: string
  cachedAt: number
  bytes: number
}

export async function writeProjectConnectorCache(
  rootDir: string,
  projectId: string,
  resourceId: string,
  read: ConnectorReadResult<string>,
  options: { authorizationDigest: string }
): Promise<ProjectConnectorCachedRead> {
  assertCitation(read.citation, projectId, resourceId)
  assertDigest(options.authorizationDigest, 'Connector authorization digest')
  const content = Buffer.from(read.data, 'utf8')
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`
  if (read.citation.contentDigest !== digest) throw new Error('Connector cache content digest does not match citation')
  const directory = cacheResourceDirectory(rootDir, projectId, resourceId)
  const contentFile = `${digest.slice(7)}.txt`
  const cachedAt = Date.now()
  const record: ProjectConnectorCacheRecord = {
    schemaVersion: 1,
    projectId,
    resourceId,
    citation: { ...read.citation },
    authorizationDigest: options.authorizationDigest,
    bytes: content.byteLength,
    cachedAt,
    contentFile
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const contentPath = join(directory, contentFile)
  await atomicWrite(contentPath, content)
  await atomicWrite(join(directory, 'current.json'), Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))
  await purgeOldContentFiles(directory, contentFile)
  return {
    data: read.data,
    citation: { ...read.citation },
    authorizationDigest: options.authorizationDigest,
    cachedAt,
    bytes: content.byteLength
  }
}

export async function readProjectConnectorCache(
  rootDir: string,
  projectId: string,
  resourceId: string
): Promise<ProjectConnectorCachedRead | undefined> {
  const directory = cacheResourceDirectory(rootDir, projectId, resourceId)
  let record: ProjectConnectorCacheRecord
  try {
    record = JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')) as ProjectConnectorCacheRecord
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Connector cache metadata is unreadable')
  }
  assertCacheRecord(record, projectId, resourceId)
  const contentPath = resolve(directory, record.contentFile)
  if (dirname(contentPath) !== directory) throw new Error('Connector cache content path escapes its Resource boundary')
  const content = await readFile(contentPath)
  if (content.byteLength !== record.bytes) throw new Error('Connector cache byte count does not match metadata')
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`
  if (digest !== record.citation.contentDigest) throw new Error('Connector cache content digest is invalid')
  return {
    data: content.toString('utf8'),
    citation: { ...record.citation },
    authorizationDigest: record.authorizationDigest,
    cachedAt: record.cachedAt,
    bytes: record.bytes
  }
}

export async function purgeProjectConnectorCache(
  rootDir: string,
  projectId: string,
  resourceId: string
): Promise<void> {
  await rm(cacheResourceDirectory(rootDir, projectId, resourceId), { recursive: true, force: true })
}

export async function purgeProjectConnectorCaches(rootDir: string, projectId: string): Promise<void> {
  await rm(cacheProjectDirectory(rootDir, projectId), { recursive: true, force: true })
}

export async function countProjectConnectorCacheResiduals(rootDir: string, projectId: string): Promise<number> {
  try {
    const info = await lstat(cacheProjectDirectory(rootDir, projectId))
    return info.isDirectory() && !info.isSymbolicLink() ? 1 : 1
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

function cacheResourceDirectory(rootDir: string, projectId: string, resourceId: string): string {
  const project = cacheProjectDirectory(rootDir, projectId)
  const resourceKey = createHash('sha256').update(requiredId(resourceId, 'resourceId')).digest('hex')
  return join(project, resourceKey)
}

function cacheProjectDirectory(rootDir: string, projectId: string): string {
  const base = resolve(rootDir, 'project-connector-cache')
  const projectKey = createHash('sha256').update(requiredId(projectId, 'projectId')).digest('hex')
  return join(base, projectKey)
}

async function atomicWrite(path: string, data: Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function purgeOldContentFiles(directory: string, retainedFile: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.txt') && entry.name !== retainedFile)
    .map((entry) => rm(join(directory, entry.name), { force: true })))
}

function assertCacheRecord(record: ProjectConnectorCacheRecord, projectId: string, resourceId: string): void {
  if (!record || record.schemaVersion !== 1 || record.projectId !== projectId || record.resourceId !== resourceId ||
      !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !Number.isFinite(record.cachedAt) ||
      !/^[a-f0-9]{64}\.txt$/.test(record.contentFile)) {
    throw new Error('Connector cache metadata is invalid')
  }
  assertDigest(record.authorizationDigest, 'Connector cache authorization digest')
  assertCitation(record.citation, projectId, resourceId)
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid`)
}

function assertCitation(citation: ConnectorSourceCitation, projectId: string, resourceId: string): void {
  if (citation.projectId !== projectId || citation.resourceId !== resourceId || !citation.source.trim() ||
      !citation.version.trim() || !Number.isFinite(citation.retrievedAt) ||
      !citation.contentDigest || !/^sha256:[a-f0-9]{64}$/.test(citation.contentDigest)) {
    throw new Error('Connector cache citation is invalid')
  }
}

function requiredId(value: string, label: string): string {
  const id = value.trim()
  if (!id || /[\0-\x1f\x7f]/.test(id)) throw new Error(`${label} is invalid`)
  return id
}
