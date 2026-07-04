import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk'

/**
 * 斜杠命令后端(纯逻辑,不碰热点文件)。
 *
 * 两件事:
 *  1. listSlashCommands —— 供命令面板补全:内置命令 + SDK 会话动态命令(skills 等)。
 *  2. expandSlashCommand —— 发送时判定一条输入是不是斜杠命令、该本地处理还是转交 SDK。
 *
 * 设计取舍:
 *  - 内置命令由 CaoGen 自己实现(清空/压缩/切模型/diff/回溯/帮助),不发给 Agent。
 *  - SDK 动态命令(supportedCommands 返回的 skills 等)按原文作为 prompt 发给 Agent,
 *    由 SDK 侧解析,渲染端不需要理解其语义。
 */

/** 命令面板里展示 / 补全用的一条命令。 */
export interface SlashCommandInfo {
  name: string
  description: string
  /** 参数提示,如 "<model>";无参命令为 undefined。 */
  argHint?: string
  /** true=CaoGen 本地处理;false=转交 SDK 作为 prompt。 */
  builtin: boolean
}

/** expandSlashCommand 结果:要么本地内置处理,要么当作普通 prompt(含转交 SDK 的斜杠命令)。 */
export type SlashCommandExpansion =
  | {
      kind: 'builtin'
      /** 内置命令名(不含前导斜杠),如 "model"。 */
      name: BuiltinCommandName
      /** 命令后的参数原文(已去首尾空白);无参为空串。 */
      args: string
    }
  | {
      kind: 'prompt'
      /** 要发送给 Agent 的文本(普通消息原文,或未识别的斜杠命令原文)。 */
      text: string
    }

export type BuiltinCommandName = 'clear' | 'compact' | 'model' | 'help' | 'diff' | 'rewind'

/** 内置命令表:name 唯一且不含前导斜杠。 */
const BUILTIN_COMMANDS: readonly SlashCommandInfo[] = [
  { name: 'clear', description: '清空当前会话的聊天记录,开始新的对话', builtin: true },
  { name: 'compact', description: '压缩上下文以释放窗口,保留关键信息', argHint: '[指示]', builtin: true },
  { name: 'model', description: '切换当前会话使用的模型', argHint: '<model>', builtin: true },
  { name: 'diff', description: '查看当前工作区相对基线的改动', builtin: true },
  { name: 'rewind', description: '回溯到较早的检查点(撤销文件改动)', builtin: true },
  { name: 'help', description: '列出可用的斜杠命令', builtin: true }
]

const BUILTIN_NAMES = new Set<string>(BUILTIN_COMMANDS.map((c) => c.name))

/** 结构化最小接口:任何暴露 supportedCommands() 的对象即可,避免与具体 SDK Query 类型强耦合。 */
export interface SupportsSlashCommands {
  supportedCommands?: () => Promise<SlashCommand[]>
}

/**
 * 列出与 query 前缀/子串匹配的斜杠命令。
 * 内置命令始终参与;若传入的会话 query 暴露 supportedCommands(),则合并其动态命令(如 skills)。
 * 合并策略:内置优先,动态命令中与内置重名者跳过;supportedCommands() 抛错则静默忽略(仅回内置)。
 *
 * @param query 用户在 "/" 后输入的过滤词(可含前导斜杠,会被剥离);空串返回全部。
 * @param sessionQuery 可选的当前会话 SDK query,用于取动态命令。
 */
export async function listSlashCommands(
  query: string,
  sessionQuery?: SupportsSlashCommands | null
): Promise<SlashCommandInfo[]> {
  const merged: SlashCommandInfo[] = [...BUILTIN_COMMANDS]

  if (sessionQuery?.supportedCommands) {
    try {
      const dynamic = await sessionQuery.supportedCommands()
      for (const cmd of dynamic ?? []) {
        if (!cmd?.name || BUILTIN_NAMES.has(cmd.name)) continue
        merged.push({
          name: cmd.name,
          description: cmd.description ?? '',
          argHint: cmd.argumentHint ? cmd.argumentHint : undefined,
          builtin: false
        })
      }
    } catch {
      // 会话未就绪 / SDK 不支持:仅返回内置命令
    }
  }

  const q = normalizeQuery(query)
  const filtered = q ? merged.filter((c) => matches(c.name, q)) : merged
  // 前缀命中优先,其次按名字长度(更短更接近),同名再按字典序稳定
  return filtered.sort((a, b) => {
    const ap = a.name.startsWith(q) ? 0 : 1
    const bp = b.name.startsWith(q) ? 0 : 1
    if (ap !== bp) return ap - bp
    if (a.name.length !== b.name.length) return a.name.length - b.name.length
    return a.name.localeCompare(b.name)
  })
}

/**
 * 判定一条发送输入如何处理。
 *  - 不以 "/" 开头 → 普通消息(kind:"prompt")。
 *  - "/<builtin> [args]" → 本地内置处理(kind:"builtin")。
 *  - 其他以 "/" 开头(未识别的斜杠命令,如 skill)→ 原文转交 SDK(kind:"prompt")。
 * 注意:仅裁决路由,不执行命令;内置命令的实际动作由调用方(主控接线)完成。
 */
export function expandSlashCommand(input: string): SlashCommandExpansion {
  const text = input ?? ''
  const trimmedStart = text.replace(/^\s+/, '')
  if (!trimmedStart.startsWith('/')) {
    return { kind: 'prompt', text }
  }
  // 取第一段作为命令名(斜杠后到首个空白),其余为参数
  const body = trimmedStart.slice(1)
  const match = body.match(/^(\S+)\s*([\s\S]*)$/)
  const name = (match?.[1] ?? '').toLowerCase()
  const args = (match?.[2] ?? '').trim()
  if (name && BUILTIN_NAMES.has(name)) {
    return { kind: 'builtin', name: name as BuiltinCommandName, args }
  }
  // 未识别的斜杠命令:交给 SDK 解析,保留原文(含斜杠与参数)
  return { kind: 'prompt', text }
}

/** 剥离前导斜杠并归一化为小写去空白,供过滤匹配。 */
function normalizeQuery(query: string): string {
  return (query ?? '').trim().replace(/^\/+/, '').toLowerCase()
}

/** 前缀或子串命中即可 */
function matches(name: string, q: string): boolean {
  const n = name.toLowerCase()
  return n.startsWith(q) || n.includes(q)
}

/** 只读的内置命令列表(供需要静态展示的调用方复用)。 */
export function builtinSlashCommands(): SlashCommandInfo[] {
  return [...BUILTIN_COMMANDS]
}
