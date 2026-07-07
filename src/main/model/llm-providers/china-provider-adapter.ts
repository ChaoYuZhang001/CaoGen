import type { Provider } from '../../../shared/types'

export type ChinaProviderFamily = 'deepseek' | 'qwen' | 'kimi' | 'zhipu' | 'doubao' | 'baichuan' | 'generic'

export interface ProviderAdapterContext {
  provider?: Pick<Provider, 'id' | 'name' | 'baseUrl'>
  model: string
}

export interface ChatCompletionRequestBody {
  model: string
  messages: unknown[]
  tools?: unknown[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  tool_choice?: 'auto' | 'none'
}

export interface ChatCompletionAdaptation {
  body: ChatCompletionRequestBody
  family: ChinaProviderFamily
  promptAppend: string
  warnings: string[]
}

const TOOL_PROMPT_APPEND =
  '工具调用要求:如需调用工具,必须使用接口提供的 tool_calls/function calling 结构;arguments 必须是可解析的 JSON 对象字符串,不要把工具名或参数写进普通文本、Markdown 代码块或中文说明里。'

const STREAM_OPTIONS_UNSTABLE: ChinaProviderFamily[] = ['kimi', 'zhipu', 'baichuan']

export function detectChinaProviderFamily(context: ProviderAdapterContext): ChinaProviderFamily {
  const text = `${context.provider?.id ?? ''} ${context.provider?.name ?? ''} ${context.provider?.baseUrl ?? ''} ${context.model}`.toLowerCase()
  if (hasAny(text, ['deepseek', 'api.deepseek.com'])) return 'deepseek'
  if (hasAny(text, ['qwen', 'dashscope', 'aliyun', 'bailian', '百炼', '通义'])) return 'qwen'
  if (hasAny(text, ['moonshot', 'kimi', 'api.moonshot'])) return 'kimi'
  if (hasAny(text, ['zhipu', 'bigmodel', 'glm', '智谱'])) return 'zhipu'
  if (hasAny(text, ['baichuan', '百川'])) return 'baichuan'
  if (hasAny(text, ['doubao', 'volcengine', 'ark.cn-beijing.volces.com', '豆包'])) return 'doubao'
  return 'generic'
}

export function buildChinaProviderPromptAppend(context: ProviderAdapterContext): string {
  const family = detectChinaProviderFamily(context)
  if (family === 'generic') return TOOL_PROMPT_APPEND
  return `${TOOL_PROMPT_APPEND}\n当前模型按 ${family} / OpenAI Chat Completions 兼容端点处理;优先返回结构化工具调用,不要用自然语言伪造工具执行结果。`
}

export function adaptChatCompletionRequest(
  body: ChatCompletionRequestBody,
  context: ProviderAdapterContext
): ChatCompletionAdaptation {
  const family = detectChinaProviderFamily(context)
  const warnings: string[] = []
  const adapted: ChatCompletionRequestBody = {
    ...body,
    tool_choice: body.tools && body.tools.length > 0 ? 'auto' : body.tool_choice
  }

  if (STREAM_OPTIONS_UNSTABLE.includes(family) && adapted.stream_options) {
    const { stream_options: _removed, ...withoutStreamOptions } = adapted
    warnings.push(`${family} 兼容端点常见不支持 stream_options,已移除 include_usage 请求字段。`)
    return {
      body: withoutStreamOptions,
      family,
      promptAppend: buildChinaProviderPromptAppend(context),
      warnings
    }
  }

  return {
    body: adapted,
    family,
    promptAppend: buildChinaProviderPromptAppend(context),
    warnings
  }
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle))
}
