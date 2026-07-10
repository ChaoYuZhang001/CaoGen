import { app } from 'electron'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentEvent, AgentEventIdentity, TranscriptEntry } from '../shared/types'
import { applyTranscriptRestorePlan, planTranscriptRestore } from './checkpointRestorePlan'
import type { TranscriptRestorePlan } from './checkpointRestorePlan'

/** 只持久化构成对话内容的"耐久事件";deltas/status 是瞬态,meta 可从历史重建 */
const PERSIST_KINDS = new Set<AgentEvent['kind']>([
  'user-message',
  'assistant-message',
  'tool-result',
  'turn-result',
  'routing',
  'failover',
  'checkpoint',
  'checkpoint-restore',
  'subagent-result',
  'task-dag-update'
])

/** 回放上限:超长会话只回填最近这么多条,避免打开即卡死 */
const MAX_REPLAY_ENTRIES = 1000

export interface EventReceipt extends AgentEventIdentity {
  kind: AgentEvent['kind']
  toolUseId?: string
  requestId?: string
  messageId?: string
  status?: string
  isError?: boolean
  behavior?: 'allow' | 'deny'
}

function transcriptsDir(): string {
  return join(app.getPath('userData'), 'transcripts')
}

function eventReceiptsDir(): string {
  return join(app.getPath('userData'), 'event-receipts')
}

function fileFor(sdkSessionId: string): string {
  return join(transcriptsDir(), `${sdkSessionId}.jsonl`)
}

export function eventReceiptsFile(sdkSessionId: string): string {
  return join(eventReceiptsDir(), `${sdkSessionId}.jsonl`)
}

function legacyStreamId(path: string): string {
  return `legacy-stream:${createHash('sha256').update(path).digest('hex').slice(0, 24)}`
}

function normalizeEntry(path: string, entry: TranscriptEntry): TranscriptEntry {
  const eventId = entry.eventId?.trim() || `legacy-event:${createHash('sha256')
    .update(`${path}\n${entry.seq}\n${JSON.stringify(entry.event)}`)
    .digest('hex')
    .slice(0, 32)}`
  return {
    ...entry,
    eventId,
    streamId: entry.streamId?.trim() || legacyStreamId(path)
  }
}

function readEntries(path: string): TranscriptEntry[] {
  try {
    const out: TranscriptEntry[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as TranscriptEntry
        if (typeof parsed?.seq === 'number' && parsed.event) out.push(normalizeEntry(path, parsed))
      } catch {
        // 尾行可能因异常退出而截断,跳过
      }
    }
    return out
  } catch {
    return []
  }
}

export function readTranscriptEntries(sdkSessionId: string): TranscriptEntry[] {
  return readEntries(fileFor(sdkSessionId))
}

function readReceipts(path: string): EventReceipt[] {
  try {
    const out: EventReceipt[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const receipt = JSON.parse(line) as EventReceipt
        if (
          receipt?.schemaVersion === 1 &&
          typeof receipt.streamId === 'string' &&
          typeof receipt.eventId === 'string' &&
          typeof receipt.seq === 'number' &&
          typeof receipt.occurredAt === 'number' &&
          typeof receipt.kind === 'string'
        ) {
          out.push(receipt)
        }
      } catch {
        // 尾行可能因异常退出而截断,跳过。
      }
    }
    return out
  } catch {
    return []
  }
}

export function readEventReceipts(sdkSessionId: string): EventReceipt[] {
  return readReceipts(eventReceiptsFile(sdkSessionId))
}

function receiptFor(entry: TranscriptEntry & AgentEventIdentity): EventReceipt {
  const event = entry.event
  const receipt: EventReceipt = {
    schemaVersion: 1,
    streamId: entry.streamId,
    eventId: entry.eventId,
    seq: entry.seq,
    occurredAt: entry.occurredAt,
    kind: event.kind,
    ...(entry.causationId ? { causationId: entry.causationId } : {}),
    ...(entry.correlationId ? { correlationId: entry.correlationId } : {})
  }
  if (event.kind === 'tool-start' || event.kind === 'tool-result') receipt.toolUseId = event.toolUseId
  if (event.kind === 'permission-request') {
    receipt.requestId = event.request.requestId
    receipt.toolUseId = event.request.toolUseId
  }
  if (event.kind === 'permission-resolved') receipt.requestId = event.requestId
  if (event.kind === 'permission-resolved') receipt.behavior = event.behavior
  if (event.kind === 'status') receipt.status = event.status
  if (event.kind === 'turn-result' || event.kind === 'tool-result') receipt.isError = event.isError
  if (event.kind === 'user-message' || event.kind === 'checkpoint' || event.kind === 'checkpoint-restore') {
    receipt.messageId = event.messageId
  }
  return receipt
}

export function restoreTranscriptIfMissing(sdkSessionId: string | undefined, entries: TranscriptEntry[]): void {
  if (!sdkSessionId || entries.length === 0) return
  if (readEntries(fileFor(sdkSessionId)).length > 0) return
  const target = fileFor(sdkSessionId)
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    mkdirSync(transcriptsDir(), { recursive: true })
    const body = entries.map((entry) => JSON.stringify(normalizeEntry(target, entry))).join('\n')
    writeFileSync(temp, body ? `${body}\n` : '')
    replaceFileWithRetry(temp, target)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // ignore temp cleanup failure
    }
    console.error('[agent-desk] 从任务快照恢复转录失败:', err)
  }
}

/**
 * 单会话转录写入器。转录按 sdkSessionId 落盘:resume 延续同一对话即同一文件。
 * 新会话在 init 事件到达前先内存缓冲,拿到 sdkSessionId 后 flush。
 * 同时负责给该会话的所有事件(含瞬态)分配单调递增 seq,供渲染进程去重。
 */
export class TranscriptWriter {
  private seq: number
  private sdkSessionId: string | null = null
  private streamId = `stream:${randomUUID()}`
  private buffer: TranscriptEntry[] = []
  private receiptBuffer: EventReceipt[] = []
  private currentCorrelationId?: string
  private lastEventId?: string
  private readonly toolEventIds = new Map<string, string>()
  private readonly requestEventIds = new Map<string, string>()

  constructor(resumeSdkSessionId?: string, initialSeq = 0) {
    this.seq = Math.max(0, Math.floor(initialSeq))
    if (resumeSdkSessionId) this.bind(resumeSdkSessionId)
  }

  /** 为事件分配 seq;耐久事件同时落盘(或缓冲) */
  next(event: AgentEvent): number {
    return this.nextEntry(event).seq
  }

  /** 生成稳定事件身份;引擎将整个 entry 交给 SessionManager。 */
  nextEntry(event: AgentEvent): TranscriptEntry & AgentEventIdentity {
    if (event.kind === 'init' && event.sdkSessionId) this.bind(event.sdkSessionId)
    const seq = ++this.seq
    const eventId = randomUUID()
    const occurredAt = Date.now()
    const identity = this.identityFor(event, eventId, seq, occurredAt)
    const entry: TranscriptEntry & AgentEventIdentity = { ...identity, event }
    if (PERSIST_KINDS.has(event.kind)) {
      if (this.sdkSessionId) this.append(entry)
      else this.buffer.push(entry)
    }
    if (event.kind !== 'text-delta' && event.kind !== 'thinking-delta') {
      const receipt = receiptFor(entry)
      if (this.sdkSessionId) this.appendReceipt(receipt)
      else this.receiptBuffer.push(receipt)
    }
    this.rememberLinks(event, entry)
    return entry
  }

  /** 已持久化 + 尚在缓冲的耐久事件,按 seq 有序,截取最近 MAX_REPLAY_ENTRIES 条 */
  read(): TranscriptEntry[] {
    const all = this.readAll()
    return all.length > MAX_REPLAY_ENTRIES ? all.slice(-MAX_REPLAY_ENTRIES) : all
  }

  /** 完整转录,用于回溯规划/写回;不要用于首屏回放。 */
  readAll(): TranscriptEntry[] {
    const persisted = this.sdkSessionId ? readEntries(fileFor(this.sdkSessionId)) : []
    return [...persisted, ...this.buffer]
  }

  planRestore(checkpointId: string): TranscriptRestorePlan {
    return planTranscriptRestore(this.readAll(), checkpointId)
  }

  restore(
    checkpointId: string,
    restoreEvent?: AgentEvent | ((plan: TranscriptRestorePlan) => AgentEvent)
  ): { plan: TranscriptRestorePlan; entries: TranscriptEntry[] } {
    const current = this.readAll()
    const plan = planTranscriptRestore(current, checkpointId)
    if (!plan.ok) return { plan, entries: current }
    const restored = applyTranscriptRestorePlan(current, plan)
    if (restoreEvent) {
      const maxSeq = current.reduce((max, entry) => Math.max(max, entry.seq), 0)
      const event = typeof restoreEvent === 'function' ? restoreEvent(plan) : restoreEvent
      const identity = this.identityFor(event, randomUUID(), maxSeq + 1, Date.now())
      const entry: TranscriptEntry & AgentEventIdentity = { ...identity, event }
      restored.push(entry)
      if (this.sdkSessionId) this.appendReceipt(receiptFor(entry))
      else this.receiptBuffer.push(receiptFor(entry))
      this.rememberLinks(event, entry)
    }
    this.replace(restored)
    return { plan, entries: restored }
  }

  private bind(sdkSessionId: string): void {
    if (this.sdkSessionId === sdkSessionId) return
    const prev = this.sdkSessionId
    const prevStreamId = this.streamId
    this.sdkSessionId = sdkSessionId
    try {
      mkdirSync(transcriptsDir(), { recursive: true })
      mkdirSync(eventReceiptsDir(), { recursive: true })
      // resume 分叉出新 sdkSessionId 时,把旧转录复制过来延续对话
      if (prev && existsSync(fileFor(prev)) && !existsSync(fileFor(sdkSessionId))) {
        const inherited = readEntries(fileFor(prev))
        const body = inherited.map((entry) => JSON.stringify(entry)).join('\n')
        writeFileSync(fileFor(sdkSessionId), body ? `${body}\n` : '')
      }
      if (prev && existsSync(eventReceiptsFile(prev)) && !existsSync(eventReceiptsFile(sdkSessionId))) {
        copyFileSync(eventReceiptsFile(prev), eventReceiptsFile(sdkSessionId))
      }
      const existing = readEntries(fileFor(sdkSessionId))
      const receipts = readReceipts(eventReceiptsFile(sdkSessionId))
      const existingMax = Math.max(
        existing.reduce((max, entry) => Math.max(max, entry.seq), 0),
        receipts.reduce((max, receipt) => Math.max(max, receipt.seq), 0)
      )
      const existingStreamId = receipts[0]?.streamId ?? existing[0]?.streamId
      if (existingStreamId) this.streamId = existingStreamId
      if ((this.buffer.length > 0 || this.receiptBuffer.length > 0) && existingMax >= this.firstBufferedSeq()) {
        throw new Error('不能把已广播的缓冲事件绑定到已有高游标的转录')
      }
      this.seq = Math.max(this.seq, existingMax)
      for (const entry of this.buffer.splice(0)) {
        this.append(entry)
      }
      for (const receipt of this.receiptBuffer.splice(0)) this.appendReceipt(receipt)
    } catch (err) {
      this.sdkSessionId = prev
      this.streamId = prevStreamId
      console.error('[agent-desk] 绑定转录文件失败:', err)
    }
  }

  private append(entry: TranscriptEntry): void {
    if (!this.sdkSessionId) return
    try {
      mkdirSync(transcriptsDir(), { recursive: true })
      appendFileSync(fileFor(this.sdkSessionId), `${JSON.stringify(entry)}\n`)
    } catch (err) {
      console.error('[agent-desk] 写入转录失败:', err)
    }
  }

  private appendReceipt(receipt: EventReceipt): void {
    if (!this.sdkSessionId) return
    try {
      mkdirSync(eventReceiptsDir(), { recursive: true })
      appendFileSync(eventReceiptsFile(this.sdkSessionId), `${JSON.stringify(receipt)}\n`)
    } catch (err) {
      console.error('[agent-desk] 写入事件回执失败:', err)
    }
  }

  private replace(entries: TranscriptEntry[]): void {
    if (!this.sdkSessionId) {
      this.buffer = [...entries]
      this.seq = Math.max(this.seq, entries.reduce((max, entry) => Math.max(max, entry.seq), 0))
      return
    }
    const target = fileFor(this.sdkSessionId)
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      mkdirSync(transcriptsDir(), { recursive: true })
      const body = entries.map((entry) => JSON.stringify(entry)).join('\n')
      writeFileSync(temp, body ? `${body}\n` : '')
      replaceFileWithRetry(temp, target)
      this.buffer = []
      this.seq = Math.max(this.seq, entries.reduce((max, entry) => Math.max(max, entry.seq), 0))
    } catch (err) {
      try {
        unlinkSync(temp)
      } catch {
        // ignore temp cleanup failure
      }
      console.error('[agent-desk] 替换转录失败:', err)
    }
  }

  private firstBufferedSeq(): number {
    const values = [
      ...this.buffer.map((entry) => entry.seq),
      ...this.receiptBuffer.map((receipt) => receipt.seq)
    ]
    return values.length > 0 ? Math.min(...values) : Number.POSITIVE_INFINITY
  }

  private identityFor(
    event: AgentEvent,
    eventId: string,
    seq: number,
    occurredAt: number
  ): AgentEventIdentity {
    let causationId = this.lastEventId
    let correlationId = this.currentCorrelationId
    if (event.kind === 'user-message') {
      causationId = undefined
      correlationId = eventId
    } else if (event.kind === 'permission-request') {
      causationId = event.request.toolUseId
        ? this.toolEventIds.get(event.request.toolUseId) ?? causationId
        : causationId
    } else if (event.kind === 'permission-resolved') {
      causationId = this.requestEventIds.get(event.requestId) ?? causationId
    } else if (event.kind === 'tool-result') {
      causationId = this.toolEventIds.get(event.toolUseId) ?? causationId
    }
    return {
      schemaVersion: 1,
      streamId: this.streamId,
      eventId,
      seq,
      occurredAt,
      ...(causationId ? { causationId } : {}),
      ...(correlationId ? { correlationId } : {})
    }
  }

  private rememberLinks(event: AgentEvent, identity: AgentEventIdentity): void {
    if (event.kind === 'user-message') this.currentCorrelationId = identity.eventId
    if (event.kind === 'assistant-message') {
      for (const block of event.blocks) {
        if (block.type === 'tool_use') this.toolEventIds.set(block.id, identity.eventId)
      }
    }
    if (event.kind === 'tool-start') this.toolEventIds.set(event.toolUseId, identity.eventId)
    if (event.kind === 'permission-request') {
      this.requestEventIds.set(event.request.requestId, identity.eventId)
      if (event.request.toolUseId) this.toolEventIds.set(event.request.toolUseId, identity.eventId)
    }
    if (event.kind === 'permission-resolved') this.requestEventIds.set(event.requestId, identity.eventId)
    if (event.kind === 'tool-result') this.toolEventIds.set(event.toolUseId, identity.eventId)
    this.lastEventId = identity.eventId
  }
}

/** 启动时清理:不在历史列表里的转录文件已不可达,删除 */
export function cleanupTranscripts(keepSdkSessionIds: Set<string>): void {
  for (const dir of [transcriptsDir(), eventReceiptsDir()]) {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue
        if (!keepSdkSessionIds.has(name.slice(0, -'.jsonl'.length))) {
          unlinkSync(join(dir, name))
        }
      }
    } catch {
      // 目录不存在等,忽略
    }
  }
}

function replaceFileWithRetry(temp: string, target: string): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      if (process.platform === 'win32') {
        unlinkIfExists(target)
      }
      renameSync(temp, target)
      return
    } catch (err) {
      if (!isRetryableFileReplaceError(err) || attempt === 7) throw err
      sleepSync(100)
    }
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path)
  } catch (err) {
    if (!isRecord(err) || err.code !== 'ENOENT') throw err
  }
}

function isRetryableFileReplaceError(err: unknown): boolean {
  return isRecord(err) && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')
}

function isRecord(value: unknown): value is { code?: unknown } {
  return typeof value === 'object' && value !== null
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
