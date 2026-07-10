import { AgentSession } from './agentSession'
import { registerEngine } from './engine'
import { openAIEngineFactory } from './openaiEngine'
import type { Engine, EngineEmit } from './engine'
import type { SessionMeta } from '../shared/types'

/**
 * M6 · 引擎注册。
 * - claude:Claude Agent SDK(AgentSession),完整能力。
 * - openai:OpenAI Responses API,原生直连,覆盖文本/图片输入与流式输出。
 * 产品只保留 Claude Agent SDK 与 OpenAI-compatible 两条正式运行时路径。
 */

export function registerBuiltinEngines(): void {
  registerEngine({
    kind: 'claude',
    label: 'Claude Agent SDK',
    available: () => true,
    create: (
      meta: SessionMeta,
      emit: EngineEmit,
      resumeSdkSessionId?: string,
      initialEventSeq?: number
    ): Engine => new AgentSession(meta, emit, resumeSdkSessionId, initialEventSeq)
  })

  registerEngine(openAIEngineFactory)
}
