import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import chokidar, { type FSWatcher } from 'chokidar'
import initSqlJs from 'sql.js'
import { languageForFile, parseCodeFile, type CodeSymbolKind } from './parsers/languages'

type SqlValue = number | string | Uint8Array | null
type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>
type SqlDatabase = InstanceType<SqlJsStatic['Database']>

const nodeRequire = createRequire(__filename)
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_SCAN_FILES = 50_000
const WATCH_DEBOUNCE_MS = 250
const DEFAULT_LIMIT = 20
const DEFAULT_IGNORED_DIRS = new Set([
  '.caogen',
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
const RESOLVE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.py',
  '.go',
  '.rs',
  '.java'
]

export interface IndexedSymbol {
  name: string
  kind: CodeSymbolKind
  filePath: string
  line: number
  column: number
  endLine: number
  signature: string
  exported: boolean
}

export interface IndexedFile {
  path: string
  language: string
  size: number
  mtimeMs: number
}

export interface CodeSearchMatch {
  filePath: string
  line: number
  snippet: string
}

export interface DependencyView {
  filePath: string
  dependencies: string[]
  dependents: string[]
  externalImports: string[]
}

export interface ProjectIndexStats {
  root: string
  dbPath: string
  files: number
  symbols: number
  dependencies: number
  indexedAt: number
  durationMs: number
}

interface EnsureOptions {
  watch?: boolean
}

interface IgnoreRule {
  pattern: string
  directoryOnly: boolean
  rootOnly: boolean
  regex: RegExp
}

interface ScannedFile {
  fullPath: string
  relPath: string
  size: number
  mtimeMs: number
}

const indexers = new Map<string, Promise<ProjectIndexer>>()
let sqlPromise: Promise<SqlJsStatic> | null = null

export async function ensureProjectIndex(projectRoot: string, options: EnsureOptions = {}): Promise<ProjectIndexer> {
  const root = resolve(projectRoot)
  const existing = indexers.get(root)
  if (existing) {
    const indexer = await existing
    if (options.watch !== false) indexer.startWatcher()
    return indexer
  }
  const created = ProjectIndexer.create(root, options)
  indexers.set(root, created)
  return created
}

export async function disposeProjectIndexers(): Promise<void> {
  const current = await Promise.all([...indexers.values()])
  indexers.clear()
  await Promise.all(current.map((indexer) => indexer.dispose()))
}

export class ProjectIndexer {
  private watcher: FSWatcher | null = null
  private readonly pendingUpdates = new Map<string, NodeJS.Timeout>()
  private readonly indexPath: string
  private readonly ignoreRules: IgnoreRule[]
  private initializedAt = 0
  private lastStats: ProjectIndexStats | null = null

  private constructor(
    private readonly root: string,
    private readonly db: SqlDatabase
  ) {
    this.indexPath = join(root, '.caogen', 'index.db')
    this.ignoreRules = readGitignoreRules(root)
  }

  static async create(projectRoot: string, options: EnsureOptions = {}): Promise<ProjectIndexer> {
    const root = resolve(projectRoot)
    const info = await stat(root)
    if (!info.isDirectory()) throw new Error('项目根目录不存在或不是目录')
    await mkdir(join(root, '.caogen'), { recursive: true })

    const SQL = await loadSql()
    const dbPath = join(root, '.caogen', 'index.db')
    const db = await access(dbPath, constants.R_OK)
      .then(async () => new SQL.Database(await readFile(dbPath)))
      .catch(() => new SQL.Database())
    const indexer = new ProjectIndexer(root, db)
    indexer.setupSchema()
    await indexer.rebuild()
    if (options.watch !== false) indexer.startWatcher()
    return indexer
  }

  async dispose(): Promise<void> {
    for (const timer of this.pendingUpdates.values()) clearTimeout(timer)
    this.pendingUpdates.clear()
    if (this.watcher) await this.watcher.close()
    this.watcher = null
    this.persist()
    this.db.close()
  }

  stats(): ProjectIndexStats | null {
    return this.lastStats
  }

  startWatcher(): void {
    if (this.watcher) return
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      ignored: (targetPath, statsInfo) => {
        const rel = toProjectRelative(this.root, targetPath)
        if (!rel) return false
        return this.shouldIgnore(rel, statsInfo?.isDirectory() ?? false)
      },
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    })
    this.watcher
      .on('add', (path) => this.queueUpdate(path))
      .on('change', (path) => this.queueUpdate(path))
      .on('unlink', (path) => this.removeFileByFullPath(path))
  }

  async rebuild(): Promise<ProjectIndexStats> {
    const started = Date.now()
    const files = await this.scanFiles()
    const seen = new Set(files.map((file) => file.relPath))
    for (const row of this.select<{ path: string }>('SELECT path FROM files')) {
      if (!seen.has(row.path)) this.removeFile(row.path, false, true)
    }

    this.db.run('BEGIN TRANSACTION')
    try {
      for (const file of files) {
        const current = this.fileRecord(file.relPath)
        if (current && current.size === file.size && current.mtimeMs === file.mtimeMs) continue
        await this.indexFile(file, false)
      }
      this.db.run('COMMIT')
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }

    this.persist()
    this.initializedAt = Date.now()
    this.lastStats = {
      root: this.root,
      dbPath: this.indexPath,
      files: this.scalar('SELECT COUNT(*) FROM files'),
      symbols: this.scalar('SELECT COUNT(*) FROM symbols'),
      dependencies: this.scalar('SELECT COUNT(*) FROM dependencies'),
      indexedAt: this.initializedAt,
      durationMs: Date.now() - started
    }
    return this.lastStats
  }

  searchSymbols(name: string, kind?: string, limit = DEFAULT_LIMIT): IndexedSymbol[] {
    const clean = name.trim()
    if (!clean) return []
    const capped = clampLimit(limit)
    const params: SqlValue[] = [`%${clean}%`, clean, capped]
    const kindClause = kind ? 'AND kind = ?' : ''
    if (kind) params.splice(1, 0, kind)
    return this.select<IndexedSymbolRow>(
      `SELECT name, kind, file_path, line, column, end_line, signature, exported
       FROM symbols
       WHERE name LIKE ? ${kindClause}
       ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, exported DESC, length(name), file_path
       LIMIT ?`,
      params
    ).map((row) => ({
      name: row.name,
      kind: row.kind as CodeSymbolKind,
      filePath: row.file_path,
      line: row.line,
      column: row.column,
      endLine: row.end_line,
      signature: row.signature,
      exported: row.exported === 1
    }))
  }

  async searchCode(query: string, glob?: string, limit = DEFAULT_LIMIT): Promise<CodeSearchMatch[]> {
    const clean = query.trim()
    if (!clean) return []
    const capped = clampLimit(limit)
    try {
      const matches = await runRipgrepBinary(this.root, clean, glob, capped)
      return matches.length > 0 ? matches : this.fallbackSearchCode(clean, glob, capped)
    } catch {
      return this.fallbackSearchCode(clean, glob, capped)
    }
  }

  findFiles(pattern: string, limit = DEFAULT_LIMIT): IndexedFile[] {
    const clean = pattern.trim().toLowerCase()
    const capped = clampLimit(limit)
    const rows = this.select<IndexedFileRow>(
      'SELECT path, language, size, mtime_ms FROM files ORDER BY length(path), path LIMIT 5000'
    )
    return rows
      .filter((row) => !clean || row.path.toLowerCase().includes(clean) || fuzzyMatch(row.path.toLowerCase(), clean))
      .slice(0, capped)
      .map((row) => ({
        path: row.path,
        language: row.language,
        size: row.size,
        mtimeMs: row.mtime_ms
      }))
  }

  dependencies(filePath: string): DependencyView {
    const relPath = normalizeInputPath(this.root, filePath)
    const dependencies = this.select<{ target_path: string }>(
      'SELECT DISTINCT target_path FROM dependencies WHERE file_path = ? AND external = 0 AND target_path != ? ORDER BY target_path',
      [relPath, '']
    ).map((row) => row.target_path)
    const dependents = this.select<{ file_path: string }>(
      'SELECT DISTINCT file_path FROM dependencies WHERE target_path = ? AND external = 0 ORDER BY file_path',
      [relPath]
    ).map((row) => row.file_path)
    const externalImports = this.select<{ raw_import: string }>(
      'SELECT DISTINCT raw_import FROM dependencies WHERE file_path = ? AND external = 1 ORDER BY raw_import',
      [relPath]
    ).map((row) => row.raw_import)
    return { filePath: relPath, dependencies, dependents, externalImports }
  }

  private setupSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        abs_path TEXT NOT NULL,
        language TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
      CREATE TABLE IF NOT EXISTS dependencies (
        file_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        raw_import TEXT NOT NULL,
        external INTEGER NOT NULL DEFAULT 0,
        line INTEGER NOT NULL,
        PRIMARY KEY (file_path, target_path, raw_import, line)
      );
      CREATE INDEX IF NOT EXISTS idx_dependencies_target ON dependencies(target_path);
    `)
  }

  private async scanFiles(): Promise<ScannedFile[]> {
    const out: ScannedFile[] = []
    const queue: string[] = [this.root]
    while (queue.length > 0 && out.length < MAX_SCAN_FILES) {
      const dir = queue.shift() as string
      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        const relPath = toProjectRelative(this.root, fullPath)
        if (!relPath) continue
        if (entry.isDirectory()) {
          if (!this.shouldIgnore(relPath, true)) queue.push(fullPath)
          continue
        }
        if (!entry.isFile() || this.shouldIgnore(relPath, false) || !languageForFile(fullPath)) continue
        const info = await stat(fullPath).catch(() => null)
        if (!info || info.size > MAX_FILE_BYTES) continue
        out.push({ fullPath, relPath, size: info.size, mtimeMs: info.mtimeMs })
      }
    }
    return out
  }

  private async indexFile(file: ScannedFile, persistAfter = true): Promise<void> {
    const parsed = await readParseableFile(file.fullPath)
    if (!parsed.ok) {
      this.removeFile(file.relPath, false, false)
      return
    }
    const code = parseCodeFile(file.fullPath, parsed.content)
    if (!code) return

    this.removeFile(file.relPath, false, false)
    this.db.run(
      'INSERT INTO files(path, abs_path, language, size, mtime_ms) VALUES (?, ?, ?, ?, ?)',
      [file.relPath, file.fullPath, code.language, file.size, file.mtimeMs]
    )
    for (const symbol of code.symbols) {
      this.db.run(
        `INSERT INTO symbols(name, kind, file_path, line, column, end_line, signature, exported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          symbol.name,
          symbol.kind,
          file.relPath,
          symbol.line,
          symbol.column,
          symbol.endLine,
          symbol.signature,
          symbol.exported ? 1 : 0
        ]
      )
    }
    for (const item of code.imports) {
      const resolved = resolveImport(this.root, file.relPath, item.specifier)
      this.db.run(
        'INSERT OR IGNORE INTO dependencies(file_path, target_path, raw_import, external, line) VALUES (?, ?, ?, ?, ?)',
        [file.relPath, resolved.path, item.specifier, resolved.external ? 1 : 0, item.line]
      )
    }
    if (persistAfter) this.persist()
  }

  private queueUpdate(fullPath: string): void {
    const relPath = toProjectRelative(this.root, fullPath)
    if (!relPath || this.shouldIgnore(relPath, false) || !languageForFile(fullPath)) return
    const previous = this.pendingUpdates.get(fullPath)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.pendingUpdates.delete(fullPath)
      void this.indexChangedFile(fullPath)
    }, WATCH_DEBOUNCE_MS)
    this.pendingUpdates.set(fullPath, timer)
  }

  private async indexChangedFile(fullPath: string): Promise<void> {
    const relPath = toProjectRelative(this.root, fullPath)
    const info = await stat(fullPath).catch(() => null)
    if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) {
      this.removeFile(relPath, true, true)
      return
    }
    await this.indexFile({ fullPath, relPath, size: info.size, mtimeMs: info.mtimeMs })
  }

  private removeFileByFullPath(fullPath: string): void {
    const relPath = toProjectRelative(this.root, fullPath)
    if (relPath) this.removeFile(relPath, true, true)
  }

  private removeFile(relPath: string, persistAfter: boolean, removeInbound: boolean): void {
    this.db.run('DELETE FROM files WHERE path = ?', [relPath])
    this.db.run('DELETE FROM symbols WHERE file_path = ?', [relPath])
    if (removeInbound) {
      this.db.run('DELETE FROM dependencies WHERE file_path = ? OR target_path = ?', [relPath, relPath])
    } else {
      this.db.run('DELETE FROM dependencies WHERE file_path = ?', [relPath])
    }
    if (persistAfter) this.persist()
  }

  private fileRecord(relPath: string): { size: number; mtimeMs: number } | null {
    const rows = this.select<{ size: number; mtime_ms: number }>(
      'SELECT size, mtime_ms FROM files WHERE path = ? LIMIT 1',
      [relPath]
    )
    const row = rows[0]
    return row ? { size: row.size, mtimeMs: row.mtime_ms } : null
  }

  private fallbackSearchCode(query: string, glob: string | undefined, limit: number): CodeSearchMatch[] {
    const files = this.findFiles('', 5000)
    const matches: CodeSearchMatch[] = []
    for (const file of files) {
      if (glob && !globMatch(file.path, glob)) continue
      const fullPath = join(this.root, file.path)
      const text = readFileSyncUtf8(fullPath)
      if (text === null) continue
      const lines = text.split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        if (!line.includes(query)) continue
        matches.push({ filePath: file.path, line: index + 1, snippet: line.trim() })
        if (matches.length >= limit) return matches
      }
    }
    return matches
  }

  private shouldIgnore(relPath: string, isDir: boolean): boolean {
    const parts = relPath.split(/[\\/]/)
    if (parts.some((part) => DEFAULT_IGNORED_DIRS.has(part))) return true
    if (relPath.includes('.min.') || relPath.endsWith('.map')) return true
    for (const rule of this.ignoreRules) {
      if (rule.directoryOnly && !isDir) continue
      const target = relPath.split(sep).join('/')
      if (rule.rootOnly ? rule.regex.test(target) : parts.some((part) => rule.regex.test(part)) || rule.regex.test(target)) {
        return true
      }
    }
    return false
  }

  private persist(): void {
    const data = this.db.export()
    writeFile(this.indexPath, data).catch((err: unknown) => {
      console.error('[caogen] 保存项目索引失败:', err)
    })
  }

  private select<T extends Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql, params)
    const rows: T[] = []
    try {
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
    } finally {
      stmt.free()
    }
    return rows
  }

  private scalar(sql: string): number {
    const rows = this.db.exec(sql)
    const value = rows[0]?.values[0]?.[0]
    return typeof value === 'number' ? value : Number(value ?? 0)
  }
}

interface IndexedSymbolRow extends Record<string, SqlValue> {
  name: string
  kind: string
  file_path: string
  line: number
  column: number
  end_line: number
  signature: string
  exported: number
}

interface IndexedFileRow extends Record<string, SqlValue> {
  path: string
  language: string
  size: number
  mtime_ms: number
}

async function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    const wasmPath = nodeRequire.resolve('sql.js/dist/sql-wasm.wasm')
    sqlPromise = initSqlJs({
      locateFile: () => wasmPath
    })
  }
  return sqlPromise
}

async function readParseableFile(filePath: string): Promise<{ ok: true; content: string } | { ok: false }> {
  const buffer = await readFile(filePath).catch(() => null)
  if (!buffer || buffer.includes(0)) return { ok: false }
  try {
    return { ok: true, content: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  } catch {
    return { ok: false }
  }
}

function readFileSyncUtf8(filePath: string): string | null {
  try {
    const fs = nodeRequire('node:fs') as typeof import('node:fs')
    const buffer = fs.readFileSync(filePath)
    if (buffer.includes(0)) return null
    return buffer.toString('utf8')
  } catch {
    return null
  }
}

function readGitignoreRules(root: string): IgnoreRule[] {
  const fs = nodeRequire('node:fs') as typeof import('node:fs')
  const file = join(root, '.gitignore')
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  return lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => {
      const directoryOnly = line.endsWith('/')
      const rootOnly = line.startsWith('/') || line.includes('/')
      const pattern = line.replace(/^\/+/, '').replace(/\/+$/, '')
      return {
        pattern,
        directoryOnly,
        rootOnly,
        regex: globToRegex(pattern)
      }
    })
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

function resolveImport(root: string, fromRelPath: string, specifier: string): { path: string; external: boolean } {
  if (!specifier.startsWith('.')) {
    const rust = resolveRustModule(root, fromRelPath, specifier)
    return rust ?? { path: '', external: true }
  }
  const fromDir = dirname(join(root, fromRelPath))
  const base = resolve(fromDir, specifier)
  const resolved = resolveExistingImport(root, base)
  return resolved ? { path: resolved, external: false } : { path: '', external: true }
}

function resolveRustModule(root: string, fromRelPath: string, specifier: string): { path: string; external: boolean } | null {
  if (specifier.includes('::')) return null
  const fromDir = dirname(join(root, fromRelPath))
  const base = resolve(fromDir, specifier)
  const resolved = resolveExistingImport(root, base, ['.rs'])
  return resolved ? { path: resolved, external: false } : null
}

function resolveExistingImport(root: string, basePath: string, extensions = RESOLVE_EXTENSIONS): string | null {
  const fs = nodeRequire('node:fs') as typeof import('node:fs')
  const candidates = [
    basePath,
    ...extensions.map((ext) => `${basePath}${ext}`),
    ...extensions.map((ext) => join(basePath, `index${ext}`)),
    join(basePath, 'mod.rs')
  ]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return toProjectRelative(root, candidate)
    } catch {
      continue
    }
  }
  return null
}

function normalizeInputPath(root: string, filePath: string): string {
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('文件路径不在项目目录内')
  return rel.split(sep).join('/')
}

function toProjectRelative(root: string, fullPath: string): string {
  return relative(root, fullPath).split(sep).join('/')
}

function clampLimit(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(1, Math.floor(value))) : DEFAULT_LIMIT
}

function runRipgrepBinary(root: string, query: string, glob: string | undefined, limit: number): Promise<CodeSearchMatch[]> {
  const args = ['--json', '-F', query]
  if (glob?.trim()) args.push('-g', glob.trim())
  return new Promise((resolvePromise, reject) => {
    execFile('rg', args, { cwd: root, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        const code = (err as { code?: number | string }).code
        if (code === 1 || code === '1') {
          resolvePromise([])
          return
        }
        reject(new Error(stderr || err.message))
        return
      }
      const matches: CodeSearchMatch[] = []
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as {
            type?: string
            data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number }
          }
          if (event.type !== 'match' || !event.data?.path?.text || typeof event.data.line_number !== 'number') continue
          matches.push({
            filePath: toProjectRelative(root, resolve(root, event.data.path.text)),
            line: event.data.line_number,
            snippet: (event.data.lines?.text ?? '').trim()
          })
          if (matches.length >= limit) break
        } catch {
          // 忽略 rg JSON 流中的异常行,保留已解析结果。
        }
      }
      resolvePromise(matches)
    })
  })
}

function fuzzyMatch(target: string, query: string): boolean {
  if (!query) return true
  let cursor = 0
  for (const char of target) {
    if (char === query[cursor]) cursor++
    if (cursor === query.length) return true
  }
  return false
}

function globMatch(filePath: string, glob: string): boolean {
  if (!glob.trim()) return true
  const normalized = glob.split(sep).join('/').replace(/\\/g, '/')
  if (globToRegex(normalized.replace(/^\*\*\//, '*')).test(filePath)) return true
  if (normalized.includes('**/')) {
    const zeroDepthPattern = normalized.replace(/\*\*\//g, '')
    if (globToRegex(zeroDepthPattern).test(filePath)) return true
  }
  return filePath.includes(normalized.replace(/\*/g, ''))
}

function formatExecError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function hasRipgrepBinary(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile('rg', ['--version'], { timeout: 3000 }, (err) => {
      if (err) console.warn('[caogen] rg 不可用,search_code 将使用内置降级搜索:', formatExecError(err))
      resolvePromise(!err)
    })
  })
}
