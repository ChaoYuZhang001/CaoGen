import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface ProjectMemoryEntry {
  id: string
  kind: string
  title: string
  body: string
  source: string
  reason: string
  createdAt: string
  updatedAt: string
}

export interface ProjectMemoryDraft extends ProjectMemoryEntry {
  status: 'draft'
}

export interface ProjectMemoryDraftInput {
  kind: string
  title: string
  body: string
  source: string
  reason: string
}

export interface ReadProjectMemoryResult {
  projectHash: string
  markdown: string
  entries: ProjectMemoryEntry[]
  drafts: ProjectMemoryDraft[]
}

export interface DeleteMemoryEntryResult {
  id: string
  deleted: boolean
  deletedFrom: Array<'confirmed' | 'drafts'>
}

type MemoryBucket = 'confirmed' | 'drafts'

const HASH_NAMESPACE = 'agent-desk-project-memory-v1'
const JSON_INDENT = 2

export function projectHash(projectRoot: string): string {
  return createHash('sha256').update(`${HASH_NAMESPACE}\0${normalizeProjectRoot(projectRoot)}`).digest('hex')
}

export async function readProjectMemory(
  projectRoot: string,
  memoryRoot: string
): Promise<ReadProjectMemoryResult> {
  const root = normalizeMemoryRoot(memoryRoot)
  const hash = projectHash(projectRoot)
  const projectDir = projectMemoryDir(root, hash)

  const entries = await readBucket<ProjectMemoryEntry>(path.join(projectDir, 'confirmed'), 'confirmed')
  const drafts = await readBucket<ProjectMemoryDraft>(path.join(projectDir, 'drafts'), 'drafts')

  return {
    projectHash: hash,
    markdown: renderPromptMarkdown(entries),
    entries,
    drafts
  }
}

export async function proposeMemoryDraft(
  projectRoot: string,
  memoryRoot: string,
  input: ProjectMemoryDraftInput
): Promise<ProjectMemoryDraft> {
  const now = new Date().toISOString()
  const draft: ProjectMemoryDraft = {
    id: randomUUID(),
    kind: normalizeRequiredText(input.kind, 'kind'),
    title: normalizeRequiredText(input.title, 'title'),
    body: normalizeRequiredText(input.body, 'body'),
    source: normalizeRequiredText(input.source, 'source'),
    reason: normalizeRequiredText(input.reason, 'reason'),
    createdAt: now,
    updatedAt: now,
    status: 'draft'
  }

  await writeEntry(projectRoot, memoryRoot, 'drafts', draft)
  return draft
}

export async function acceptMemoryDraft(
  projectRoot: string,
  memoryRoot: string,
  draftId: string
): Promise<ProjectMemoryEntry> {
  const id = safeEntryId(draftId)
  const root = normalizeMemoryRoot(memoryRoot)
  const hash = projectHash(projectRoot)
  const projectDir = projectMemoryDir(root, hash)
  const draftPath = entryJsonPath(projectDir, 'drafts', id)
  const draft = parseDraft(await readFile(draftPath, 'utf8'), draftPath)

  const now = new Date().toISOString()
  const entry: ProjectMemoryEntry = {
    id: draft.id,
    kind: draft.kind,
    title: draft.title,
    body: draft.body,
    source: draft.source,
    reason: draft.reason,
    createdAt: draft.createdAt,
    updatedAt: now
  }

  await writeEntry(projectRoot, memoryRoot, 'confirmed', entry)
  await removeEntryFiles(projectDir, 'drafts', id)
  return entry
}

export async function deleteMemoryEntry(
  projectRoot: string,
  memoryRoot: string,
  entryId: string
): Promise<DeleteMemoryEntryResult> {
  const id = safeEntryId(entryId)
  const root = normalizeMemoryRoot(memoryRoot)
  const hash = projectHash(projectRoot)
  const projectDir = projectMemoryDir(root, hash)
  const deletedFrom: Array<'confirmed' | 'drafts'> = []

  if (await removeEntryFiles(projectDir, 'confirmed', id)) deletedFrom.push('confirmed')
  if (await removeEntryFiles(projectDir, 'drafts', id)) deletedFrom.push('drafts')

  return {
    id,
    deleted: deletedFrom.length > 0,
    deletedFrom
  }
}

async function writeEntry(
  projectRoot: string,
  memoryRoot: string,
  bucket: MemoryBucket,
  entry: ProjectMemoryEntry | ProjectMemoryDraft
): Promise<void> {
  const root = normalizeMemoryRoot(memoryRoot)
  const hash = projectHash(projectRoot)
  const projectDir = projectMemoryDir(root, hash)
  const bucketDir = path.join(projectDir, bucket)

  await mkdir(bucketDir, { recursive: true })
  await atomicWriteText(entryJsonPath(projectDir, bucket, entry.id), `${JSON.stringify(entry, null, JSON_INDENT)}\n`)
  await atomicWriteText(entryMarkdownPath(projectDir, bucket, entry.id), renderEntryMarkdown(entry))
}

async function readBucket<T extends ProjectMemoryEntry | ProjectMemoryDraft>(
  bucketDir: string,
  bucket: MemoryBucket
): Promise<T[]> {
  const names = await readdir(bucketDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  const jsonNames = names.filter((name) => name.endsWith('.json')).sort()
  const entries: T[] = []

  for (const name of jsonNames) {
    const id = safeEntryId(name.slice(0, -'.json'.length))
    const filePath = path.join(bucketDir, `${id}.json`)
    const raw = await readFile(filePath, 'utf8')
    entries.push((bucket === 'drafts' ? parseDraft(raw, filePath) : parseConfirmed(raw, filePath)) as T)
  }

  return entries.sort(compareEntries)
}

function parseConfirmed(raw: string, filePath: string): ProjectMemoryEntry {
  const value = parseJsonObject(raw, filePath)
  const entry: ProjectMemoryEntry = {
    id: readString(value, 'id', filePath),
    kind: readString(value, 'kind', filePath),
    title: readString(value, 'title', filePath),
    body: readString(value, 'body', filePath),
    source: readString(value, 'source', filePath),
    reason: readString(value, 'reason', filePath),
    createdAt: readString(value, 'createdAt', filePath),
    updatedAt: readString(value, 'updatedAt', filePath)
  }
  safeEntryId(entry.id)
  return entry
}

function parseDraft(raw: string, filePath: string): ProjectMemoryDraft {
  const value = parseJsonObject(raw, filePath)
  const status = readString(value, 'status', filePath)
  if (status !== 'draft') throw new Error(`记忆草稿状态无效: ${filePath}`)

  return {
    ...parseConfirmed(raw, filePath),
    status
  }
}

function parseJsonObject(raw: string, filePath: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`记忆 JSON 无法解析: ${filePath}: ${errorMessage(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`记忆 JSON 必须是对象: ${filePath}`)
  }
  return parsed as Record<string, unknown>
}

function readString(value: Record<string, unknown>, key: string, filePath: string): string {
  const field = value[key]
  if (typeof field !== 'string' || !field.trim()) {
    throw new Error(`记忆字段 ${key} 必须是非空字符串: ${filePath}`)
  }
  return field
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(tmpPath, content, { encoding: 'utf8', flag: 'wx' })
    await rename(tmpPath, filePath)
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw err
  }
}

async function removeEntryFiles(projectDir: string, bucket: MemoryBucket, id: string): Promise<boolean> {
  const results = await Promise.all([
    removeIfExists(entryJsonPath(projectDir, bucket, id)),
    removeIfExists(entryMarkdownPath(projectDir, bucket, id))
  ])
  return results.some(Boolean)
}

async function removeIfExists(filePath: string): Promise<boolean> {
  try {
    await rm(filePath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function renderPromptMarkdown(entries: ProjectMemoryEntry[]): string {
  if (entries.length === 0) return ''

  const blocks = entries.map((entry) => {
    const meta = [
      `- Kind: ${entry.kind}`,
      `- Source: ${entry.source}`,
      `- Reason: ${entry.reason}`,
      `- Updated: ${entry.updatedAt}`
    ].join('\n')

    return `### ${entry.title}\n${meta}\n\n${entry.body}`
  })

  return `## Project Memory\n\nConfirmed project memories for this workspace:\n\n${blocks.join('\n\n')}\n`
}

function renderEntryMarkdown(entry: ProjectMemoryEntry | ProjectMemoryDraft): string {
  const statusLine = 'status' in entry ? `- Status: ${entry.status}\n` : ''
  return `# ${entry.title}

${statusLine}- Kind: ${entry.kind}
- Source: ${entry.source}
- Reason: ${entry.reason}
- Created: ${entry.createdAt}
- Updated: ${entry.updatedAt}

${entry.body}
`
}

function compareEntries(a: ProjectMemoryEntry, b: ProjectMemoryEntry): number {
  const byUpdated = b.updatedAt.localeCompare(a.updatedAt)
  if (byUpdated !== 0) return byUpdated
  const byTitle = a.title.localeCompare(b.title)
  if (byTitle !== 0) return byTitle
  return a.id.localeCompare(b.id)
}

function normalizeProjectRoot(projectRoot: string): string {
  const normalized = normalizeRequiredText(projectRoot, 'projectRoot')
  if (normalized.includes('\0')) throw new Error('projectRoot 包含非法字符')
  return path.resolve(normalized)
}

function normalizeMemoryRoot(memoryRoot: string): string {
  const normalized = normalizeRequiredText(memoryRoot, 'memoryRoot')
  if (normalized.includes('\0')) throw new Error('memoryRoot 包含非法字符')
  return path.resolve(normalized)
}

function normalizeRequiredText(value: string, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} 不能为空`)
  return normalized
}

function safeEntryId(id: string): string {
  const normalized = normalizeRequiredText(id, 'entryId')
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(normalized)) throw new Error('entryId 包含非法字符')
  return normalized
}

function projectMemoryDir(memoryRoot: string, hash: string): string {
  return path.join(memoryRoot, 'projects', hash)
}

function entryJsonPath(projectDir: string, bucket: MemoryBucket, id: string): string {
  return path.join(projectDir, bucket, `${safeEntryId(id)}.json`)
}

function entryMarkdownPath(projectDir: string, bucket: MemoryBucket, id: string): string {
  return path.join(projectDir, bucket, `${safeEntryId(id)}.md`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
