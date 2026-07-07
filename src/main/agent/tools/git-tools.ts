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
import type { ToolDefinition, ToolExecResult } from '../../openaiTools'

export const GIT_TOOL_NAMES = [
  'git_status',
  'git_diff',
  'git_commit',
  'git_push',
  'git_create_pr',
  'git_merge'
] as const

export type GitToolName = (typeof GIT_TOOL_NAMES)[number]

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
        '提交已暂存改动。不会自动 git add；提交前会读取 caogen.md/.caogen.md 的“常用命令”并运行 lint/test，失败则阻止提交。',
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
  }
]

export async function executeGitTool(
  name: GitToolName,
  args: Record<string, unknown>,
  cwd: string
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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空`)
  return value.trim()
}
