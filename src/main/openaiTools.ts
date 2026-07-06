import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/**
 * OpenAI 引擎的原生工具集(让任何 Chat Completions 模型在 CaoGen 里
 * 成为真编码 Agent,而非聊天窗)。五个核心工具:bash / read_file /
 * write_file / edit_file / list_dir。
 *
 * 安全边界:
 * - 文件操作限定在会话 cwd 内(路径牢笼,拒绝逃逸)
 * - bash 在会话 cwd 执行,120s 超时,输出截断
 * - 权限审批由引擎层按 permissionMode 决定,这里只负责执行
 */

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolExecResult {
  ok: boolean
  output: string
}

const READ_MAX_BYTES = 200 * 1024
const BASH_TIMEOUT_MS = 120_000
const OUTPUT_MAX_CHARS = 24_000
const LIST_MAX_ENTRIES = 500

/** Chat Completions 工具声明(发给模型的 schema) */
export const OPENAI_CODING_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        '在会话工作目录执行 shell 命令并返回 stdout/stderr/退出码。用于构建、测试、git、安装依赖等。120 秒超时。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作目录内一个文本文件的内容(最大 200KB)。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对或绝对路径(须在工作目录内)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建或整体覆盖工作目录内的一个文件(自动创建父目录)。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: '完整文件内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '精确字符串替换编辑文件:old_string 必须在文件中恰好出现一次(含缩进),将被替换为 new_string。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出工作目录内某个目录的条目(目录带 / 后缀,最多 500 条)。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "相对路径,默认 '.'" }
        }
      }
    }
  }
]

/** 只读工具(plan 模式仅放行这些;default 模式免审批) */
export const READONLY_TOOLS = new Set(['read_file', 'list_dir'])
/** 文件写入类(acceptEdits 模式自动放行) */
export const EDIT_TOOLS = new Set(['write_file', 'edit_file'])

/**
 * Responses API 的工具 schema(扁平形态:type/name/description/parameters 平铺,
 * 无 Chat Completions 的嵌套 function 对象)。由 OPENAI_CODING_TOOLS 派生,单一事实源。
 */
export const RESPONSES_CODING_TOOLS: Array<Record<string, unknown>> = OPENAI_CODING_TOOLS.map((t) => ({
  type: 'function',
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters
}))

/** 路径牢笼:解析到 cwd 内的绝对路径;逃逸则抛错 */
function jail(cwd: string, rawPath: string): string {
  const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath)
  const rel = relative(resolve(cwd), target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界:${rawPath} 不在会话工作目录内`)
  }
  return target
}

function clip(text: string): string {
  return text.length > OUTPUT_MAX_CHARS
    ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n… [截断,共 ${text.length} 字符]`
    : text
}

/** 执行一个工具调用;所有异常转为 ok:false 文本,绝不抛出打断 Agent 循环 */
export async function executeCodingTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string
): Promise<ToolExecResult> {
  try {
    switch (name) {
      case 'bash':
        return await runBash(String(args.command ?? ''), cwd)
      case 'read_file': {
        const p = jail(cwd, String(args.path ?? ''))
        const stat = statSync(p)
        if (stat.size > READ_MAX_BYTES) {
          return { ok: false, output: `文件过大(${stat.size} 字节 > ${READ_MAX_BYTES}),请用 bash 工具分段查看` }
        }
        return { ok: true, output: clip(readFileSync(p, 'utf8')) }
      }
      case 'write_file': {
        const p = jail(cwd, String(args.path ?? ''))
        mkdirSync(dirname(p), { recursive: true })
        const content = String(args.content ?? '')
        writeFileSync(p, content, 'utf8')
        return { ok: true, output: `已写入 ${args.path}(${Buffer.byteLength(content)} 字节)` }
      }
      case 'edit_file': {
        const p = jail(cwd, String(args.path ?? ''))
        const oldStr = String(args.old_string ?? '')
        const newStr = String(args.new_string ?? '')
        if (!oldStr) return { ok: false, output: 'old_string 不能为空' }
        const content = readFileSync(p, 'utf8')
        const first = content.indexOf(oldStr)
        if (first === -1) return { ok: false, output: 'old_string 未在文件中找到(注意缩进/空白需完全一致)' }
        if (content.indexOf(oldStr, first + 1) !== -1) {
          return { ok: false, output: 'old_string 出现多次,请提供更长的唯一上下文' }
        }
        writeFileSync(p, content.slice(0, first) + newStr + content.slice(first + oldStr.length), 'utf8')
        return { ok: true, output: `已编辑 ${args.path}` }
      }
      case 'list_dir': {
        const p = jail(cwd, String(args.path ?? '.'))
        const entries = readdirSync(p, { withFileTypes: true })
          .slice(0, LIST_MAX_ENTRIES)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        return { ok: true, output: entries.join('\n') || '(空目录)' }
      }
      default:
        return { ok: false, output: `未知工具: ${name}` }
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) }
  }
}

function runBash(command: string, cwd: string): Promise<ToolExecResult> {
  if (!command.trim()) return Promise.resolve({ ok: false, output: '命令不能为空' })
  return new Promise((resolvePromise) => {
    execFile(
      process.platform === 'win32' ? 'cmd' : '/bin/sh',
      process.platform === 'win32' ? ['/c', command] : ['-c', command],
      { cwd, timeout: BASH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err
            ? 1
            : 0
        const out = [stdout, stderr ? `[stderr]\n${stderr}` : '', err && code !== 0 ? `[exit ${code}]` : '']
          .filter(Boolean)
          .join('\n')
          .trim()
        resolvePromise({ ok: !err, output: clip(out || '(无输出)') })
      }
    )
  })
}
