import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 定位 CLI 为某会话写的 transcript(~/.claude/projects/<cwd编码>/<sdkSessionId>.jsonl)。
 * 用 sdkSessionId 在所有 project 目录里查,绕开 cwd 路径编码 / macOS /private 符号链接问题。
 */
function transcriptPath(sdkSessionId: string): string | null {
  if (!sdkSessionId) return null
  const root = join(homedir(), '.claude', 'projects')
  try {
    for (const proj of readdirSync(root)) {
      const p = join(root, proj, `${sdkSessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // projects 目录不存在
  }
  return null
}

/**
 * 从 CLI transcript 提取用户"文本消息"的 uuid(检查点回退锚点)。
 * 用户 prompt 不在 SDK 事件流里,但会落到 transcript;文件检查点挂在这些 uuid 上。
 * 返回按出现顺序的 uuid 列表(每轮一个),最后一个即最新一轮。
 */
export function userTextMessageUuids(sdkSessionId: string): string[] {
  const path = transcriptPath(sdkSessionId)
  if (!path) return []
  const out: string[] = []
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let o: Record<string, unknown>
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (o.type !== 'user' || typeof o.uuid !== 'string') continue
      const content = (o.message as Record<string, unknown> | undefined)?.content
      // 含文本块 = 用户键入的 prompt(排除 tool_result 类 user 消息)
      const hasText =
        Array.isArray(content) &&
        content.some((b) => (b as Record<string, unknown> | null)?.type === 'text')
      if (hasText) out.push(o.uuid)
    }
  } catch {
    // 读不了
  }
  return out
}

/** 最新一轮用户文本消息的 uuid(本轮检查点锚点) */
export function latestUserTextUuid(sdkSessionId: string): string | null {
  const all = userTextMessageUuids(sdkSessionId)
  return all.length > 0 ? all[all.length - 1] : null
}
