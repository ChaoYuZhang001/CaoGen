import { app } from 'electron'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, TranscriptEntry } from '../shared/types'

/** 只持久化构成对话内容的"耐久事件";deltas/status 是瞬态,meta 可从历史重建 */
const PERSIST_KINDS = new Set<AgentEvent['kind']>([
  'user-message',
  'assistant-message',
  'tool-result',
  'turn-result'
])

/** 回放上限:超长会话只回填最近这么多条,避免打开即卡死 */
const MAX_REPLAY_ENTRIES = 1000

function transcriptsDir(): string {
  return join(app.getPath('userData'), 'transcripts')
}

function fileFor(sdkSessionId: string): string {
  return join(transcriptsDir(), `${sdkSessionId}.jsonl`)
}

function readEntries(path: string): TranscriptEntry[] {
  try {
    const out: TranscriptEntry[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as TranscriptEntry
        if (typeof parsed?.seq === 'number' && parsed.event) out.push(parsed)
      } catch {
        // 尾行可能因异常退出而截断,跳过
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 单会话转录写入器。转录按 sdkSessionId 落盘:resume 延续同一对话即同一文件。
 * 新会话在 init 事件到达前先内存缓冲,拿到 sdkSessionId 后 flush。
 * 同时负责给该会话的所有事件(含瞬态)分配单调递增 seq,供渲染进程去重。
 */
export class TranscriptWriter {
  private seq = 0
  private sdkSessionId: string | null = null
  private buffer: TranscriptEntry[] = []

  constructor(resumeSdkSessionId?: string) {
    if (resumeSdkSessionId) this.bind(resumeSdkSessionId)
  }

  /** 为事件分配 seq;耐久事件同时落盘(或缓冲) */
  next(event: AgentEvent): number {
    if (event.kind === 'init' && event.sdkSessionId) this.bind(event.sdkSessionId)
    const seq = ++this.seq
    if (PERSIST_KINDS.has(event.kind)) {
      const entry: TranscriptEntry = { seq, event }
      if (this.sdkSessionId) this.append(entry)
      else this.buffer.push(entry)
    }
    return seq
  }

  /** 已持久化 + 尚在缓冲的耐久事件,按 seq 有序,截取最近 MAX_REPLAY_ENTRIES 条 */
  read(): TranscriptEntry[] {
    const persisted = this.sdkSessionId ? readEntries(fileFor(this.sdkSessionId)) : []
    const all = [...persisted, ...this.buffer]
    return all.length > MAX_REPLAY_ENTRIES ? all.slice(-MAX_REPLAY_ENTRIES) : all
  }

  private bind(sdkSessionId: string): void {
    if (this.sdkSessionId === sdkSessionId) return
    const prev = this.sdkSessionId
    this.sdkSessionId = sdkSessionId
    try {
      mkdirSync(transcriptsDir(), { recursive: true })
      // resume 分叉出新 sdkSessionId 时,把旧转录复制过来延续对话
      if (prev && existsSync(fileFor(prev)) && !existsSync(fileFor(sdkSessionId))) {
        copyFileSync(fileFor(prev), fileFor(sdkSessionId))
      }
      const existing = readEntries(fileFor(sdkSessionId))
      if (existing.length > 0) {
        this.seq = Math.max(this.seq, existing[existing.length - 1].seq)
      }
      for (const entry of this.buffer.splice(0)) {
        // 缓冲事件的 seq 在续 seq 之前分配过,重新编号保持单调
        this.append({ seq: ++this.seq, event: entry.event })
      }
    } catch (err) {
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
}

/** 启动时清理:不在历史列表里的转录文件已不可达,删除 */
export function cleanupTranscripts(keepSdkSessionIds: Set<string>): void {
  try {
    for (const name of readdirSync(transcriptsDir())) {
      if (!name.endsWith('.jsonl')) continue
      if (!keepSdkSessionIds.has(name.slice(0, -'.jsonl'.length))) {
        unlinkSync(join(transcriptsDir(), name))
      }
    }
  } catch {
    // 目录不存在等,忽略
  }
}
