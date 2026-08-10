import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import { writeTextFile } from './fileOps'
import { getTypeScriptRenameWorkspaceEdit } from './typescriptRename'
import type {
  ProjectRefactorApplyResult,
  ProjectRefactorFileChange,
  ProjectRefactorInput,
  ProjectRefactorLine,
  ProjectRefactorPreview,
  ProjectRefactorRollbackResult
} from '../shared/types'

const MAX_FILES = 200
const MAX_EDITS = 5_000
const MAX_FILE_BYTES = 1_000_000
const MAX_TOTAL_BYTES = 20_000_000
const PREVIEW_TTL_MS = 10 * 60_000
const MAX_PREVIEWS = 100
const MAX_OPERATIONS = 50
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

interface Position {
  line: number
  character: number
}

interface TextEdit {
  start: Position
  end: Position
  newText: string
}

interface FileSnapshot {
  path: string
  before: string
  after: string
  beforeDigest: string
  afterDigest: string
  edits: TextEdit[]
}

interface PreviewRecord {
  preview: ProjectRefactorPreview
  sessionId: string
  root: string
  snapshots: FileSnapshot[]
  expiresAt: number
}

interface OperationRecord {
  operationId: string
  sessionId: string
  root: string
  snapshots: FileSnapshot[]
  appliedAt: string
}

const previews = new Map<string, PreviewRecord>()
const operations = new Map<string, OperationRecord>()
const activeMutationRoots = new Set<string>()

export async function previewTypeScriptRename(
  rootPath: string,
  sessionId: string,
  input: ProjectRefactorInput
): Promise<ProjectRefactorPreview> {
  const root = await normalizeRoot(rootPath)
  validateRenameInput(input)
  const sourcePath = resolveProjectFile(root, input.path)
  const source = await readProjectFile(root, input.path)
  if (source.content !== input.content) throw new Error('Save the active file before previewing a refactor')
  const rawEdit = getTypeScriptRenameWorkspaceEdit(root, {
    path: input.path,
    content: source.content,
    line: input.line,
    column: input.column
  }, input.newName)
  const editsByPath = parseWorkspaceEdit(rawEdit, root)
  if (editsByPath.size === 0) throw new Error('TypeScript returned no rename edits for this symbol')
  if (editsByPath.size > MAX_FILES) throw new Error('Refactor touches too many files')
  const totalEdits = [...editsByPath.values()].reduce((sum, edits) => sum + edits.length, 0)
  if (totalEdits > MAX_EDITS) throw new Error('Refactor contains too many edits')

  const snapshots: FileSnapshot[] = []
  let totalBytes = 0
  for (const [relativePath, edits] of editsByPath) {
    const current = await readProjectFile(root, relativePath)
    totalBytes += current.bytes
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Refactor input exceeds the size limit')
    const after = applyTextEdits(current.content, edits)
    if (after === current.content) continue
    snapshots.push({
      path: relativePath,
      before: current.content,
      after,
      beforeDigest: digest(current.content),
      afterDigest: digest(after),
      edits
    })
  }
  if (snapshots.length === 0) throw new Error('Refactor produced no file changes')
  const previewId = randomUUID()
  const expiresAt = Date.now() + PREVIEW_TTL_MS
  const preview: ProjectRefactorPreview = {
    previewId,
    kind: 'typescript-rename',
    sourcePath: toProjectRelative(root, sourcePath),
    newName: input.newName,
    files: snapshots.map(publicChange),
    totalEdits: snapshots.reduce((sum, snapshot) => sum + snapshot.edits.length, 0),
    expiresAt: new Date(expiresAt).toISOString()
  }
  previews.set(previewId, { preview, sessionId, root, snapshots, expiresAt })
  trimMap(previews, MAX_PREVIEWS)
  return preview
}

export async function applyProjectRefactor(
  sessionId: string,
  previewId: string
): Promise<ProjectRefactorApplyResult> {
  const record = requiredPreview(sessionId, previewId)
  if (activeMutationRoots.has(record.root)) throw new Error('Another refactor mutation is already active for this workspace')
  previews.delete(previewId)
  activeMutationRoots.add(record.root)
  try {
    await assertSnapshotsCurrent(record.root, record.snapshots, 'before', 'Refactor preview is stale; create a new preview')
    const written: FileSnapshot[] = []
    try {
      for (const snapshot of record.snapshots) {
        const result = await writeTextFile(record.root, snapshot.path, snapshot.after, { createParents: false, maxBytes: MAX_FILE_BYTES })
        if (!result.ok) throw new Error(result.error)
        written.push(snapshot)
      }
    } catch (error) {
      for (const snapshot of written) {
        await writeTextFile(record.root, snapshot.path, snapshot.before, { createParents: false, maxBytes: MAX_FILE_BYTES }).catch(() => undefined)
      }
      throw new Error(`Refactor apply failed and was rolled back: ${errorMessage(error)}`)
    }
    const operationId = randomUUID()
    const appliedAt = new Date().toISOString()
    operations.set(operationId, { operationId, sessionId, root: record.root, snapshots: record.snapshots, appliedAt })
    trimMap(operations, MAX_OPERATIONS)
    return { ok: true, operationId, kind: 'typescript-rename', files: record.snapshots.map((snapshot) => snapshot.path), appliedAt }
  } finally {
    activeMutationRoots.delete(record.root)
  }
}

export async function rollbackProjectRefactor(
  sessionId: string,
  operationId: string
): Promise<ProjectRefactorRollbackResult> {
  const operation = operations.get(operationId)
  if (!operation || operation.sessionId !== sessionId) throw new Error('Refactor operation was not found')
  if (activeMutationRoots.has(operation.root)) throw new Error('Another refactor mutation is already active for this workspace')
  activeMutationRoots.add(operation.root)
  try {
    await assertSnapshotsCurrent(operation.root, operation.snapshots, 'after', 'Files changed after refactor; rollback was refused')
    const written: FileSnapshot[] = []
    try {
      for (const snapshot of operation.snapshots) {
        const result = await writeTextFile(operation.root, snapshot.path, snapshot.before, { createParents: false, maxBytes: MAX_FILE_BYTES })
        if (!result.ok) throw new Error(result.error)
        written.push(snapshot)
      }
    } catch (error) {
      for (const snapshot of written) {
        await writeTextFile(operation.root, snapshot.path, snapshot.after, { createParents: false, maxBytes: MAX_FILE_BYTES }).catch(() => undefined)
      }
      throw new Error(`Refactor rollback failed and was restored: ${errorMessage(error)}`)
    }
    operations.delete(operationId)
    return { ok: true, operationId, files: operation.snapshots.map((snapshot) => snapshot.path), rolledBackAt: new Date().toISOString() }
  } finally {
    activeMutationRoots.delete(operation.root)
  }
}

function validateRenameInput(input: ProjectRefactorInput): void {
  if (!input || typeof input.path !== 'string' || input.path.length > 4_096 ||
    typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_FILE_BYTES ||
    !Number.isSafeInteger(input.line) || !Number.isSafeInteger(input.column) || input.line < 1 || input.column < 1 ||
    typeof input.newName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(input.newName)) {
    throw new Error('TypeScript rename input is invalid')
  }
}

function requiredPreview(sessionId: string, previewId: string): PreviewRecord {
  const record = previews.get(previewId)
  if (!record || record.sessionId !== sessionId) throw new Error('Refactor preview was not found')
  if (record.expiresAt < Date.now()) {
    previews.delete(previewId)
    throw new Error('Refactor preview expired; create a new preview')
  }
  return record
}

async function assertSnapshotsCurrent(root: string, snapshots: FileSnapshot[], expected: 'before' | 'after', message: string): Promise<void> {
  for (const snapshot of snapshots) {
    const current = await readProjectFile(root, snapshot.path)
    const expectedDigest = expected === 'before' ? snapshot.beforeDigest : snapshot.afterDigest
    if (digest(current.content) !== expectedDigest) throw new Error(message)
  }
}

async function readProjectFile(root: string, relativePath: string): Promise<{ content: string; bytes: number }> {
  const target = resolveProjectFile(root, relativePath)
  const entry = await lstat(target)
  if (entry.isSymbolicLink()) throw new Error('Refactor target cannot be a symbolic link')
  const realTarget = await realpath(target)
  if (!isInside(root, realTarget)) throw new Error('Refactor target resolves outside the workspace')
  const info = await stat(realTarget)
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Refactor target is not a supported text file')
  const buffer = await readFile(realTarget)
  if (buffer.includes(0)) throw new Error('Refactor target is binary')
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer) } catch { throw new Error('Refactor target is not valid UTF-8') }
  if (!SUPPORTED_EXTENSIONS.has(path.extname(realTarget).toLowerCase())) throw new Error('Refactor target language is unsupported')
  return { content, bytes: buffer.byteLength }
}

function parseWorkspaceEdit(raw: unknown, root: string): Map<string, TextEdit[]> {
  const result = new Map<string, TextEdit[]>()
  const value = asRecord(raw)
  if (!value) return result
  const changes = asRecord(value.changes)
  if (changes) {
    for (const [uri, edits] of Object.entries(changes)) addEdits(result, uri, edits, root)
  }
  if (Array.isArray(value.documentChanges)) {
    for (const change of value.documentChanges) {
      const record = asRecord(change)
      if (!record || !asRecord(record.textDocument) || !Array.isArray(record.edits)) throw new Error('TypeScript returned unsupported workspace changes')
      const uri = asRecord(record.textDocument)?.uri
      if (typeof uri !== 'string') throw new Error('TypeScript returned an invalid workspace URI')
      addEdits(result, uri, record.edits, root)
    }
  }
  return result
}

function addEdits(target: Map<string, TextEdit[]>, uri: string, raw: unknown, root: string): void {
  if (!uri.startsWith('file:') || !Array.isArray(raw)) throw new Error('TypeScript returned an unsupported edit target')
  const fullPath = fileURLToPath(uri)
  const relativePath = toProjectRelative(root, fullPath)
  if (!SUPPORTED_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) throw new Error('TypeScript returned an unsupported edit file')
  const edits = raw.map(parseTextEdit)
  target.set(relativePath, [...(target.get(relativePath) ?? []), ...edits])
}

function parseTextEdit(value: unknown): TextEdit {
  const record = asRecord(value)
  const range = asRecord(record?.range)
  const start = parsePosition(range?.start)
  const end = parsePosition(range?.end)
  if (typeof record?.newText !== 'string' || record.newText.length > MAX_FILE_BYTES) throw new Error('TypeScript returned an invalid text edit')
  return { start, end, newText: record.newText }
}

function parsePosition(value: unknown): Position {
  const record = asRecord(value)
  const line = record?.line
  const character = record?.character
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || (line as number) < 0 || (character as number) < 0) {
    throw new Error('TypeScript returned an invalid edit range')
  }
  return { line: line as number, character: character as number }
}

function applyTextEdits(content: string, edits: TextEdit[]): string {
  const positioned = edits.map((edit) => ({
    ...edit,
    startOffset: offsetAt(content, edit.start),
    endOffset: offsetAt(content, edit.end)
  }))
  positioned.sort((left, right) => right.startOffset - left.startOffset || right.endOffset - left.endOffset)
  for (let index = 0; index < positioned.length; index += 1) {
    const edit = positioned[index]
    if (edit.endOffset < edit.startOffset || positioned[index - 1] && edit.endOffset > positioned[index - 1].startOffset) {
      throw new Error('TypeScript returned overlapping text edits')
    }
    content = `${content.slice(0, edit.startOffset)}${edit.newText}${content.slice(edit.endOffset)}`
  }
  return content
}

function offsetAt(content: string, position: Position): number {
  const lines = content.split('\n')
  if (position.line >= lines.length) throw new Error('TypeScript returned an out-of-range edit')
  const line = lines[position.line]
  if (position.character > line.length) throw new Error('TypeScript returned an out-of-range edit')
  let offset = 0
  for (let index = 0; index < position.line; index += 1) offset += lines[index].length + 1
  return offset + position.character
}

function publicChange(snapshot: FileSnapshot): ProjectRefactorFileChange {
  return {
    path: snapshot.path,
    editCount: snapshot.edits.length,
    beforeDigest: snapshot.beforeDigest,
    afterDigest: snapshot.afterDigest,
    lines: previewLines(snapshot.before, snapshot.after)
  }
}

function previewLines(before: string, after: string): ProjectRefactorLine[] {
  const beforeLines = before.split(/\r?\n/)
  const afterLines = after.split(/\r?\n/)
  const changed = new Set<number>()
  const max = Math.max(beforeLines.length, afterLines.length)
  for (let index = 0; index < max; index += 1) if (beforeLines[index] !== afterLines[index]) changed.add(index)
  if (changed.size === 0) return []
  const visible = new Set<number>()
  for (const line of changed) for (let index = Math.max(0, line - 1); index <= Math.min(max - 1, line + 1); index += 1) visible.add(index)
  const lines: ProjectRefactorLine[] = []
  for (const index of [...visible].sort((left, right) => left - right).slice(0, 120)) {
    if (beforeLines[index] !== undefined && afterLines[index] !== undefined && beforeLines[index] !== afterLines[index]) {
      lines.push({ line: index + 1, kind: 'removed', text: beforeLines[index] })
      lines.push({ line: index + 1, kind: 'added', text: afterLines[index] })
    } else if (beforeLines[index] !== undefined) {
      lines.push({ line: index + 1, kind: 'context', text: beforeLines[index] })
    } else if (afterLines[index] !== undefined) {
      lines.push({ line: index + 1, kind: 'added', text: afterLines[index] })
    }
  }
  return lines
}

async function normalizeRoot(rootPath: string): Promise<string> {
  const root = await realpath(rootPath)
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('Project root is invalid')
  return root
}

function resolveProjectFile(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('Refactor path must be project-relative')
  const full = path.resolve(root, relativePath)
  if (!isInside(root, full)) throw new Error('Refactor path escapes the workspace')
  return full
}

function toProjectRelative(root: string, fullPath: string): string {
  const resolved = path.resolve(fullPath)
  if (!isInside(root, resolved)) throw new Error('TypeScript returned a path outside the workspace')
  return path.relative(root, resolved).replace(/\\/g, '/')
}

function isInside(root: string, target: string): boolean {
  const relativePath = path.relative(root, target)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function trimMap<T>(map: Map<string, T>, limit: number): void {
  while (map.size > limit) map.delete(map.keys().next().value as string)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
