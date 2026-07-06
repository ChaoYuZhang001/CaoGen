import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { TranscriptSearchHit, TranscriptSearchResult } from '../shared/types'

/**
 * 会话全文搜索:跨历史会话检索转录(JSONL)中的用户消息与助手文本块。
 * 纯 Node 实现(不依赖 electron),transcriptsDir / 会话清单由调用方注入,便于独立冒烟。
 */

/** 参与搜索的会话引用(来自历史列表,按最近优先排序传入) */
export interface TranscriptSearchSessionRef {
  sdkSessionId: string
  title: string
  cwd: string
}

export interface TranscriptSearchOptions {
  /** 最多返回多少个会话的结果,默认 30 */
  maxSessions?: number
  /** 每个会话最多返回多少条片段,默认 3 */
  maxHitsPerSession?: number
  /** 超过此大小的转录文件跳过(仅返回 note),默认 10MB */
  maxFileBytes?: number
  /** 片段在命中词前后各保留的字符数,默认 60 */
  snippetRadius?: number
}

export async function searchTranscripts(
  transcriptsDir: string,
  sessions: TranscriptSearchSessionRef[],
  query: string,
  opts: TranscriptSearchOptions = {}
): Promise<TranscriptSearchResult[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const maxSessions = opts.maxSessions ?? 30
  const maxHits = opts.maxHitsPerSession ?? 3
  const maxBytes = opts.maxFileBytes ?? 10 * 1024 * 1024
  const radius = opts.snippetRadius ?? 60

  const results: TranscriptSearchResult[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    if (results.length >= maxSessions) break
    if (!session.sdkSessionId || seen.has(session.sdkSessionId)) continue
    seen.add(session.sdkSessionId)
    const file = join(transcriptsDir, `${session.sdkSessionId}.jsonl`)
    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      continue // 无转录文件(会话未产生耐久事件),跳过
    }
    if (size > maxBytes) {
      results.push({
        sdkSessionId: session.sdkSessionId,
        title: session.title,
        cwd: session.cwd,
        hits: [],
        note: `转录过大(${(size / (1024 * 1024)).toFixed(1)}MB),已跳过`
      })
      continue
    }
    const hits = await searchFile(file, q, maxHits, radius)
    if (hits.length > 0) {
      results.push({
        sdkSessionId: session.sdkSessionId,
        title: session.title,
        cwd: session.cwd,
        hits
      })
    }
  }
  return results
}

/** 逐行流式读取单个转录文件,凑够 maxHits 立即停止,避免整文件载入内存 */
async function searchFile(
  file: string,
  q: string,
  maxHits: number,
  radius: number
): Promise<TranscriptSearchHit[]> {
  const hits: TranscriptSearchHit[] = []
  const stream = createReadStream(file, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        continue // 异常退出可能留下截断/损坏行,跳过
      }
      const { seq, event } = entry as { seq?: unknown; event?: unknown }
      if (typeof seq !== 'number' || !event || typeof event !== 'object') continue
      for (const [role, text] of searchableTexts(event as Record<string, unknown>)) {
        const snippet = makeSnippet(text, q, radius)
        if (snippet === null) continue
        hits.push({ seq, role, snippet })
        break // 同一条消息只取一条片段
      }
      if (hits.length >= maxHits) break
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return hits
}

/** 提取一条转录事件里可搜索的文本:用户消息正文 + 助手 text 块(不含 thinking/tool) */
function* searchableTexts(
  event: Record<string, unknown>
): Generator<['user' | 'assistant', string]> {
  if (event.kind === 'user-message' && typeof event.text === 'string') {
    yield ['user', event.text]
    return
  }
  if (event.kind === 'assistant-message' && Array.isArray(event.blocks)) {
    for (const block of event.blocks) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        yield ['assistant', (block as { text: string }).text]
      }
    }
  }
}

/** 大小写不敏感定位命中,截取前后 radius 字符;截断侧加省略号,空白折叠成单个空格 */
function makeSnippet(text: string, q: string, radius: number): string | null {
  const idx = text.toLowerCase().indexOf(q)
  if (idx === -1) return null
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + q.length + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ')}${suffix}`
}
