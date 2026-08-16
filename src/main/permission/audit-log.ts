import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SandboxMode, SessionMeta, ToolRiskLevel, ToolSemanticCapability } from '../../shared/types'
import { redactSensitiveText, redactSensitiveValue } from '../security/secret-redaction'
import { resolveWritableProjectPathSync } from '../utils/safe-project-path'

export type AuditAction = 'allow' | 'deny' | 'ask' | 'execute'
export type AuditSource = 'policy' | 'permission-mode' | 'task-strategy' | 'idempotency' | 'user' | 'local-execution'

export interface ToolAuditEvent {
  action: AuditAction
  source: AuditSource
  toolName: string
  riskLevel?: ToolRiskLevel
  riskReasons?: string[]
  capabilities?: ToolSemanticCapability[]
  input?: unknown
  message?: string
  ok?: boolean
  sandboxMode?: SandboxMode
  modeUsed?: SandboxMode
  sandboxed?: boolean
  fallbackReason?: string
}

interface AuditLogRecordV1 extends Omit<ToolAuditEvent, 'input' | 'message' | 'fallbackReason'> {
  schemaVersion: 1
  ts: string
  inputSummary?: string
  inputDigest?: string
  message?: string
  fallbackReason?: string
}

let configuredUserDataRoot: string | undefined

export function configurePermissionAuditUserDataRoot(userDataRoot: string): void {
  const normalized = userDataRoot.trim()
  if (!normalized) throw new Error('permission audit userData root is required')
  configuredUserDataRoot = normalized
}

export function writeAuditLog(cwd: string, event: ToolAuditEvent): void {
  try {
    const initialPath = resolveWritableProjectPathSync(cwd, '.caogen/audit.log')
    ensureAuditDirectory(dirname(initialPath.fullPath))
    const logPath = resolveWritableProjectPathSync(cwd, '.caogen/audit.log').fullPath
    writeAuditRecord(logPath, event)
  } catch {
    // 审计失败不能打断 Agent 工具执行。
  }
}

/** 查看/规划不得为了写审计而修改用户工作区；审计改落应用私有目录。 */
export function writeSessionAuditLog(
  meta: Pick<SessionMeta, 'id' | 'cwd'> & { taskStrategy?: SessionMeta['taskStrategy'] },
  event: ToolAuditEvent
): void {
  if (meta.taskStrategy === 'execute' || meta.taskStrategy === undefined) {
    writeAuditLog(meta.cwd, event)
    return
  }
  try {
    const root = privateSessionAuditRoot(sessionAuditUserDataRoot())
    writeAuditRecord(join(root, `${safeSessionId(meta.id)}.jsonl`), event)
  } catch {
    // 私有审计失败同样不能扩大权限或打断只读模型响应。
  }
}

function sessionAuditUserDataRoot(): string {
  const root = configuredUserDataRoot ?? process.env.CAOGEN_USER_DATA_DIR?.trim()
  if (!root) throw new Error('permission audit userData root is not configured')
  return root
}

function writeAuditRecord(logPath: string, event: ToolAuditEvent): void {
  const { input, message, fallbackReason, ...safeEvent } = event
  const record = redactSensitiveValue<AuditLogRecordV1>({
    ...safeEvent,
    schemaVersion: 1,
    ts: new Date().toISOString(),
    inputSummary: summarizeInput(event.toolName, input),
    inputDigest: input === undefined ? undefined : digest(input),
    message: optionalRedactedText(message),
    fallbackReason: optionalRedactedText(fallbackReason)
  })
  appendDurableRecord(logPath, Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))
}

function appendDurableRecord(logPath: string, line: Buffer): void {
  const opened = openAppendLog(logPath)
  try {
    if (process.platform === 'win32') chmodSync(logPath, 0o600)
    else fchmodSync(opened.descriptor, 0o600)
    restoreJsonlFraming(opened.descriptor)
    appendFileSync(opened.descriptor, line)
    fsyncSync(opened.descriptor)
  } finally {
    closeSync(opened.descriptor)
  }
  if (opened.created) fsyncDirectory(dirname(logPath))
}

function openAppendLog(logPath: string): { descriptor: number; created: boolean } {
  const appendFlags = constants.O_RDWR | constants.O_APPEND | noFollowFlag()
  try {
    return {
      descriptor: openSync(logPath, appendFlags | constants.O_CREAT | constants.O_EXCL, 0o600),
      created: true
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return { descriptor: openSync(logPath, appendFlags), created: false }
  }
}

function restoreJsonlFraming(descriptor: number): void {
  const size = fstatSync(descriptor).size
  if (size === 0) return
  const lastByte = Buffer.allocUnsafe(1)
  if (readSync(descriptor, lastByte, 0, 1, size - 1) !== 1) {
    throw new Error('permission audit tail could not be inspected')
  }
  if (lastByte[0] !== 0x0a) appendFileSync(descriptor, '\n')
}

function privateSessionAuditRoot(userDataRoot: string): string {
  const requestedRoot = resolve(userDataRoot)
  if (existsSync(requestedRoot)) assertPrivateAuditDirectory(requestedRoot, 'userData')
  ensureAuditDirectory(requestedRoot, 0o700)
  assertPrivateAuditDirectory(requestedRoot, 'userData')
  const canonicalRoot = realpathSync(requestedRoot)
  const auditRoot = join(canonicalRoot, 'task-audit')
  if (existsSync(auditRoot)) assertPrivateAuditDirectory(auditRoot, 'task-audit')
  ensureAuditDirectory(auditRoot, 0o700)
  assertPrivateAuditDirectory(auditRoot, 'task-audit')
  const canonicalAuditRoot = realpathSync(auditRoot)
  const child = relative(canonicalRoot, canonicalAuditRoot)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('permission audit directory escaped userData')
  }
  return canonicalAuditRoot
}

function assertPrivateAuditDirectory(directory: string, label: string): void {
  const info = lstatSync(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`permission audit ${label} must be a real directory`)
  }
}

function ensureAuditDirectory(directory: string, mode?: number): void {
  const missing: string[] = []
  let current = directory
  while (!existsSync(current)) {
    missing.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  mkdirSync(directory, { recursive: true, mode })
  if (mode !== undefined) chmodSync(directory, mode)
  for (const created of missing.reverse()) fsyncDirectory(dirname(created))
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(directory, constants.O_RDONLY | noFollowFlag())
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function noFollowFlag(): number {
  return process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number'
    ? 0
    : constants.O_NOFOLLOW
}

function safeSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown-session'
}

function summarizeInput(toolName: string, input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object') return `${typeof input} sha256:${digest(input)}`
  const record = input as Record<string, unknown>
  const normalized = toolName.trim().toLowerCase()
  const rawPath = record.path ?? record.file_path
  const path = typeof rawPath === 'string' ? clip(rawPath) : undefined
  if (normalized === 'bash' || typeof record.command === 'string') {
    const command = String(record.command ?? '')
    return `command bytes=${Buffer.byteLength(command)} sha256:${digest(command)}`
  }
  if (normalized === 'write_file' || typeof record.content === 'string') {
    const content = String(record.content ?? '')
    return `${path ? `path=${path} ` : ''}content bytes=${Buffer.byteLength(content)} sha256:${digest(content)}`
  }
  if (typeof record.url === 'string') return `urlOrigin=${safeUrlOrigin(record.url)} sha256:${digest(record.url)}`
  const server = typeof record.server === 'string' ? record.server : undefined
  const tool = typeof record.tool === 'string' ? record.tool : undefined
  if (server || tool) return `server=${server ?? '(none)'} tool=${tool ?? '(none)'} inputSha256:${digest(input)}`
  if (path) return `path=${path} inputSha256:${digest(input)}`
  const keys = Object.keys(record).filter((key) => !isSensitiveKey(key)).sort()
  return `keys=${keys.join(',') || '(none)'} inputSha256:${digest(input)}`
}

function clip(text: string): string {
  const redacted = redactSensitiveText(text)
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...[truncated]` : redacted
}

function digest(value: unknown): string {
  let serialized: string
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    serialized = '[unserializable]'
  }
  return createHash('sha256').update(serialized ?? 'undefined').digest('hex')
}

function safeUrlOrigin(value: string): string {
  try {
    const url = new URL(value)
    return url.origin
  } catch {
    return '[invalid-url]'
  }
}

function isSensitiveKey(value: string): boolean {
  return /(authorization|cookie|password|secret|token|api[-_]?key|credential)/i.test(value)
}

function optionalRedactedText(value: string | undefined): string | undefined {
  if (!value) return value
  return redactSensitiveText(value)
}
