import {
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'

const DEFAULT_MAX_READ_BYTES = 1_000_000
const DEFAULT_MAX_WRITE_BYTES = 1_000_000
const DEFAULT_MAX_LIST_ENTRIES = 5_000
const DEFAULT_MAX_LIST_DEPTH = 10
const DEFAULT_MAX_SEARCH_FILES = 2_000
const DEFAULT_MAX_SEARCH_FILE_BYTES = 512_000
const DEFAULT_MAX_SEARCH_TOTAL_BYTES = 32_000_000
const DEFAULT_MAX_SEARCH_RESULTS = 200
const DEFAULT_MAX_SEARCH_QUERY_CHARS = 120
const DEFAULT_MAX_SEARCH_SNIPPET_CHARS = 240

const DEFAULT_IGNORED_DIRS = new Set([
  '.cache',
  '.git',
  '.next',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  '__pycache__'
])

const DEFAULT_IGNORED_SEARCH_EXTENSIONS = new Set([
  '.7z', '.avi', '.bmp', '.class', '.db', '.dll', '.doc', '.docx', '.eot', '.exe',
  '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.lock', '.mov', '.mp3', '.mp4',
  '.otf', '.pdf', '.png', '.ppt', '.pptx', '.pyc', '.sqlite', '.tar', '.tgz', '.ttf',
  '.wav', '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip'
])

export interface ReadTextFileOptions {
  maxBytes?: number
}

export interface ReadTextFileSuccess {
  ok: true
  path: string
  content: string
  bytes: number
  mtimeMs: number
}

export interface WriteTextFileOptions {
  createParents?: boolean
  maxBytes?: number
}

export interface WriteTextFileSuccess {
  ok: true
  path: string
  bytes: number
  mtimeMs: number
}

export type ProjectFileKind = 'file' | 'directory'

export interface ProjectFileEntry {
  path: string
  name: string
  kind: ProjectFileKind
  size?: number
  mtimeMs: number
}

export interface ListProjectFilesOptions {
  includeHidden?: boolean
  ignoredDirs?: Iterable<string>
  maxDepth?: number
  maxEntries?: number
}

export interface ListProjectFilesSuccess {
  ok: true
  root: string
  entries: ProjectFileEntry[]
  truncated: boolean
}

export interface SearchProjectTextOptions {
  caseSensitive?: boolean
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxResults?: number
  maxQueryChars?: number
  maxSnippetChars?: number
}

export interface ProjectTextSearchMatch {
  path: string
  line: number
  column: number
  snippet: string
  matchStart: number
  matchLength: number
}

export interface SearchProjectTextSuccess {
  ok: true
  query: string
  matches: ProjectTextSearchMatch[]
  filesScanned: number
  filesMatched: number
  truncated: boolean
}

export interface FileOpsFailure {
  ok: false
  error: string
}

export type ReadTextFileResult = ReadTextFileSuccess | FileOpsFailure
export type WriteTextFileResult = WriteTextFileSuccess | FileOpsFailure
export type ListProjectFilesResult = ListProjectFilesSuccess | FileOpsFailure
export type SearchProjectTextResult = SearchProjectTextSuccess | (FileOpsFailure & { matches: ProjectTextSearchMatch[] })

/**
 * 读取项目内 UTF-8 文本文件。拒绝 cwd 外路径、目录、过大文件和明显二进制内容。
 */
export async function readTextFile(
  projectRoot: string,
  relativePath: string,
  options: ReadTextFileOptions = {}
): Promise<ReadTextFileResult> {
  try {
    const root = await normalizeProjectRoot(projectRoot)
    const target = await resolveExistingProjectPath(root, relativePath)
    const info = await stat(target.fullPath)
    if (!info.isFile()) return failure('只能读取文件')

    const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_READ_BYTES)
    if (info.size > maxBytes) return failure(`文件过大: ${info.size} bytes, 上限 ${maxBytes} bytes`)

    const buffer = await readFile(target.fullPath)
    if (buffer.includes(0)) return failure('文件看起来是二进制内容')

    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      return failure('文件不是有效的 UTF-8 文本')
    }

    return {
      ok: true,
      path: target.relativePath,
      content,
      bytes: buffer.byteLength,
      mtimeMs: info.mtimeMs
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

/**
 * 原子写入项目内 UTF-8 文本文件。默认会创建父目录,但不会穿过符号链接目录写到 cwd 外。
 */
export async function writeTextFile(
  projectRoot: string,
  relativePath: string,
  content: string,
  options: WriteTextFileOptions = {}
): Promise<WriteTextFileResult> {
  let tmpPath: string | null = null
  try {
    const root = await normalizeProjectRoot(projectRoot)
    const target = resolveProjectPath(root, relativePath)
    const bytes = Buffer.byteLength(content, 'utf8')
    const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_WRITE_BYTES)
    if (bytes > maxBytes) return failure(`写入内容过大: ${bytes} bytes, 上限 ${maxBytes} bytes`)

    const createParents = options.createParents ?? true
    const parent = path.dirname(target.fullPath)
    if (createParents) {
      await ensureWritableDirectory(root, parent)
    } else {
      await ensureExistingDirectoryInsideRoot(root, parent)
    }

    tmpPath = path.join(parent, `.${path.basename(target.fullPath)}.caogen-${process.pid}-${Date.now()}.tmp`)
    await writeFile(tmpPath, content, 'utf8')
    await rename(tmpPath, target.fullPath)
    tmpPath = null

    const info = await stat(target.fullPath)
    return {
      ok: true,
      path: target.relativePath,
      bytes: info.size,
      mtimeMs: info.mtimeMs
    }
  } catch (err) {
    if (tmpPath) {
      await rm(tmpPath, { force: true }).catch(() => undefined)
    }
    return failure(errorMessage(err))
  }
}

/**
 * 有界列出项目文件。默认跳过隐藏项、依赖目录、构建目录和符号链接。
 */
export async function listProjectFiles(
  projectRoot: string,
  options: ListProjectFilesOptions = {}
): Promise<ListProjectFilesResult> {
  try {
    const root = await normalizeProjectRoot(projectRoot)
    const includeHidden = options.includeHidden ?? false
    const ignoredDirs = new Set([...(options.ignoredDirs ?? DEFAULT_IGNORED_DIRS)])
    const maxDepth = positiveLimit(options.maxDepth, DEFAULT_MAX_LIST_DEPTH)
    const maxEntries = positiveLimit(options.maxEntries, DEFAULT_MAX_LIST_ENTRIES)

    const entries: ProjectFileEntry[] = []
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
    let queueIndex = 0
    let truncated = false

    // Use a cursor instead of Array.shift(): large repositories can enqueue
    // thousands of directories, and shifting would repeatedly move the
    // remaining queue entries (turning a breadth-first walk into O(n²)).
    while (queueIndex < queue.length) {
      const current = queue[queueIndex] as { dir: string; depth: number }
      queueIndex += 1
      const children = await readSortedDir(current.dir)

      for (const child of children) {
        if (entries.length >= maxEntries) {
          truncated = true
          break
        }
        if (!includeHidden && child.name.startsWith('.')) continue

        const fullPath = path.join(current.dir, child.name)
        const info = await lstat(fullPath).catch(() => null)
        if (!info || info.isSymbolicLink()) continue

        const relativePath = toProjectRelative(root, fullPath)
        if (info.isDirectory()) {
          if (ignoredDirs.has(child.name)) continue
          entries.push({
            path: relativePath,
            name: child.name,
            kind: 'directory',
            mtimeMs: info.mtimeMs
          })
          if (current.depth < maxDepth) queue.push({ dir: fullPath, depth: current.depth + 1 })
          continue
        }

        if (info.isFile()) {
          entries.push({
            path: relativePath,
            name: child.name,
            kind: 'file',
            size: info.size,
            mtimeMs: info.mtimeMs
          })
        }
      }

      if (truncated) break
    }

    entries.sort((a, b) => a.path.localeCompare(b.path))
    return { ok: true, root, entries, truncated }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

/**
 * Searches UTF-8 text files below the project root without following symbolic links.
 * Every resource dimension is bounded so renderer-triggered searches cannot scan an
 * unbounded repository or return unbounded snippets.
 */
export async function searchProjectText(
  projectRoot: string,
  queryValue: string,
  options: SearchProjectTextOptions = {}
): Promise<SearchProjectTextResult> {
  try {
    const query = queryValue.trim()
    const maxQueryChars = boundedLimit(options.maxQueryChars, DEFAULT_MAX_SEARCH_QUERY_CHARS, DEFAULT_MAX_SEARCH_QUERY_CHARS)
    if (!query) return { ok: false, matches: [], error: 'Search query cannot be empty' }
    if (query.length > maxQueryChars) return { ok: false, matches: [], error: `Search query exceeds ${maxQueryChars} characters` }
    if (/\0|\r|\n/.test(query)) return { ok: false, matches: [], error: 'Search query must be a single line' }

    const root = await normalizeProjectRoot(projectRoot)
    const maxFiles = boundedLimit(options.maxFiles, DEFAULT_MAX_SEARCH_FILES, DEFAULT_MAX_SEARCH_FILES)
    const maxFileBytes = boundedLimit(options.maxFileBytes, DEFAULT_MAX_SEARCH_FILE_BYTES, DEFAULT_MAX_SEARCH_FILE_BYTES)
    const maxTotalBytes = boundedLimit(options.maxTotalBytes, DEFAULT_MAX_SEARCH_TOTAL_BYTES, DEFAULT_MAX_SEARCH_TOTAL_BYTES)
    const maxResults = boundedLimit(options.maxResults, DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_MAX_SEARCH_RESULTS)
    const maxSnippetChars = Math.max(
      query.length + 6,
      boundedLimit(options.maxSnippetChars, DEFAULT_MAX_SEARCH_SNIPPET_CHARS, DEFAULT_MAX_SEARCH_SNIPPET_CHARS)
    )
    const listing = await listProjectFiles(root, { maxEntries: Math.min(DEFAULT_MAX_LIST_ENTRIES, maxFiles * 3) })
    if (listing.ok === false) return { ok: false, matches: [], error: listing.error }

    const files = listing.entries.filter((entry) => entry.kind === 'file')
    const candidates = files.slice(0, maxFiles)
    const needle = options.caseSensitive ? query : query.toLocaleLowerCase()
    const matchedPaths = new Set<string>()
    const matches: ProjectTextSearchMatch[] = []
    let filesScanned = 0
    let totalBytes = 0
    let truncated = listing.truncated || files.length > candidates.length

    for (const entry of candidates) {
      if (matches.length >= maxResults) {
        truncated = true
        break
      }
      if (DEFAULT_IGNORED_SEARCH_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase())) continue

      const target = await resolveExistingProjectPath(root, entry.path).catch(() => null)
      if (!target) continue
      const info = await stat(target.fullPath).catch(() => null)
      if (!info?.isFile() || info.size > maxFileBytes) continue
      if (totalBytes + info.size > maxTotalBytes) {
        truncated = true
        break
      }

      const buffer = await readFile(target.fullPath).catch(() => null)
      if (!buffer || buffer.includes(0)) continue
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        continue
      }

      filesScanned += 1
      totalBytes += buffer.byteLength
      const lines = content.split(/\r?\n/)
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]
        const haystack = options.caseSensitive ? line : line.toLocaleLowerCase()
        let from = 0
        while (from <= haystack.length - needle.length) {
          const index = haystack.indexOf(needle, from)
          if (index < 0) break
          const snippet = searchSnippet(line, index, query.length, maxSnippetChars)
          matches.push({
            path: entry.path,
            line: lineIndex + 1,
            column: index + 1,
            snippet: snippet.text,
            matchStart: snippet.matchStart,
            matchLength: query.length
          })
          matchedPaths.add(entry.path)
          if (matches.length >= maxResults) {
            truncated = true
            break
          }
          from = index + Math.max(needle.length, 1)
        }
        if (matches.length >= maxResults) break
      }
    }

    return {
      ok: true,
      query,
      matches,
      filesScanned,
      filesMatched: matchedPaths.size,
      truncated
    }
  } catch (err) {
    return { ok: false, matches: [], error: errorMessage(err) }
  }
}

async function normalizeProjectRoot(projectRoot: string): Promise<string> {
  if (!projectRoot.trim()) throw new Error('项目目录不能为空')
  const root = await realpath(projectRoot)
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('项目目录不存在或不是目录')
  return root
}

async function resolveExistingProjectPath(
  root: string,
  relativePath: string
): Promise<{ fullPath: string; relativePath: string }> {
  const target = resolveProjectPath(root, relativePath)
  const realTarget = await realpath(target.fullPath)
  ensureInsideRoot(root, realTarget)
  return { fullPath: realTarget, relativePath: toProjectRelative(root, realTarget) }
}

function resolveProjectPath(root: string, relativePath: string): { fullPath: string; relativePath: string } {
  if (!relativePath.trim()) throw new Error('文件路径不能为空')
  if (relativePath.includes('\0')) throw new Error('文件路径包含非法字符')
  if (path.isAbsolute(relativePath)) throw new Error('只允许项目内相对路径')

  const fullPath = path.resolve(root, relativePath)
  ensureInsideRoot(root, fullPath)
  return { fullPath, relativePath: toProjectRelative(root, fullPath) }
}

async function ensureWritableDirectory(root: string, dir: string): Promise<void> {
  ensureInsideRoot(root, dir)
  if (dir === root) return

  const rel = path.relative(root, dir)
  const parts = rel.split(path.sep).filter(Boolean)
  let current = root

  for (const part of parts) {
    current = path.join(current, part)
    const info = await lstat(current).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })

    if (!info) {
      await mkdir(dir, { recursive: true })
      return
    }
    if (info.isSymbolicLink()) throw new Error('写入路径不能包含符号链接目录')
    if (!info.isDirectory()) throw new Error('写入路径的父级不是目录')
  }

  await ensureExistingDirectoryInsideRoot(root, dir)
}

async function ensureExistingDirectoryInsideRoot(root: string, dir: string): Promise<void> {
  const realDir = await realpath(dir)
  ensureInsideRoot(root, realDir)
  const info = await stat(realDir)
  if (!info.isDirectory()) throw new Error('写入路径的父级不是目录')
}

async function readSortedDir(dir: string): Promise<Array<{ name: string }>> {
  const entries: Array<{ name: string; isDirectory: boolean }> = []
  const handle = await opendir(dir)
  for await (const entry of handle) {
    entries.push({ name: entry.name, isDirectory: entry.isDirectory() })
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

function ensureInsideRoot(root: string, fullPath: string): void {
  const rel = path.relative(root, fullPath)
  if (rel === '') return
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return
  throw new Error('路径越过了项目目录边界')
}

function toProjectRelative(root: string, fullPath: string): string {
  return path.relative(root, fullPath).split(path.sep).join('/')
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function boundedLimit(value: number | undefined, fallback: number, ceiling: number): number {
  return Math.min(positiveLimit(value, fallback), ceiling)
}

function searchSnippet(
  line: string,
  matchIndex: number,
  matchLength: number,
  maxChars: number
): { text: string; matchStart: number } {
  const normalized = line.replace(/\t/g, ' ')
  if (normalized.length <= maxChars) return { text: normalized, matchStart: matchIndex }
  const contentBudget = Math.max(matchLength, maxChars - 6)
  const context = Math.max(0, Math.floor((contentBudget - matchLength) / 2))
  const start = Math.max(0, Math.min(matchIndex - context, normalized.length - contentBudget))
  const end = Math.min(normalized.length, start + contentBudget)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < normalized.length ? '...' : ''
  return {
    text: `${prefix}${normalized.slice(start, end)}${suffix}`,
    matchStart: prefix.length + matchIndex - start
  }
}

function failure(error: string): FileOpsFailure {
  return { ok: false, error }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
