import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeDurableFileSync } from './durable-file'

export interface SafeFileSnapshot {
  bytes: Buffer
  digest: string
  sizeBytes: number
  executable: boolean
}

export interface SafeDirectoryFile extends SafeFileSnapshot {
  relativePath: string
}

export interface SafeDirectorySnapshot {
  files: SafeDirectoryFile[]
  digest: string
  sizeBytes: number
}

const TEXT_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?<![A-Za-z0-9_])sk-(?:proj-|ant-api03-)?[A-Za-z0-9_-]{20,}/i,
  /(?<![A-Za-z0-9_])(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|password|private[_-]?key|secret)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|key|secret|password)=[^&#\s]+/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i
]

const TEXT_EXTENSIONS = new Set([
  '', '.cjs', '.conf', '.env', '.ini', '.js', '.json', '.jsx', '.md', '.mdc', '.mjs',
  '.py', '.sh', '.text', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml', '.zsh'
])

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function assertNoSymlinkWithin(rootPath: string, targetPath: string): void {
  const root = resolve(rootPath)
  const target = resolve(targetPath)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('migration_path_escape')

  const segments = rel ? rel.split(sep).filter(Boolean) : []
  let current = root
  assertNotSymlink(current)
  for (const segment of segments) {
    current = join(current, segment)
    try {
      assertNotSymlink(current)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
  }
}

export function readSafeFile(filePath: string, maxBytes: number): SafeFileSnapshot {
  const before = lstatSync(filePath)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_not_regular')
  if (before.size <= 0 || before.size > maxBytes) throw new Error('migration_source_size_invalid')

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const fd = openSync(filePath, constants.O_RDONLY | noFollow)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('migration_source_changed')
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error('migration_source_changed')
    }
    return {
      bytes,
      digest: sha256(bytes),
      sizeBytes: bytes.length,
      executable: (opened.mode & 0o111) !== 0
    }
  } finally {
    closeSync(fd)
  }
}

export function readSafeDirectory(
  directory: string,
  limits: { maxFiles: number; maxBytes: number; maxDepth: number; allowEmpty?: boolean }
): SafeDirectorySnapshot {
  const root = resolve(directory)
  const rootInfo = lstatSync(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('migration_source_not_directory')

  const files: SafeDirectoryFile[] = []
  let totalBytes = 0
  const visit = (dir: string, depth: number): void => {
    if (depth > limits.maxDepth) throw new Error('migration_source_depth_exceeded')
    const entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const target = join(dir, entry.name)
      const info = lstatSync(target)
      if (info.isSymbolicLink()) throw new Error('migration_source_symlink')
      if (info.isDirectory()) {
        visit(target, depth + 1)
        continue
      }
      if (!info.isFile()) throw new Error('migration_source_not_regular')
      if (files.length >= limits.maxFiles) throw new Error('migration_source_file_limit')
      const snapshot = readSafeFile(target, limits.maxBytes)
      totalBytes += snapshot.sizeBytes
      if (totalBytes > limits.maxBytes) throw new Error('migration_source_size_invalid')
      files.push({ ...snapshot, relativePath: relative(root, target) })
    }
  }
  visit(root, 0)
  if (files.length === 0 && !limits.allowEmpty) throw new Error('migration_source_empty')

  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file.relativePath)
    digest.update('\0')
    digest.update(file.digest)
    digest.update('\0')
  }
  return { files, digest: digest.digest('hex'), sizeBytes: totalBytes }
}

export function containsSensitiveText(text: string): boolean {
  return TEXT_SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

export function directoryContainsSensitiveText(snapshot: SafeDirectorySnapshot): boolean {
  return snapshot.files.some((file) => {
    const extension = extensionOf(file.relativePath)
    if (!TEXT_EXTENSIONS.has(extension)) return false
    return containsSensitiveText(file.bytes.toString('utf8'))
  })
}

export function safeRulePreview(text: string, maxChars = 280): string {
  if (containsSensitiveText(text)) return 'Content hidden because it may contain credentials.'
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}...` : compact
}

export function targetFingerprint(targetPath: string): string {
  try {
    const info = lstatSync(targetPath)
    if (info.isSymbolicLink()) return 'symlink'
    if (info.isFile()) return `file:${readSafeFile(targetPath, 8 * 1024 * 1024).digest}`
    if (info.isDirectory()) {
      return `dir:${readSafeDirectory(targetPath, {
        maxFiles: 2000,
        maxBytes: 32 * 1024 * 1024,
        maxDepth: 12,
        allowEmpty: true
      }).digest}`
    }
    return 'special'
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
    throw error
  }
}

export function writeFileAtomic(targetPath: string, bytes: Buffer | string, mode = 0o600): void {
  writeDurableFileSync(targetPath, bytes, { mode })
}

export function writeDirectoryAtomic(targetPath: string, snapshot: SafeDirectorySnapshot): void {
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(targetPath), `.${basename(targetPath)}.caogen-${process.pid}-${randomUUID()}.tmp`)
  const displaced = `${temporary}.old`
  let displacedExisting = false
  let published = false
  try {
    mkdirSync(temporary, { recursive: true, mode: 0o700 })
    for (const file of snapshot.files) {
      const destination = join(temporary, file.relativePath)
      const rel = relative(temporary, destination)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('migration_target_escape')
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      writeFileSync(destination, file.bytes, { mode: file.executable ? 0o700 : 0o600, flag: 'wx' })
    }
    if (targetFingerprint(targetPath) !== 'missing') {
      renameSync(targetPath, displaced)
      displacedExisting = true
    }
    renameSync(temporary, targetPath)
    published = true
    fsyncDirectory(dirname(targetPath))
    try {
      rmSync(displaced, { recursive: true, force: true })
    } catch {
      // The new target is already durable. A stale displaced copy is safer than undoing it.
    }
  } catch (error) {
    if (!published && displacedExisting && targetFingerprint(targetPath) === 'missing') {
      renameSync(displaced, targetPath)
    }
    throw error
  } finally {
    rmSync(temporary, { recursive: true, force: true })
    if (published) {
      try {
        rmSync(displaced, { recursive: true, force: true })
      } catch {
        // Cleanup can be retried later without invalidating the published target.
      }
    }
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(directory, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function removeExactTarget(targetPath: string): void {
  const info = lstatSync(targetPath)
  if (info.isSymbolicLink()) throw new Error('migration_target_symlink')
  rmSync(targetPath, { recursive: info.isDirectory(), force: false })
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function extensionOf(path: string): string {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot) : ''
}

function assertNotSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error('migration_symlink_rejected')
}
