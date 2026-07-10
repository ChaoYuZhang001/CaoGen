import {
  detectProviderFromRemoteUrl,
  gitCommit,
  gitCreatePr,
  gitDiff,
  gitMerge,
  gitPush,
  gitStatus,
  type GitCommitOperationResult,
  type GitCreatePrOperationResult,
  type GitDiffOperationResult,
  type GitMergeOperationResult,
  type GitPushOperationResult,
  type GitStatusOperationResult
} from '../../git/git-helper'
import {
  formatCodeForgeDeliveryReport,
  runCodeForgeDelivery,
  type CodeForgeDeliveryResult,
  type CodeForgeWorktreeContext
} from '../../code-forge/delivery'
import type { ToolDefinition, ToolExecResult } from './tool-types'

export const GIT_TOOL_NAMES = [
  'git_status',
  'git_diff',
  'git_commit',
  'git_push',
  'git_create_pr',
  'git_merge',
  'code_forge_delivery'
] as const

export type GitToolName = (typeof GIT_TOOL_NAMES)[number]

export interface GitToolExecutionContext {
  sessionId?: string
  worktreeContext?: CodeForgeWorktreeContext
}

const GIT_TOOL_SET = new Set<string>(GIT_TOOL_NAMES)

export function isGitToolName(name: string): name is GitToolName {
  return GIT_TOOL_SET.has(name)
}

const OPTIONAL_BRANCH_SCHEMA = {
  branch: {
    type: 'string',
    description: '可选分支名；省略时使用当前分支。不会 force push。'
  }
} satisfies Record<string, Record<string, unknown>>

export const GIT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: '查看当前 Git 状态、分支、ahead/behind、已暂存/未暂存/未跟踪/冲突文件。只读工具。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: '查看 staged 与 unstaged diff；可传 file 只看单个文件。只读工具，不包含未跟踪文件正文。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '可选仓库内相对路径或绝对路径。' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description:
        '提交已暂存改动。不会自动 git add，不会隐式执行 caogen.md 命令或 Git hooks；需要验证时先显式调用 bash。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '提交信息，不能为空。' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description:
        '显式 push 当前分支或指定分支到 remote。不会 force push，不会创建 PR；省略 branch 时使用当前分支。',
      parameters: {
        type: 'object',
        properties: OPTIONAL_BRANCH_SCHEMA
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_create_pr',
      description:
        '显式创建 GitHub PR 或 GitLab MR。不会自动 push；若远端分支不存在会要求先调用 git_push。Gitee remote 会识别但基础版不自动创建。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PR/MR 标题，不能为空。' },
          body: { type: 'string', description: 'PR/MR 正文，可为空。' },
          base: { type: 'string', description: '可选目标分支；省略时尝试使用 origin/HEAD、main、master 或 develop。' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_merge',
      description:
        '显式把指定分支合并到当前分支。要求当前工作区干净，并先做无副作用冲突预检；有冲突时不会进入半合并状态。',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: '要合并进当前分支的来源分支。' }
        },
        required: ['branch']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'code_forge_delivery',
      description:
        'Code Forge 工程交付闭环:汇总 worktree/repo diff,运行验证命令,按 report/patch/commit/pr 模式生成结构化交付报告。commit/pr 为高风险动作,必须显式提供 mode 和必要参数。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['report', 'patch', 'commit', 'pr'],
            description: '交付模式:report 只报告;patch 生成补丁;commit 提交当前 worktree/repo;pr 提交后尝试创建 PR/MR。默认 report。'
          },
          verificationCommand: { type: 'string', description: '单条验证命令,在当前 cwd/worktree 内运行。' },
          verificationCommands: {
            type: 'array',
            items: { type: 'string' },
            description: '多条验证命令,按顺序运行;任一失败则报告不可合并。'
          },
          verificationTimeoutMs: { type: 'number', description: '每条验证命令超时毫秒数,默认 180000。' },
          commitMessage: { type: 'string', description: 'commit/pr 模式的提交信息。' },
          stageAll: {
            type: 'boolean',
            description: '是否先 git add --all。默认 false;在非隔离主工作区中要谨慎使用。'
          },
          createPatch: { type: 'boolean', description: '即使 mode=report/commit 也额外生成 patch 文件。' },
          prTitle: { type: 'string', description: 'PR/MR 标题;省略时使用提交信息或默认标题。' },
          prBody: { type: 'string', description: 'PR/MR 正文。' },
          baseBranch: { type: 'string', description: 'PR/MR 目标分支。' },
          repoRoot: { type: 'string', description: '可选原仓库根目录;通常由 CaoGen managed worktree metadata 自动填充。' },
          worktreePath: { type: 'string', description: '可选 worktree 根目录;通常自动填充。' },
          baseSha: { type: 'string', description: '可选 worktree 基线 sha;通常自动填充。' },
          branch: { type: 'string', description: '可选当前 worktree/PR 分支名;通常自动填充。' }
        }
      }
    }
  }
]

export async function executeGitTool(
  name: GitToolName,
  args: Record<string, unknown>,
  cwd: string,
  context: GitToolExecutionContext = {}
): Promise<ToolExecResult> {
  switch (name) {
    case 'git_status':
      return stringifyResult(gitStatus(cwd))
    case 'git_diff':
      return stringifyResult(gitDiff(cwd, optionalString(args.file)))
    case 'git_commit':
      return stringifyResult(gitCommit(cwd, requiredString(args.message, 'message')))
    case 'git_push':
      return stringifyResult(gitPush(cwd, optionalString(args.branch)))
    case 'git_create_pr':
      return stringifyResult(
        gitCreatePr(
          cwd,
          requiredString(args.title, 'title'),
          typeof args.body === 'string' ? args.body : '',
          optionalString(args.base)
        )
      )
    case 'git_merge':
      return stringifyResult(gitMerge(cwd, requiredString(args.branch, 'branch')))
    case 'code_forge_delivery':
      return stringifyCodeForgeResult(runCodeForgeDelivery({
        cwd,
        mode: deliveryMode(args.mode),
        verificationCommand: optionalString(args.verificationCommand),
        verificationCommands: stringArray(args.verificationCommands),
        verificationTimeoutMs: optionalNumber(args.verificationTimeoutMs),
        commitMessage: optionalString(args.commitMessage),
        stageAll: typeof args.stageAll === 'boolean' ? args.stageAll : undefined,
        createPatch: typeof args.createPatch === 'boolean' ? args.createPatch : undefined,
        prTitle: optionalString(args.prTitle),
        prBody: optionalString(args.prBody),
        baseBranch: optionalString(args.baseBranch),
        repoRoot: optionalString(args.repoRoot),
        worktreePath: optionalString(args.worktreePath),
        baseSha: optionalString(args.baseSha),
        branch: optionalString(args.branch),
        worktreeContext: {
          ...context.worktreeContext,
          sessionId: context.worktreeContext?.sessionId ?? context.sessionId
        }
      }))
  }
}

export function formatGitResult(
  result:
    | GitStatusOperationResult
    | GitDiffOperationResult
    | GitCommitOperationResult
    | GitPushOperationResult
    | GitCreatePrOperationResult
    | GitMergeOperationResult
    | CodeForgeDeliveryResult
): string {
  return JSON.stringify(result, null, 2)
}

export function gitRemoteProvider(url: string): string {
  return detectProviderFromRemoteUrl(url)
}

function stringifyResult(
  result:
    | GitStatusOperationResult
    | GitDiffOperationResult
    | GitCommitOperationResult
    | GitPushOperationResult
    | GitCreatePrOperationResult
    | GitMergeOperationResult
): ToolExecResult {
  return { ok: result.ok, output: formatGitResult(result) }
}

function stringifyCodeForgeResult(result: CodeForgeDeliveryResult): ToolExecResult {
  return { ok: result.ok, output: formatCodeForgeDeliveryReport(result) }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空`)
  return value.trim()
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return items.length > 0 ? items.map((item) => item.trim()) : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function deliveryMode(value: unknown): 'report' | 'patch' | 'commit' | 'pr' | undefined {
  return value === 'report' || value === 'patch' || value === 'commit' || value === 'pr'
    ? value
    : undefined
}
