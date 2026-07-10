import { listProviders } from '../../providers'
import { draftSkillFromSummary } from '../../skill/skill-learner'
import { recordSkillFeedback, type SkillFeedbackOutcome } from '../../skill/skill-optimizer'
import { routeModel } from '../../model/model-router'
import { sendFeishuNotification } from '../../notification/feishu'
import { sendDingTalkNotification } from '../../notification/dingtalk'
import { sendWeComNotification } from '../../notification/wecom'
import {
  buildGiteeIssueUrl,
  buildGiteePullRequestUrl,
  sendGiteeIssue,
  sendGiteePullRequest
} from './gitee-tools'
import type { ProviderView, SchedulerStrategy } from '../../../shared/types'
import type { ModelTaskKind } from '../../model/model-profile'
import type { ToolDefinition } from './tool-types'

export const P2_TOOL_NAMES = ['draft_skill', 'optimize_skill', 'route_model', 'china_notify', 'gitee_prepare'] as const
export type P2ToolName = (typeof P2_TOOL_NAMES)[number]

export interface P2ToolResult {
  ok: boolean
  output: string
}

export const P2_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'draft_skill',
      description: '根据任务复盘摘要生成可人工确认的 SKILL.md 草案；只返回草案，不自动写入文件。',
      parameters: {
        type: 'object',
        properties: {
          taskSummary: { type: 'string', description: '任务复盘摘要或可复用流程说明' },
          title: { type: 'string', description: '可选 Skill 名称' },
          description: { type: 'string', description: '可选 Skill 描述' },
          tags: { type: 'array', items: { type: 'string' } },
          verification: { type: 'array', items: { type: 'string' } }
        },
        required: ['taskSummary']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'optimize_skill',
      description: '记录项目本地 Skill 的失败/用户修正反馈；累计失败或收到修正后安全更新 SKILL.md。仅允许修改 .caogen/skills 下的项目 Skill。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id 或名称' },
          outcome: { type: 'string', enum: ['failed', 'corrected', 'succeeded'] },
          summary: { type: 'string', description: '失败点、用户修正或执行结果摘要' },
          correctionSteps: { type: 'array', items: { type: 'string' }, description: '用户修正后确认有效的步骤' },
          verification: { type: 'array', items: { type: 'string' }, description: '新增或修正后的验证命令/检查项' },
          failureThreshold: { type: 'number', description: '累计多少次失败后自动追加优化记录，默认 2' }
        },
        required: ['id', 'outcome', 'summary']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'route_model',
      description: '基于已配置 Provider、任务类型、预算和风险生成模型路由与交叉验证计划；不直接发起模型调用。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '任务描述' },
          requestedTasks: {
            type: 'array',
            items: { type: 'string', enum: ['chat', 'coding', 'reasoning', 'vision', 'toolUse', 'longContext', 'review', 'summarization'] }
          },
          strategy: { type: 'string', enum: ['balanced', 'cost', 'speed', 'quality'] },
          contextTokens: { type: 'number' },
          expectedOutputTokens: { type: 'number' },
          remainingUsd: { type: 'number' },
          hardBudget: { type: 'boolean' },
          providerId: { type: 'string', description: '可选手动指定 Provider' },
          model: { type: 'string', description: '可选手动指定模型' },
          crossValidation: { type: 'boolean', description: '是否生成第二模型复核计划' },
          providers: {
            type: 'array',
            description: '可选测试/显式路由 Provider 列表；桌面端未传时读取已配置 Provider',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                baseUrl: { type: 'string' },
                models: { type: 'array', items: { type: 'string' } }
              },
              required: ['id', 'name', 'models']
            }
          }
        },
        required: ['prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'china_notify',
      description: '构造或发送飞书/钉钉/企业微信机器人通知；默认 dry_run，不传 dry_run=false 不会触网。',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['feishu', 'dingtalk', 'wecom'] },
          title: { type: 'string' },
          text: { type: 'string' },
          linkUrl: { type: 'string' },
          webhookUrl: { type: 'string' },
          secret: { type: 'string', description: '飞书/钉钉签名密钥，可选' },
          dry_run: { type: 'boolean', description: '默认 true；只有 false 才发送' }
        },
        required: ['channel', 'title', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gitee_prepare',
      description: '构造 Gitee PR/Issue Web URL 和 API 请求；默认不发送，send=true 且提供 accessToken 才触发请求。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pull_request', 'issue'] },
          owner: { type: 'string' },
          repo: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          head: { type: 'string', description: 'PR 源分支' },
          base: { type: 'string', description: 'PR 目标分支' },
          labels: { type: 'array', items: { type: 'string' } },
          accessToken: { type: 'string' },
          baseApiUrl: { type: 'string', description: '可选：Gitee API 基础地址，支持企业版或代理地址' },
          webBaseUrl: { type: 'string', description: '可选：Gitee Web 基础地址，支持企业版或代理地址' },
          send: { type: 'boolean', description: '默认 false' }
        },
        required: ['action', 'owner', 'repo', 'title']
      }
    }
  }
]

export function isP2ToolName(name: string): name is P2ToolName {
  return (P2_TOOL_NAMES as readonly string[]).includes(name)
}

export async function executeP2Tool(name: P2ToolName, args: Record<string, unknown>, _cwd: string): Promise<P2ToolResult> {
  if (name === 'draft_skill') {
    const draft = draftSkillFromSummary({
      taskSummary: requiredString(args.taskSummary, 'taskSummary'),
      title: optionalString(args.title),
      description: optionalString(args.description),
      tags: stringArray(args.tags),
      verification: stringArray(args.verification)
    })
    return { ok: draft.ok, output: JSON.stringify(draft, null, 2) }
  }

  if (name === 'optimize_skill') {
    const result = await recordSkillFeedback({
      projectRoot: _cwd,
      skillIdOrName: requiredString(args.id, 'id'),
      outcome: skillFeedbackOutcome(args.outcome),
      summary: requiredString(args.summary, 'summary'),
      correctionSteps: stringArray(args.correctionSteps),
      verification: stringArray(args.verification),
      failureThreshold: optionalNumber(args.failureThreshold)
    })
    return {
      ok: result.status === 'recorded' || result.status === 'updated',
      output: JSON.stringify(result, null, 2)
    }
  }

  if (name === 'route_model') {
    const providers = providerViews(args.providers) ?? listProviders()
    const decision = routeModel({
      providers,
      prompt: requiredString(args.prompt, 'prompt'),
      requestedTasks: modelTaskKinds(args.requestedTasks),
      strategy: schedulerStrategy(args.strategy),
      contextTokens: optionalNumber(args.contextTokens),
      expectedOutputTokens: optionalNumber(args.expectedOutputTokens),
      manualOverride: {
        providerId: optionalString(args.providerId),
        model: optionalString(args.model)
      },
      budget: {
        remainingUsd: optionalNumber(args.remainingUsd),
        hardLimit: args.hardBudget === true
      },
      crossValidation: {
        enabled: args.crossValidation === true,
        minRiskLevel: 'medium',
        maxValidators: 1
      }
    })
    return { ok: true, output: JSON.stringify(decision, null, 2) }
  }

  if (name === 'china_notify') {
    const channel = requiredString(args.channel, 'channel')
    const input = {
      title: requiredString(args.title, 'title'),
      text: requiredString(args.text, 'text'),
      linkUrl: optionalString(args.linkUrl)
    }
    const options = {
      webhookUrl: optionalString(args.webhookUrl),
      secret: optionalString(args.secret),
      dryRun: args.dry_run !== false
    }
    if (channel === 'feishu') {
      const result = await sendFeishuNotification(input, options)
      return { ok: result.ok, output: JSON.stringify(result, null, 2) }
    }
    if (channel === 'dingtalk') {
      const result = await sendDingTalkNotification(input, options)
      return { ok: result.ok, output: JSON.stringify(result, null, 2) }
    }
    if (channel === 'wecom') {
      const result = await sendWeComNotification(input, { webhookUrl: options.webhookUrl, dryRun: options.dryRun })
      return { ok: result.ok, output: JSON.stringify(result, null, 2) }
    }
    return { ok: false, output: `不支持的通知渠道: ${channel}` }
  }

  const action = requiredString(args.action, 'action')
  const common = {
    owner: requiredString(args.owner, 'owner'),
    repo: requiredString(args.repo, 'repo'),
    title: requiredString(args.title, 'title'),
    body: optionalString(args.body)
  }
  const accessToken = optionalString(args.accessToken)
  const baseApiUrl = optionalString(args.baseApiUrl)
  const webBaseUrl = optionalString(args.webBaseUrl)
  if (action === 'pull_request') {
    const input = {
      ...common,
      head: requiredString(args.head, 'head'),
      base: requiredString(args.base, 'base')
    }
    const url = buildGiteePullRequestUrl(input, webBaseUrl)
    const result = await sendGiteePullRequest(input, { accessToken, baseApiUrl, dryRun: args.send !== true })
    return { ok: result.ok, output: JSON.stringify({ webUrl: url, result }, null, 2) }
  }
  if (action === 'issue') {
    const input = { ...common, labels: stringArray(args.labels) }
    const url = buildGiteeIssueUrl(input, webBaseUrl)
    const result = await sendGiteeIssue(input, { accessToken, baseApiUrl, dryRun: args.send !== true })
    return { ok: result.ok, output: JSON.stringify({ webUrl: url, result }, null, 2) }
  }
  return { ok: false, output: `不支持的 Gitee 动作: ${action}` }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`)
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
  return items.length > 0 ? items : undefined
}

function schedulerStrategy(value: unknown): SchedulerStrategy | undefined {
  return value === 'balanced' || value === 'cost' || value === 'speed' || value === 'quality' ? value : undefined
}

function modelTaskKinds(value: unknown): ModelTaskKind[] | undefined {
  const allowed = new Set<ModelTaskKind>(['chat', 'coding', 'reasoning', 'vision', 'toolUse', 'longContext', 'review', 'summarization'])
  const items = stringArray(value)?.filter((item): item is ModelTaskKind => allowed.has(item as ModelTaskKind))
  return items && items.length > 0 ? items : undefined
}

function skillFeedbackOutcome(value: unknown): SkillFeedbackOutcome {
  if (value === 'failed' || value === 'corrected' || value === 'succeeded') return value
  throw new Error('outcome 必须是 failed/corrected/succeeded')
}

function providerViews(value: unknown): ProviderView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const providers: ProviderView[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const id = optionalString(item.id)
    const name = optionalString(item.name)
    const models = stringArray(item.models)
    if (!id || !name || !models || models.length === 0) continue
    providers.push({
      id,
      name,
      baseUrl: optionalString(item.baseUrl) ?? '',
      models,
      budgetUsd: optionalNumber(item.budgetUsd) ?? 0,
      customHeaders: optionalString(item.customHeaders),
      openaiProtocol: item.openaiProtocol === 'chat' || item.openaiProtocol === 'responses' ? item.openaiProtocol : undefined,
      note: optionalString(item.note),
      createdAt: optionalNumber(item.createdAt) ?? Date.now(),
      hasToken: item.hasToken === true
    })
  }
  return providers.length > 0 ? providers : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
