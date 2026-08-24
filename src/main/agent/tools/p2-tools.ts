import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listProviders } from '../../providers'
import { draftSkillFromSummary } from '../../skill/skill-learner'
import { proposeSkillOptimization, type SkillFeedbackOutcome } from '../../skill/skill-optimizer'
import { routeModel } from '../../model/model-router'
import { buildFeishuWebhookPayload } from '../../notification/feishu'
import { buildDingTalkWebhookPayload } from '../../notification/dingtalk'
import {
  buildGiteeIssueApiRequest,
  buildGiteeIssueUrl,
  buildGiteePullRequestApiRequest,
  buildGiteePullRequestUrl,
} from './gitee-tools'
import type { ProviderView, SchedulerStrategy, SessionMeta, WorkItemActor } from '../../../shared/types'
import type { EffectTarget } from '../../../shared/types'
import { executeWebhookMessageEffectTarget } from '../../notification/notification-effect'
import type { ModelTaskKind } from '../../model/model-profile'
import type { ToolDefinition } from './tool-types'
import { DigitalWorkerStore } from '../../digital-worker/domain-store'
import { openProjectWorkspaceStore } from '../../project-workspace/store'
import { verifyProductionProjectMutation } from '../../project-aggregate/project-mutation-ingress'
import { searchProjectKnowledge } from '../../project-workspace/project-knowledge-search'
import { taskRuntimeRegistry } from '../../task/task-runtime-registry'
import { writeDurableFile } from '../../durable-file'
import { ensureManagedPersonalWorkspace } from '../../project-workspace/managed-personal-workspace'
import { createWorkflowEvidence } from '../../task/workflow-ledger-api'
import {
  SearchBroker,
  type SearchBrokerEvidenceRecord,
  type SearchBrokerMode,
  type SearchBrokerResult,
  type SearchProviderAdapter,
  type SearchProviderRequest
} from '../../search/search-broker'

export const P2_TOOL_NAMES = [
  'draft_skill',
  'optimize_skill',
  'route_model',
  'china_notify',
  'send_notification',
  'web_search',
  'project_knowledge_search',
  'work_item_comment',
  'gitee_prepare'
] as const
export type P2ToolName = (typeof P2_TOOL_NAMES)[number]

export interface P2ToolResult {
  ok: boolean
  output: string
}

export interface P2ToolExecutionContext {
  effectTarget?: EffectTarget
  sessionMeta?: SessionMeta
  userDataRoot?: string
  toolUseId?: string
  runId?: string
  /** Optional injected broker for deterministic Assistant/engine execution. */
  searchBroker?: SearchBroker
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
      name: 'send_notification',
      description: '通过 CaoGen 中已保存的飞书或钉钉连接器发送消息。无需传 Webhook 或密钥；省略 connectorId 时使用该渠道默认连接器。',
      parameters: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: '可选连接器 ID。' },
          channel: { type: 'string', enum: ['feishu', 'dingtalk'], description: '使用默认连接器时必填。' },
          title: { type: 'string' },
          text: { type: 'string' },
          linkUrl: { type: 'string' }
        },
        required: ['title', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '通过 CaoGen 自有 Search Broker 执行通用联网搜索。每个成功结果都必须重新抓取并返回 URL、抓取时间、摘要、内容 SHA-256、引用和 Evidence；无结果、超时、无凭据、出口拒绝、Provider 失败或未知结果会明确返回失败状态。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '要搜索的问题或关键词' },
          mode: { type: 'string', enum: ['model_native', 'byok_search_adapter'], description: '默认 model_native；需要独立 BYOK 时显式选择 byok_search_adapter。' },
          operationId: { type: 'string', description: '可选稳定操作身份；用于重启后的幂等重放。' },
          artifactId: { type: 'string', description: '可选；把来源 Evidence 绑定到已存在的 canonical Artifact。' },
          limit: { type: 'number', description: '返回来源数量，默认 5，最多 20。' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'project_knowledge_search',
      description: '在当前 Project 已授权的本地知识与可用只读连接器中检索，并返回带 source/version/retrievedAt/Evidence 的有界引用。Project、Goal、WorkItem 身份由当前会话注入，不能由参数覆盖。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要检索的关键词或问题' },
          limit: { type: 'number', description: '最多返回多少条引用，默认 8，最多 20' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'work_item_comment',
      description: '以当前数字员工会话的不可变身份，在当前 WorkItem 下发表评论。Project、WorkItem、作者和 Assignment 均由 CaoGen 注入，不能由参数覆盖。',
      parameters: {
        type: 'object',
        properties: {
          body: { type: 'string', description: '评论正文' },
          mentions: {
            type: 'array',
            description: '可选的同 Project 成员提及',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['human', 'digital_worker'] },
                id: { type: 'string' },
                displayName: { type: 'string' }
              },
              required: ['type', 'id']
            }
          }
        },
        required: ['body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'optimize_skill',
      description: '记录项目本地 Skill 的失败/用户修正反馈；累计失败或收到修正后生成待用户批准的 Learning Skill 草稿，批准前不会修改活动 SKILL.md。',
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
      description: '构造飞书或钉钉机器人通知预览；只返回 payload，不接受 webhook 或签名密钥，也不会触网。',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['feishu', 'dingtalk'] },
          title: { type: 'string' },
          text: { type: 'string' },
          linkUrl: { type: 'string' }
        },
        required: ['channel', 'title', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gitee_prepare',
      description: '构造 Gitee PR/Issue Web URL 和无凭据 API 请求预览；不会发送请求。',
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
          baseApiUrl: { type: 'string', description: '可选：Gitee API 基础地址，支持企业版或代理地址' },
          webBaseUrl: { type: 'string', description: '可选：Gitee Web 基础地址，支持企业版或代理地址' }
        },
        required: ['action', 'owner', 'repo', 'title']
      }
    }
  }
]

export function isP2ToolName(name: string): name is P2ToolName {
  return (P2_TOOL_NAMES as readonly string[]).includes(name)
}

export async function executeP2Tool(
  name: P2ToolName,
  args: Record<string, unknown>,
  _cwd: string,
  context: P2ToolExecutionContext = {}
): Promise<P2ToolResult> {
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
    const result = await proposeSkillOptimization({
      projectRoot: _cwd,
      skillIdOrName: requiredString(args.id, 'id'),
      outcome: skillFeedbackOutcome(args.outcome),
      summary: requiredString(args.summary, 'summary'),
      correctionSteps: stringArray(args.correctionSteps),
      verification: stringArray(args.verification),
      failureThreshold: optionalNumber(args.failureThreshold)
    })
    return {
      ok: result.status === 'recorded' || result.status === 'drafted',
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

  if (name === 'china_notify') return executeChinaNotifyPreview(args)
  if (name === 'web_search') return executeWebSearch(args, context)
  if (name === 'project_knowledge_search') return executeProjectKnowledgeSearch(args, context)
  if (name === 'work_item_comment') return executeWorkItemComment(args, context)
  if (name === 'send_notification') {
    if (context.effectTarget?.kind !== 'webhook_message_send') {
      return { ok: false, output: 'send_notification 缺少冻结的 webhook_message_send EffectTarget，已阻止发送' }
    }
    const result = await executeWebhookMessageEffectTarget(context.effectTarget, args)
    return { ok: result.ok, output: JSON.stringify(result, null, 2) }
  }
  return executeGiteePreview(args)
}

async function executeWebSearch(
  args: Record<string, unknown>,
  context: P2ToolExecutionContext
): Promise<P2ToolResult> {
  const root = context.userDataRoot
  const meta = context.sessionMeta
  if (!root || !meta || !context.toolUseId) {
    return { ok: false, output: 'web_search 缺少稳定 Session、用户数据目录或工具调用身份' }
  }
  const mode = args.mode === undefined ? 'model_native' : args.mode
  if (mode !== 'model_native' && mode !== 'byok_search_adapter') {
    return { ok: false, output: 'web_search mode 必须是 model_native 或 byok_search_adapter' }
  }
  const projectId = meta.workspaceId ?? meta.personalWorkspaceId ?? (await ensureManagedPersonalWorkspace(root)).workspace.id
  const run = taskRuntimeRegistry.get(meta.id)
  const runId = context.runId ?? run?.id
  const operationId = optionalString(args.operationId) ?? `search:${meta.id}:${context.toolUseId}`
  const broker = context.searchBroker ?? new SearchBroker({
    modelNative: configuredSearchAdapter('CAOGEN_SEARCH_MODEL_NATIVE_URL', 'CAOGEN_SEARCH_MODEL_NATIVE_API_KEY'),
    byokSearchAdapter: configuredSearchAdapter('CAOGEN_SEARCH_BYOK_URL', 'CAOGEN_SEARCH_BYOK_API_KEY'),
    idempotencyStore: durableSearchStore(root, projectId),
    evidenceWriter: async (record) => recordSearchEvidence(record, root, {
      projectId,
      goalId: meta.goalId,
      workItemId: meta.workItemId,
      runId,
      artifactId: optionalString(args.artifactId)
    })
  })
  const result = await broker.search({
    query: requiredString(args.query, 'query'),
    mode: mode as SearchBrokerMode,
    operationId,
    projectId,
    ...(meta.goalId ? { goalId: meta.goalId } : {}),
    ...(meta.workItemId ? { workItemId: meta.workItemId } : {}),
    ...(runId ? { runId } : {}),
    ...(optionalString(args.artifactId) ? { artifactId: optionalString(args.artifactId) } : {}),
    limit: optionalNumber(args.limit)
  })
  return { ok: result.ok, output: JSON.stringify(result, null, 2) }
}

function configuredSearchAdapter(urlEnv: string, keyEnv: string): SearchProviderAdapter | undefined {
  const endpoint = process.env[urlEnv]?.trim()
  if (!endpoint) return undefined
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { available: false, async search() { return { status: 'provider_failure', message: `Invalid search endpoint in ${urlEnv}.` } } }
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return { available: false, async search() { return { status: 'egress_denied', message: `Search endpoint in ${urlEnv} must be a credential-free HTTP(S) URL.` } } }
  }
  return {
    available: () => keyEnv === 'CAOGEN_SEARCH_MODEL_NATIVE_API_KEY' || Boolean(process.env[keyEnv]?.trim()),
    async search(input: SearchProviderRequest) {
      const key = process.env[keyEnv]?.trim()
      if (!key && keyEnv !== 'CAOGEN_SEARCH_MODEL_NATIVE_API_KEY') return { status: 'no_credentials', message: 'No BYOK search credentials are configured.' }
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(key ? { authorization: `Bearer ${key}` } : {})
          },
          body: JSON.stringify({ query: input.query, limit: input.limit, operationId: input.operationId, mode: input.mode }),
          signal: input.signal
        })
        if (!response.ok) return { status: 'provider_failure', message: `Search adapter returned HTTP ${response.status}.` }
        const body = await response.json() as Record<string, unknown>
        return normalizeSearchAdapterResponse(body)
      } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return { status: 'timeout', message: 'Search adapter timed out.' }
        return { status: 'provider_failure', message: 'Search adapter failed before a verified result was produced.' }
      }
    }
  }
}

function normalizeSearchAdapterResponse(body: Record<string, unknown>): {
  status?: 'success' | 'no_results' | 'timeout' | 'no_credentials' | 'egress_denied' | 'provider_failure' | 'unknown_result'
  results?: Array<{ url: string; title?: string; summary?: string }>
  message?: string
} {
  const status = typeof body.status === 'string' ? body.status : undefined
  const raw = Array.isArray(body.results) ? body.results : Array.isArray(body.items) ? body.items : []
  const results = raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    const url = typeof value.url === 'string' ? value.url : typeof value.link === 'string' ? value.link : ''
    if (!url.trim()) return []
    return [{
      url,
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
      ...(typeof value.summary === 'string' ? { summary: value.summary } : typeof value.snippet === 'string' ? { summary: value.snippet } : {})
    }]
  })
  return {
    ...(status ? { status: status as ReturnType<typeof normalizeSearchAdapterResponse>['status'] } : {}),
    results,
    ...(typeof body.message === 'string' ? { message: body.message } : {})
  }
}

function durableSearchStore(rootDir: string, projectId: string) {
  const filePath = join(rootDir, 'search-broker', createHash('sha256').update(projectId).digest('hex'), 'operations.json')
  let loaded = false
  let entries: Record<string, SearchBrokerResult> = {}
  const load = (): void => {
    if (loaded) return
    loaded = true
    if (!existsSync(filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed as Record<string, SearchBrokerResult>
    } catch {
      entries = {}
    }
  }
  return {
    get(operationId: string): SearchBrokerResult | undefined {
      load()
      return entries[operationId]
    },
    async put(operationId: string, result: SearchBrokerResult): Promise<void> {
      load()
      entries[operationId] = result
      await writeDurableFile(filePath, `${JSON.stringify(entries)}\n`, { mode: 0o600 })
    }
  }
}

async function recordSearchEvidence(
  record: SearchBrokerEvidenceRecord,
  rootDir: string,
  binding: { projectId: string; goalId?: string; workItemId?: string; runId?: string; artifactId?: string }
): Promise<void> {
  await createWorkflowEvidence({
    evidenceId: record.evidenceId,
    projectId: binding.projectId,
    ...(binding.goalId ? { goalId: binding.goalId } : {}),
    ...(binding.workItemId ? { workItemId: binding.workItemId } : {}),
    ...(binding.runId ? { runId: binding.runId } : {}),
    ...(binding.artifactId ? { artifactId: binding.artifactId } : {}),
    kind: 'research_source',
    title: record.title,
    summary: record.summary,
    uri: record.uri,
    mediaType: record.mediaType,
    contentDigest: record.contentDigest,
    metadata: record.metadata
  }, rootDir, { source: 'runtime', verifier: record.verifier, observedAt: record.observedAt })
}

async function executeProjectKnowledgeSearch(
  args: Record<string, unknown>,
  context: P2ToolExecutionContext
): Promise<P2ToolResult> {
  const meta = context.sessionMeta
  const root = context.userDataRoot
  const projectId = meta?.workspaceId
  if (!meta || !root || !projectId || meta.unassigned) {
    return { ok: false, output: 'project_knowledge_search 只允许绑定当前 Project 的会话调用' }
  }
  const limit = args.limit === undefined ? undefined : optionalNumber(args.limit)
  const run = taskRuntimeRegistry.get(meta.id)
  const result = await searchProjectKnowledge(root, {
    projectId,
    query: requiredString(args.query, 'query'),
    ...(limit === undefined ? {} : { limit })
  }, {
    ...(meta.goalId ? { goalId: meta.goalId } : {}),
    ...(meta.workItemId ? { workItemId: meta.workItemId } : {}),
    ...(run ? { runId: run.id } : {})
  })
  await verifyProductionProjectMutation(root, projectId)
  return { ok: true, output: JSON.stringify(result, null, 2) }
}

async function executeWorkItemComment(
  args: Record<string, unknown>,
  context: P2ToolExecutionContext
): Promise<P2ToolResult> {
  const meta = context.sessionMeta
  const root = context.userDataRoot
  const toolUseId = context.toolUseId
  const projectId = meta?.workspaceId
  const workItemId = meta?.workItemId
  const binding = meta?.digitalWorkerBinding
  if (!meta || !root || !toolUseId || !projectId || !workItemId || binding?.kind !== 'assigned') {
    return {
      ok: false,
      output: 'work_item_comment 只允许绑定 Project、WorkItem 和 active DigitalWorker Assignment 的会话调用'
    }
  }
  const workforce = new DigitalWorkerStore(root).read()
  const worker = workforce.workers.find((candidate) =>
    candidate.id === binding.workerId && candidate.projectId === projectId && candidate.status === 'active')
  const assignment = workforce.assignments.find((candidate) =>
    candidate.id === binding.assignmentId && candidate.status === 'active' &&
    candidate.projectId === projectId && candidate.workItemId === workItemId &&
    candidate.assigneeKind === 'digital_worker' && candidate.assigneeId === binding.workerId)
  if (!worker || !assignment) {
    return { ok: false, output: 'work_item_comment 的 DigitalWorker 或 Assignment 已失效' }
  }

  const body = requiredString(args.body, 'body')
  const mentions = commentMentions(args.mentions)
  const commentId = deterministicCommentId(meta.id, toolUseId)
  const store = await openProjectWorkspaceStore(root)
  const existing = await store.getWorkItemComment(commentId)
  const author: WorkItemActor = {
    type: 'digital_worker',
    id: worker.id,
    displayName: worker.displayName
  }
  if (existing) {
    if (existing.projectId !== projectId || existing.workItemId !== workItemId ||
        canonicalComment(existing.author, existing.body, existing.mentions) !== canonicalComment(author, body, mentions)) {
      return { ok: false, output: 'work_item_comment 幂等身份与已有评论冲突' }
    }
    return {
      ok: true,
      output: JSON.stringify({ id: existing.id, revision: existing.revision, idempotentReplay: true })
    }
  }
  const comment = await store.createWorkItemComment({
    id: commentId,
    projectId,
    workItemId,
    author,
    body,
    mentions
  })
  await verifyProductionProjectMutation(root, projectId)
  return {
    ok: true,
    output: JSON.stringify({ id: comment.id, revision: comment.revision, idempotentReplay: false })
  }
}

function deterministicCommentId(sessionId: string, toolUseId: string): string {
  return `agent-comment-${createHash('sha256')
    .update(`caogen.work-item-comment.v1\0${sessionId}\0${toolUseId}`)
    .digest('hex')}`
}

function commentMentions(value: unknown): WorkItemActor[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('mentions 必须是数组')
  const mentions = value.map((item, index): WorkItemActor => {
    if (!isRecord(item) || (item.type !== 'human' && item.type !== 'digital_worker')) {
      throw new Error(`mentions[${index}] 类型无效`)
    }
    return {
      type: item.type,
      id: requiredString(item.id, `mentions[${index}].id`),
      displayName: optionalString(item.displayName)
    }
  }).sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`))
  const ids = new Set<string>()
  for (const mention of mentions) {
    const key = `${mention.type}:${mention.id}`
    if (ids.has(key)) throw new Error(`mentions 包含重复成员 ${key}`)
    ids.add(key)
  }
  return mentions
}

function canonicalComment(author: WorkItemActor, body: string, mentions: WorkItemActor[]): string {
  return JSON.stringify({
    author,
    body,
    mentions: [...mentions].sort((left, right) =>
      `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`))
  })
}

function executeChinaNotifyPreview(args: Record<string, unknown>): P2ToolResult {
  if (hasOwn(args, 'webhookUrl') || hasOwn(args, 'secret') || args.dry_run === false) {
    return {
      ok: false,
      output: 'china_notify 仅支持无凭据预览；webhookUrl、secret 和 dry_run=false 已禁用。'
    }
  }
  const channel = requiredString(args.channel, 'channel')
  const input = {
    title: requiredString(args.title, 'title'),
    text: requiredString(args.text, 'text'),
    linkUrl: optionalString(args.linkUrl)
  }
  const payload = channel === 'feishu'
    ? buildFeishuWebhookPayload(input)
    : channel === 'dingtalk'
      ? buildDingTalkWebhookPayload(input)
      : undefined
  if (!payload) return { ok: false, output: `不支持的通知渠道: ${channel}` }
  return {
    ok: true,
    output: JSON.stringify({ ok: true, dryRun: true, sent: false, channel, payload }, null, 2)
  }
}

function executeGiteePreview(args: Record<string, unknown>): P2ToolResult {
  if (hasOwn(args, 'accessToken') || args.send === true) {
    return {
      ok: false,
      output: 'gitee_prepare 仅支持无凭据预览；accessToken 和 send=true 已禁用。'
    }
  }
  const action = requiredString(args.action, 'action')
  const common = {
    owner: requiredString(args.owner, 'owner'),
    repo: requiredString(args.repo, 'repo'),
    title: requiredString(args.title, 'title'),
    body: optionalString(args.body)
  }
  const baseApiUrl = optionalString(args.baseApiUrl)
  const webBaseUrl = optionalString(args.webBaseUrl)
  if (action === 'pull_request') {
    const input = {
      ...common,
      head: requiredString(args.head, 'head'),
      base: requiredString(args.base, 'base')
    }
    const webUrl = buildGiteePullRequestUrl(input, webBaseUrl)
    const request = buildGiteePullRequestApiRequest(input, { baseApiUrl })
    return { ok: true, output: JSON.stringify({ ok: true, dryRun: true, sent: false, webUrl, request }, null, 2) }
  }
  if (action === 'issue') {
    const input = { ...common, labels: stringArray(args.labels) }
    const webUrl = buildGiteeIssueUrl(input, webBaseUrl)
    const request = buildGiteeIssueApiRequest(input, { baseApiUrl })
    return { ok: true, output: JSON.stringify({ ok: true, dryRun: true, sent: false, webUrl, request }, null, 2) }
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
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
  const providers = value.map(providerView).filter((item): item is ProviderView => item !== undefined)
  return providers.length > 0 ? providers : undefined
}

function providerView(value: unknown): ProviderView | undefined {
  if (!isRecord(value)) return undefined
  const id = optionalString(value.id)
  const name = optionalString(value.name)
  const models = stringArray(value.models)
  if (!id || !name || !models) return undefined
  const hasToken = value.hasToken === true
  const baseUrl = valueOr(optionalString(value.baseUrl), '')
  const authMode = providerAuthMode(value.authMode, baseUrl)
  return {
    id,
    name,
    baseUrl,
    models,
    authMode,
    ready: providerReady(authMode, hasToken),
    engine: providerEngine(value.engine),
    budgetUsd: valueOr(optionalNumber(value.budgetUsd), 0),
    customHeaders: optionalString(value.customHeaders),
    credentialHeaderNames: stringArray(value.credentialHeaderNames),
    openaiProtocol: providerOpenAiProtocol(value.openaiProtocol),
    note: optionalString(value.note),
    createdAt: valueOr(optionalNumber(value.createdAt), Date.now()),
    hasToken,
    credentialRoutingMode: providerCredentialRoutingMode(value.credentialRoutingMode),
    credentialStorage: providerCredentialStorage(hasToken)
  }
}

function valueOr<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value
}

function providerAuthMode(value: unknown, baseUrl: string): ProviderView['authMode'] {
  return value === 'none' && isLoopbackUrl(baseUrl) ? 'none' : 'api-key'
}

function providerReady(authMode: ProviderView['authMode'], hasToken: boolean): boolean {
  return authMode === 'none' || hasToken
}

function providerEngine(value: unknown): ProviderView['engine'] {
  if (value === 'anthropic' || value === 'claude') return 'anthropic'
  return value === 'gemini' ? 'gemini' : 'openai'
}

function providerOpenAiProtocol(value: unknown): ProviderView['openaiProtocol'] {
  return value === 'chat' || value === 'responses' ? value : undefined
}

function providerCredentialStorage(hasToken: boolean): ProviderView['credentialStorage'] {
  return hasToken ? 'encrypted' : 'none'
}

function providerCredentialRoutingMode(value: unknown): ProviderView['credentialRoutingMode'] {
  return value === 'manual' || value === 'automatic' ? value : 'preferred'
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
