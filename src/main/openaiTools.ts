import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  runSandboxedCommand,
  writeTextFileWithSandbox,
  type SandboxCommandResult,
  type SandboxFileWritePrecondition,
  type SandboxMode
} from './sandbox/docker-sandbox'
import {
  formatSearchReplaceResult,
  runExactFileEdit,
  runSearchReplace,
  searchReplacementArgs
} from './agent/tools/search-replace'
import { GUI_TOOLS, executeGuiTool, isGuiToolName } from './agent/tools/gui-tools'
import { formatViewResult, runView } from './agent/tools/view'
import { formatSearchSymbolResult, runSearchSymbol } from './agent/tools/search-symbol'
import { formatSearchCodeResult, runSearchCode } from './agent/tools/search-code'
import { formatFindFileResult, runFindFile } from './agent/tools/find-file'
import { formatDependenciesResult, runGetDependencies } from './agent/tools/get-dependencies'
import { GIT_TOOLS, executeGitTool, isGitToolName } from './agent/tools/git-tools'
import { BROWSER_TOOLS, executeBrowserTool, isBrowserToolName } from './agent/tools/browser-tools'
import { P2_TOOLS, executeP2Tool, isP2ToolName } from './agent/tools/p2-tools'
import { clipToolOutput } from './agent/tool-output'
import type { CodeForgeWorktreeContext } from './code-forge/delivery'
import {
  GENESIS_ORCHESTRATE_TOOL_NAME,
  buildGenesisOrchestration,
  formatGenesisOrchestrationReport,
  type GenesisOrchestrationInput
} from './genesis/orchestrator'
import { resolveExistingProjectPathSync, resolveWritableProjectPathSync } from './utils/safe-project-path'
import { OPENAI_PERMISSION_READ_ONLY_TOOLS } from './task/tool-idempotency'
import { SkillManager } from './skill/skill-manager'
import { addMemory, searchMemories, type MemoryLayer } from './memory/memory-manager'
import {
  builtinMcpServerTemplates,
  callMcpTool,
  discoverMcpServer,
  loadClaudeDesktopMcpServers,
  type McpServerConfig,
  type McpTransport
} from './mcp/mcp-client'
import type {
  EngineKind,
  EffectTarget,
  PermissionModeId,
  TaskDag,
  TaskDagDispatchInput,
  TaskDagDispatchResult,
  TaskDecomposeInput,
  TaskDecomposeResult
} from '../shared/types'

/**
 * OpenAI 引擎的原生工具集(让任何 Chat Completions 模型在 CaoGen 里
 * 成为真编码 Agent,而非聊天窗)。核心工具覆盖 bash / view / read_file /
 * write_file / search_replace / edit_file / list_dir。
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
  sandboxMode?: SandboxMode
  modeUsed?: SandboxMode
  sandboxed?: boolean
  fallbackReason?: string
}

export interface ToolExecutionOptions {
  signal?: AbortSignal
  sandboxMode?: SandboxMode
  dockerImage?: string
  dockerBinary?: string
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
  dockerRegistryMirror?: string
  sessionId?: string
  worktreeContext?: CodeForgeWorktreeContext
  effectTarget?: EffectTarget
}

const READ_MAX_BYTES = 200 * 1024
const BASH_TIMEOUT_MS = 120_000
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
      name: 'view',
      description:
        '按行号查看工作目录内的文本文件片段,默认最多 200 行并带行号。会跳过二进制、压缩、source map、lockfile 和压缩生成文件。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '目标文件绝对路径或工作目录内相对路径' },
          start_line: { type: 'number', description: '起始行号,默认 1' },
          end_line: { type: 'number', description: '结束行号;未提供时读取 start_line 起 200 行' }
        },
        required: ['file_path']
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
      name: 'search_replace',
      description:
        '精准字符串替换工具。优先用它修改已有文件:old_str 必须包含足够上下文并唯一匹配;可批量替换、dry_run 预览 diff,写入前自动备份到 .caogen/tmp/backup。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '目标文件绝对路径或工作目录内相对路径' },
          replacements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                old_str: { type: 'string', description: '要替换的原字符串,必须包含至少前后 3 行上下文以保证唯一匹配' },
                new_str: { type: 'string', description: '替换后的字符串' },
                replace_all: { type: 'boolean', description: '是否替换所有匹配项,默认 false' }
              },
              required: ['old_str', 'new_str']
            }
          },
          dry_run: { type: 'boolean', description: '仅预览 Diff 不实际修改,默认 false' }
        },
        required: ['file_path', 'replacements']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '兼容旧工具:精确字符串替换编辑文件。新任务应优先使用 search_replace,只有旧模型调用时才使用本工具。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: '是否替换所有精确匹配项,默认 false' }
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
  },
  {
    type: 'function',
    function: {
      name: 'search_symbol',
      description:
        '搜索项目索引中的函数、类、接口、方法、常量、类型或导出项,返回定义文件、行号和签名。开始修改前优先用它定位相关符号。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '符号名或部分名称' },
          kind: { type: 'string', description: '可选:function/class/interface/method/constant/type/export' },
          limit: { type: 'number', description: '返回数量上限,默认 20,最大 100' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description:
        '基于 ripgrep 的项目全文代码搜索,返回匹配文件、行号和片段;rg 不可用时自动使用索引降级搜索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的字符串' },
          glob: { type: 'string', description: '可选 glob,例如 src/**/*.ts' },
          limit: { type: 'number', description: '返回数量上限,默认 20,最大 100' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_file',
      description: '按文件名或路径片段在项目索引中模糊查找文件。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '文件名或路径片段' },
          limit: { type: 'number', description: '返回数量上限,默认 20,最大 100' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dependencies',
      description: '查看一个文件的正向依赖、反向依赖和外部导入,修改前用它判断影响范围。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '目标文件绝对路径或工作目录内相对路径' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_decompose',
      description:
        '将复杂自然语言需求拆解为有依赖关系的 DAG 子任务。只生成计划,不启动子 Agent。复杂/跨模块需求应先调用它。',
      parameters: {
        type: 'object',
        properties: {
          request: { type: 'string', description: '用户原始需求或需要拆解的复杂任务' },
          useModel: { type: 'boolean', description: '是否允许使用强推理模型拆解;默认 true' },
          cwd: { type: 'string', description: '可选项目目录;默认当前会话项目' },
          providerId: { type: 'string', description: '可选:指定拆解模型 Provider' },
          model: { type: 'string', description: '可选:指定拆解模型' }
        },
        required: ['request']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: GENESIS_ORCHESTRATE_TOOL_NAME,
      description:
        '生成 Genesis 编排计划/执行报告:任务拆解、worker lanes、隔离 worktree 策略、验证 gates、风险/人工确认点和 Code Forge 交付策略。第一版只规划,不启动外部 Agent、不创建 worktree、不提交/推送。',
      parameters: {
        type: 'object',
        properties: {
          request: { type: 'string', description: '用户原始复杂任务或需要 Genesis 编排的目标' },
          cwd: { type: 'string', description: '可选项目目录;默认当前会话项目' },
          driveMode: { type: 'string', enum: ['spark', 'core', 'forge', 'command', 'genesis'] },
          validationCommands: {
            type: 'array',
            items: { type: 'string' },
            description: '计划中的验证命令;未传时从 package.json 推断 typecheck/build/test gates'
          },
          deliveryMode: {
            type: 'string',
            enum: ['report', 'patch', 'commit', 'pr'],
            description: '计划推荐的 Code Forge 交付模式;默认 report。只写入计划,不执行交付。'
          },
          maxWorkerLanes: { type: 'number', description: '计划生成的 worker lane 上限,默认 8,最大 12' },
          isolationRoot: { type: 'string', description: '计划中的隔离 worktree 根目录;不会实际创建' },
          requireHumanConfirmation: { type: 'boolean', description: '是否强制在报告中列出人工确认 gate' }
        },
        required: ['request']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_dispatch_dag',
      description:
        '按给定 DAG 启动多 Agent 依赖调度。会创建 child sessions/worktrees 并开始执行;需要用户授权后再调用。',
      parameters: {
        type: 'object',
        properties: {
          dag: { type: 'object', description: 'task_decompose 返回的 dag 对象' },
          cwd: { type: 'string', description: '可选项目目录;默认当前会话项目' },
          isolated: { type: 'boolean', description: '是否使用独立 Git worktree;默认 true' },
          model: { type: 'string', description: '可选:子 Agent 模型' },
          providerId: { type: 'string', description: '可选:子 Agent Provider' },
          engine: { type: 'string', enum: ['claude', 'openai'] },
          permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
          maxRetries: { type: 'number', description: '每个子任务失败后的最大重试次数,默认 2,最大 5' },
          taskTimeoutMs: { type: 'number', description: '单个子任务运行超时毫秒数;默认 20 分钟,<=0 关闭超时' },
          autoMerge: { type: 'boolean', description: '是否在 DAG 成功后自动合并 worktree;默认 false' },
          verificationCommand: { type: 'string', description: '自动合并后的验收命令' }
        },
        required: ['dag']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_decompose_and_dispatch_dag',
      description:
        '一站式拆解并启动 DAG 多 Agent 调度。适合用户明确要求并行推进的复杂任务;会创建 child sessions/worktrees。',
      parameters: {
        type: 'object',
        properties: {
          request: { type: 'string', description: '用户原始需求或需要拆解的复杂任务' },
          useModel: { type: 'boolean', description: '是否允许使用强推理模型拆解;默认 true' },
          cwd: { type: 'string', description: '可选项目目录;默认当前会话项目' },
          isolated: { type: 'boolean', description: '是否使用独立 Git worktree;默认 true' },
          model: { type: 'string', description: '可选:拆解和子 Agent 模型' },
          providerId: { type: 'string', description: '可选:拆解和子 Agent Provider' },
          engine: { type: 'string', enum: ['claude', 'openai'] },
          permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
          maxRetries: { type: 'number', description: '每个子任务失败后的最大重试次数,默认 2,最大 5' },
          taskTimeoutMs: { type: 'number', description: '单个子任务运行超时毫秒数;默认 20 分钟,<=0 关闭超时' },
          autoMerge: { type: 'boolean', description: '是否在 DAG 成功后自动合并 worktree;默认 false' },
          verificationCommand: { type: 'string', description: '自动合并后的验收命令' }
        },
        required: ['request']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: '列出当前项目和用户目录可用的结构化 Skill，可按 query 匹配最相关能力。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选，按任务描述匹配 Skill' },
          limit: { type: 'number', description: '返回数量上限，默认 12' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '读取一个结构化 Skill 的完整定义、步骤、触发词和验证说明。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id 或名称' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_skill',
      description: '按用户确认执行一个结构化 Skill。未传 confirmed=true 时只返回待确认步骤。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id 或名称' },
          confirmed: { type: 'boolean', description: '用户确认后设为 true' },
          parameters: { type: 'object', description: '可选执行参数' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: '检索 CaoGen 三层记忆(working/project/user)，用于恢复约定、偏好和项目事实。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索文本' },
          layers: {
            type: 'array',
            items: { type: 'string', enum: ['working', 'project', 'user'] },
            description: '可选层级，默认三层都查'
          },
          limit: { type: 'number', description: '返回数量上限，默认 8' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_add',
      description: '写入 CaoGen 三层记忆。该操作会持久化内容，应只记录稳定事实、偏好或明确约定。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', enum: ['working', 'project', 'user'] },
          title: { type: 'string' },
          body: { type: 'string' },
          source: { type: 'string', description: '来源说明，例如 session/user-confirmed' },
          tags: { type: 'array', items: { type: 'string' } }
        },
        required: ['layer', 'title', 'body', 'source']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_discover',
      description: '按给定 stdio、HTTP 或 SSE MCP server 配置执行 initialize，并发现 tools/resources/prompts。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'stdio server 命令' },
          args: { type: 'array', items: { type: 'string' } },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          url: { type: 'string', description: 'HTTP JSON-RPC 或 SSE endpoint' },
          transport: { type: 'string', enum: ['stdio', 'http', 'sse'] },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          timeoutMs: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_call_tool',
      description: '调用一个 MCP tool。需要传入 MCP server 配置、tool 名称和 arguments。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          url: { type: 'string' },
          transport: { type: 'string', enum: ['stdio', 'http', 'sse'] },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          toolName: { type: 'string' },
          arguments: { type: 'object' },
          timeoutMs: { type: 'number' }
        },
        required: ['toolName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_builtin_servers',
      description: '列出 CaoGen 内置的常用 MCP server 配置模板，供用户确认后启用。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_import_claude_desktop',
      description: '读取 Claude Desktop 的 claude_desktop_config.json，并导入其中的 MCP server 配置。',
      parameters: {
        type: 'object',
        properties: {
          configPath: { type: 'string', description: '可选，Claude Desktop 配置文件路径；默认使用系统标准路径' }
        }
      }
    }
  },
  ...GIT_TOOLS,
  ...BROWSER_TOOLS,
  ...P2_TOOLS,
  ...GUI_TOOLS
]

/** 只读工具(plan 模式仅放行这些;default 模式免审批) */
export const READONLY_TOOLS = OPENAI_PERMISSION_READ_ONLY_TOOLS
/** 文件写入类(acceptEdits 模式自动放行) */
export const EDIT_TOOLS = new Set(['write_file', 'search_replace', 'edit_file'])

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

/** 路径牢笼:解析到 cwd 内的真实路径;拒绝 symlink/junction 逃逸。 */
function jailExisting(cwd: string, rawPath: string): string {
  return resolveExistingProjectPathSync(cwd, rawPath).fullPath
}

function jailWritable(cwd: string, rawPath: string): string {
  return resolveWritableProjectPathSync(cwd, rawPath).fullPath
}

function clip(text: string): string {
  return clipToolOutput(text)
}

function stringArg(args: Record<string, unknown>, primary: string, fallback?: string): string {
  const first = args[primary]
  if (typeof first === 'string' && first.trim()) return first
  if (fallback) {
    const second = args[fallback]
    if (typeof second === 'string' && second.trim()) return second
  }
  throw new Error(`${primary} 不能为空`)
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}

function memoryLayersArg(value: unknown): MemoryLayer[] | undefined {
  const items = stringArrayArg(value)
  if (!items) return undefined
  const allowed = new Set<MemoryLayer>(['working', 'project', 'user'])
  return items.filter((item): item is MemoryLayer => allowed.has(item as MemoryLayer))
}

function recordArg(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function stringRecordArg(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((item): item is [string, string] => typeof item[1] === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function mcpTransportArg(value: unknown): McpTransport | undefined {
  return value === 'stdio' || value === 'http' || value === 'sse' ? value : undefined
}

function memoryRoot(): string {
  return process.env.CAOGEN_MEMORY_DIR || resolve(homedir(), '.caogen', 'memory')
}

function mcpConfigArg(args: Record<string, unknown>): McpServerConfig {
  return {
    command: optionalStringArg(args.command),
    args: stringArrayArg(args.args),
    env: stringRecordArg(args.env),
    url: optionalStringArg(args.url),
    transport: mcpTransportArg(args.transport),
    headers: stringRecordArg(args.headers)
  }
}

function engineArg(value: unknown): EngineKind | undefined {
  return value === 'claude' || value === 'openai' ? value : undefined
}

function permissionModeArg(value: unknown): PermissionModeId | undefined {
  return value === 'default' || value === 'acceptEdits' || value === 'plan' || value === 'bypassPermissions'
    ? value
    : undefined
}

function sessionIdArg(options: ToolExecutionOptions): string {
  if (typeof options.sessionId === 'string' && options.sessionId.trim()) return options.sessionId
  throw new Error('DAG 任务工具需要当前 sessionId')
}

function taskDagArg(value: unknown): TaskDag {
  const record = recordArg(value)
  const tasks = record.tasks
  if (typeof record.id !== 'string' || !record.id.trim()) throw new Error('dag.id 不能为空')
  if (typeof record.title !== 'string' || !record.title.trim()) throw new Error('dag.title 不能为空')
  if (typeof record.source !== 'string') throw new Error('dag.source 必须是字符串')
  if (record.complexity !== 'single' && record.complexity !== 'multi') {
    throw new Error('dag.complexity 必须是 single 或 multi')
  }
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) {
    throw new Error('dag.createdAt 必须是数字时间戳')
  }
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('dag.tasks 至少需要一个任务')
  return record as unknown as TaskDag
}

function decomposeInputArgs(args: Record<string, unknown>, cwd: string): TaskDecomposeInput {
  const input: TaskDecomposeInput = {
    request: stringArg(args, 'request'),
    cwd: optionalStringArg(args.cwd) ?? cwd
  }
  if (typeof args.useModel === 'boolean') input.useModel = args.useModel
  const providerId = optionalStringArg(args.providerId)
  if (providerId) input.providerId = providerId
  const model = optionalStringArg(args.model)
  if (model) input.model = model
  return input
}

function dagDispatchInputArgs(args: Record<string, unknown>, dag: TaskDag, cwd: string): TaskDagDispatchInput {
  const input: TaskDagDispatchInput = {
    dag,
    cwd: optionalStringArg(args.cwd) ?? cwd
  }
  if (typeof args.isolated === 'boolean') input.isolated = args.isolated
  const model = optionalStringArg(args.model)
  if (model) input.model = model
  const providerId = optionalStringArg(args.providerId)
  if (providerId) input.providerId = providerId
  const engine = engineArg(args.engine)
  if (engine) input.engine = engine
  const permissionMode = permissionModeArg(args.permissionMode)
  if (permissionMode) input.permissionMode = permissionMode
  const maxRetries = numberArg(args.maxRetries)
  if (maxRetries !== undefined) input.maxRetries = maxRetries
  const taskTimeoutMs = numberArg(args.taskTimeoutMs)
  if (taskTimeoutMs !== undefined) input.taskTimeoutMs = taskTimeoutMs
  if (typeof args.autoMerge === 'boolean') input.autoMerge = args.autoMerge
  const verificationCommand = optionalStringArg(args.verificationCommand)
  if (verificationCommand) input.verificationCommand = verificationCommand
  return input
}

function genesisInputArgs(args: Record<string, unknown>, cwd: string): GenesisOrchestrationInput {
  const input: GenesisOrchestrationInput = {
    request: stringArg(args, 'request'),
    cwd: optionalStringArg(args.cwd) ?? cwd
  }
  const driveMode = genesisDriveModeArg(args.driveMode)
  if (driveMode) input.driveMode = driveMode
  const validationCommands = stringArrayArg(args.validationCommands)
  if (validationCommands) input.validationCommands = validationCommands
  const deliveryMode = genesisDeliveryModeArg(args.deliveryMode)
  if (deliveryMode) input.deliveryMode = deliveryMode
  const maxWorkerLanes = numberArg(args.maxWorkerLanes)
  if (maxWorkerLanes !== undefined) input.maxWorkerLanes = maxWorkerLanes
  const isolationRoot = optionalStringArg(args.isolationRoot)
  if (isolationRoot) input.isolationRoot = isolationRoot
  if (typeof args.requireHumanConfirmation === 'boolean') {
    input.requireHumanConfirmation = args.requireHumanConfirmation
  }
  return input
}

function genesisDriveModeArg(value: unknown): GenesisOrchestrationInput['driveMode'] | undefined {
  return value === 'spark' || value === 'core' || value === 'forge' || value === 'command' || value === 'genesis'
    ? value
    : undefined
}

function genesisDeliveryModeArg(value: unknown): GenesisOrchestrationInput['deliveryMode'] | undefined {
  return value === 'report' || value === 'patch' || value === 'commit' || value === 'pr' ? value : undefined
}

async function loadSessionManager() {
  const specifier = './sessionManager.js'
  return (await import(specifier) as { sessionManager: {
    decomposeTask(parentSessionId: string, input: TaskDecomposeInput): Promise<TaskDecomposeResult>
    dispatchTaskDag(parentSessionId: string, input: TaskDagDispatchInput): TaskDagDispatchResult
  } }).sessionManager
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 执行一个工具调用;所有异常转为 ok:false 文本,绝不抛出打断 Agent 循环 */
export async function executeCodingTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  options: ToolExecutionOptions = {}
): Promise<ToolExecResult> {
  try {
    if (options.signal?.aborted) return { ok: false, output: '操作已中断' }
    if (isBrowserToolName(name)) return clipExecResult(await executeBrowserTool(name, args, options.sessionId))
    if (isGuiToolName(name)) return clipExecResult(await executeGuiTool(name, args, cwd))
    if (isGitToolName(name)) {
      return clipExecResult(await executeGitTool(name, args, cwd, {
        sessionId: options.sessionId,
        worktreeContext: options.worktreeContext,
        effectTarget: options.effectTarget
      }))
    }
    if (isP2ToolName(name)) return clipExecResult(await executeP2Tool(name, args, cwd))
    switch (name) {
      case 'bash':
        return await runBash(String(args.command ?? ''), cwd, options)
      case 'read_file': {
        const p = jailExisting(cwd, String(args.path ?? ''))
        const stat = statSync(p)
        if (stat.size > READ_MAX_BYTES) {
          return { ok: false, output: `文件过大(${stat.size} 字节 > ${READ_MAX_BYTES}),请用 bash 工具分段查看` }
        }
        return { ok: true, output: clip(readFileSync(p, 'utf8')) }
      }
      case 'view': {
        const result = await runView(cwd, {
          file_path: stringArg(args, 'file_path', 'path'),
          start_line: numberArg(args.start_line),
          end_line: numberArg(args.end_line)
        })
        return { ok: result.ok, output: clip(formatViewResult(result)) }
      }
      case 'write_file': {
        const p = jailWritable(cwd, String(args.path ?? ''))
        const content = String(args.content ?? '')
        const guard = fileWritePrecondition(cwd, p, content, options.effectTarget)
        const writeResult = await sandboxedFileWrite(cwd, p, content, options, guard)
        return withSandboxMetadata(
          {
            ok: writeResult.ok,
            output: writeResult.ok
              ? `已写入 ${args.path}(${Buffer.byteLength(content)} 字节)\n${writeResult.output}`
              : writeResult.output
          },
          writeResult,
          options.sandboxMode
        )
      }
      case 'search_replace': {
        let writeResult: SandboxCommandResult | undefined
        const result = await runSearchReplace(cwd, {
          file_path: stringArg(args, 'file_path', 'path'),
          replacements: searchReplacementArgs(args.replacements),
          dry_run: args.dry_run === true
        }, {
          effectTarget: options.effectTarget?.kind === 'file_content' ? options.effectTarget : undefined,
          writeTextFile: async (filePath, content, guard) => {
            writeResult = await sandboxedFileWrite(cwd, filePath, content, options, guard)
            if (!writeResult.ok) throw new Error(writeResult.output)
          }
        })
        return withSandboxMetadata({ ok: result.ok, output: clip(formatSearchReplaceResult(result)) }, writeResult, options.sandboxMode)
      }
      case 'edit_file': {
        if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
          return { ok: false, output: 'edit_file 的 old_string 与 new_string 必须是字符串' }
        }
        if (args.replace_all !== undefined && typeof args.replace_all !== 'boolean') {
          return { ok: false, output: 'edit_file 的 replace_all 必须是布尔值' }
        }
        const oldStr = args.old_string
        const newStr = args.new_string
        let writeResult: SandboxCommandResult | undefined
        const result = await runExactFileEdit(cwd, {
          file_path: stringArg(args, 'path', 'file_path'),
          old_string: oldStr,
          new_string: newStr,
          replace_all: args.replace_all === true
        }, {
          effectTarget: options.effectTarget?.kind === 'file_content' ? options.effectTarget : undefined,
          writeTextFile: async (filePath, content, guard) => {
            writeResult = await sandboxedFileWrite(cwd, filePath, content, options, guard)
            if (!writeResult.ok) throw new Error(writeResult.output)
          }
        })
        return withSandboxMetadata({ ok: result.ok, output: clip(formatSearchReplaceResult(result)) }, writeResult, options.sandboxMode)
      }
      case 'list_dir': {
        const p = jailExisting(cwd, String(args.path ?? '.'))
        const entries = readdirSync(p, { withFileTypes: true })
          .slice(0, LIST_MAX_ENTRIES)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        return { ok: true, output: entries.join('\n') || '(空目录)' }
      }
      case 'search_symbol': {
        const result = await runSearchSymbol(cwd, {
          name: stringArg(args, 'name'),
          kind: optionalStringArg(args.kind),
          limit: numberArg(args.limit)
        })
        return { ok: true, output: clip(formatSearchSymbolResult(result)) }
      }
      case 'search_code': {
        const result = await runSearchCode(cwd, {
          query: stringArg(args, 'query'),
          glob: optionalStringArg(args.glob),
          limit: numberArg(args.limit)
        })
        return { ok: true, output: clip(formatSearchCodeResult(result)) }
      }
      case 'find_file': {
        const result = await runFindFile(cwd, {
          pattern: stringArg(args, 'pattern'),
          limit: numberArg(args.limit)
        })
        return { ok: true, output: clip(formatFindFileResult(result)) }
      }
      case 'get_dependencies': {
        const result = await runGetDependencies(cwd, {
          file_path: stringArg(args, 'file_path', 'path')
        })
        return { ok: true, output: clip(formatDependenciesResult(result)) }
      }
      case 'task_decompose': {
        const parentSessionId = sessionIdArg(options)
        const manager = await loadSessionManager()
        const result = await manager.decomposeTask(parentSessionId, decomposeInputArgs(args, cwd))
        return { ok: true, output: clip(JSON.stringify(result, null, 2)) }
      }
      case GENESIS_ORCHESTRATE_TOOL_NAME: {
        const result = await buildGenesisOrchestration(genesisInputArgs(args, cwd))
        return { ok: true, output: clip(formatGenesisOrchestrationReport(result)) }
      }
      case 'task_dispatch_dag': {
        const parentSessionId = sessionIdArg(options)
        const manager = await loadSessionManager()
        const result = manager.dispatchTaskDag(
          parentSessionId,
          dagDispatchInputArgs(args, taskDagArg(args.dag), cwd)
        )
        return { ok: true, output: clip(JSON.stringify(result, null, 2)) }
      }
      case 'task_decompose_and_dispatch_dag': {
        const parentSessionId = sessionIdArg(options)
        const manager = await loadSessionManager()
        const decompose: TaskDecomposeResult = await manager.decomposeTask(parentSessionId, decomposeInputArgs(args, cwd))
        const dispatch = manager.dispatchTaskDag(
          parentSessionId,
          dagDispatchInputArgs(args, decompose.dag, cwd)
        )
        return { ok: true, output: clip(JSON.stringify({ decompose, dispatch }, null, 2)) }
      }
      case 'list_skills': {
        const manager = new SkillManager({ projectRoot: cwd })
        const query = optionalStringArg(args.query)
        const limit = Math.max(1, Math.min(50, Math.floor(numberArg(args.limit) ?? 12)))
        const skills = query
          ? manager.match(query, 0.1).slice(0, limit).map((match) => ({
              id: match.skill.id,
              name: match.skill.name,
              description: match.skill.description,
              score: match.score,
              tags: match.skill.tags,
              sourcePath: match.skill.sourcePath
            }))
          : manager.list().slice(0, limit).map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              tags: skill.tags,
              sourcePath: skill.sourcePath
            }))
        return { ok: true, output: clip(JSON.stringify({ skills, diagnostics: manager.diagnosticsView() }, null, 2)) }
      }
      case 'load_skill': {
        const id = stringArg(args, 'id')
        const manager = new SkillManager({ projectRoot: cwd })
        const skill =
          manager.list().find((item) => item.id === id || item.name.toLowerCase() === id.toLowerCase()) ??
          manager.match(id, 0.1)[0]?.skill
        if (!skill) return { ok: false, output: `未找到 Skill: ${id}` }
        return { ok: true, output: clip(manager.exportSkill(skill.id) ?? JSON.stringify(skill, null, 2)) }
      }
      case 'run_skill': {
        const id = stringArg(args, 'id')
        const manager = new SkillManager({ projectRoot: cwd })
        const skill =
          manager.list().find((item) => item.id === id || item.name.toLowerCase() === id.toLowerCase()) ??
          manager.match(id, 0.1)[0]?.skill
        if (!skill) return { ok: false, output: `未找到 Skill: ${id}` }
        const executionPlan = {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          steps: skill.steps,
          verification: skill.verification,
          parameters: recordArg(args.parameters)
        }
        if (args.confirmed !== true) {
          return {
            ok: false,
            output: clip(JSON.stringify({ requiresConfirmation: true, message: '需要用户确认后才能执行 Skill。', skill: executionPlan }, null, 2))
          }
        }
        return { ok: true, output: clip(JSON.stringify({ status: 'confirmed', executionPlan, body: skill.body }, null, 2)) }
      }
      case 'memory_search': {
        const hits = await searchMemories(memoryRoot(), {
          query: stringArg(args, 'query'),
          projectRoot: cwd,
          layers: memoryLayersArg(args.layers),
          limit: numberArg(args.limit)
        })
        return { ok: true, output: clip(JSON.stringify({ hits }, null, 2)) }
      }
      case 'memory_add': {
        const layer = stringArg(args, 'layer') as MemoryLayer
        if (layer !== 'working' && layer !== 'project' && layer !== 'user') {
          return { ok: false, output: `无效记忆层级: ${layer}` }
        }
        const entry = await addMemory(memoryRoot(), {
          layer,
          projectRoot: layer === 'user' ? undefined : cwd,
          title: stringArg(args, 'title'),
          body: stringArg(args, 'body'),
          source: stringArg(args, 'source'),
          tags: stringArrayArg(args.tags)
        })
        return { ok: true, output: clip(JSON.stringify(entry, null, 2)) }
      }
      case 'mcp_discover': {
        const timeoutMs = numberArg(args.timeoutMs)
        const result = await discoverMcpServer(mcpConfigArg(args), timeoutMs)
        return { ok: true, output: clip(JSON.stringify(result, null, 2)) }
      }
      case 'mcp_call_tool': {
        const timeoutMs = numberArg(args.timeoutMs)
        const result = await callMcpTool(
          mcpConfigArg(args),
          stringArg(args, 'toolName', 'name'),
          recordArg(args.arguments),
          timeoutMs
        )
        return { ok: !result.isError, output: clip(JSON.stringify(result, null, 2)) }
      }
      case 'mcp_builtin_servers':
        return { ok: true, output: clip(JSON.stringify({ servers: builtinMcpServerTemplates() }, null, 2)) }
      case 'mcp_import_claude_desktop': {
        const result = await loadClaudeDesktopMcpServers(optionalStringArg(args.configPath))
        return { ok: true, output: clip(JSON.stringify(result, null, 2)) }
      }
      default:
        return { ok: false, output: `未知工具: ${name}` }
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) }
  }
}

function clipExecResult(result: ToolExecResult): ToolExecResult {
  return { ...result, output: clip(result.output) }
}

async function sandboxedFileWrite(
  cwd: string,
  targetPath: string,
  content: string,
  options: ToolExecutionOptions,
  guard?: SandboxFileWritePrecondition
): Promise<SandboxCommandResult> {
  return writeTextFileWithSandbox({
    cwd,
    targetPath,
    content,
    expectedFile: guard,
    mode: options.sandboxMode ?? 'loose',
    timeoutMs: BASH_TIMEOUT_MS,
    dockerImage: options.dockerImage,
    dockerBinary: options.dockerBinary,
    chinaMirrorEnabled: options.chinaMirrorEnabled,
    npmRegistry: options.npmRegistry,
    pipIndexUrl: options.pipIndexUrl,
    dockerRegistryMirror: options.dockerRegistryMirror,
    signal: options.signal
  })
}

function fileWritePrecondition(
  cwd: string,
  targetPath: string,
  content: string,
  target: EffectTarget | undefined
): SandboxFileWritePrecondition | undefined {
  if (!target) return undefined
  if (target.kind !== 'file_content') {
    throw new Error('write_file 缺少已冻结的文件效果目标')
  }
  const resolved = resolveWritableProjectPathSync(cwd, targetPath)
  if (
    target.rootPath !== resolved.root ||
    target.relativePath !== resolved.relativePath
  ) {
    throw new Error('write_file 目标路径与已批准 Effect 不一致')
  }
  if (target.rootIdentity) {
    const rootInfo = statSync(resolved.root, { bigint: true })
    if (
      rootInfo.dev.toString() !== target.rootIdentity.device ||
      rootInfo.ino.toString() !== target.rootIdentity.inode
    ) {
      throw new Error('write_file 项目根目录身份与已批准 Effect 不一致')
    }
  }
  const expected = Buffer.from(content, 'utf8')
  if (
    target.expectedBytes !== expected.byteLength ||
    target.expectedSha256 !== createHash('sha256').update(expected).digest('hex')
  ) {
    throw new Error('write_file 内容与已批准 Effect 不一致')
  }
  if (target.preState === 'absent') {
    if (!target.rootIdentity) {
      throw new Error('write_file 已批准 Effect 缺少项目根目录身份')
    }
    return {
      state: 'absent',
      rootPath: target.rootPath,
      rootIdentity: target.rootIdentity
    }
  }
  if (
    !target.preFileIdentity ||
    typeof target.preSha256 !== 'string' ||
    typeof target.preBytes !== 'number'
  ) {
    throw new Error('write_file 已批准 Effect 缺少现有文件前置条件')
  }
  return {
    state: 'file',
    identity: target.preFileIdentity,
    sha256: target.preSha256,
    bytes: target.preBytes
  }
}

function withSandboxMetadata(
  result: Pick<ToolExecResult, 'ok' | 'output'>,
  execution: SandboxCommandResult | undefined,
  sandboxMode: SandboxMode | undefined
): ToolExecResult {
  return {
    ...result,
    sandboxMode: sandboxMode ?? 'loose',
    modeUsed: execution?.modeUsed,
    sandboxed: execution?.sandboxed,
    fallbackReason: execution?.fallbackReason
  }
}

async function runBash(
  command: string,
  cwd: string,
  options: ToolExecutionOptions
): Promise<ToolExecResult> {
  if (!command.trim()) return { ok: false, output: '命令不能为空' }
  const sandboxMode = options.sandboxMode ?? 'loose'
  const result = await runSandboxedCommand({
    command,
    cwd,
    mode: sandboxMode,
    timeoutMs: BASH_TIMEOUT_MS,
    maxBufferBytes: 4 * 1024 * 1024,
    dockerImage: options.dockerImage,
    dockerBinary: options.dockerBinary,
    chinaMirrorEnabled: options.chinaMirrorEnabled,
    npmRegistry: options.npmRegistry,
    pipIndexUrl: options.pipIndexUrl,
    dockerRegistryMirror: options.dockerRegistryMirror,
    signal: options.signal
  })
  return {
    ok: result.ok,
    output: clip(result.output),
    sandboxMode,
    modeUsed: result.modeUsed,
    sandboxed: result.sandboxed,
    fallbackReason: result.fallbackReason
  }
}
