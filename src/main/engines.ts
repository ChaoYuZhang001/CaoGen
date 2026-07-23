import { AgentSession } from './agentSession'
import { AnthropicEngine } from './anthropicEngine'
import { registerEngine } from './engine'
import { openAIEngineFactory } from './openaiEngine'
import { listProviders } from './providers'
import type { Engine, EngineEmit } from './engine'
import type { SessionMeta } from '../shared/types'
import {
  ANTHROPIC_NATIVE_RUNTIME_ADAPTER,
  CLAUDE_NATIVE_RUNTIME_ADAPTER,
  OPENAI_NATIVE_RUNTIME_ADAPTER
} from './native-runtime-contract'
import { ANTHROPIC_MESSAGES_PROTOCOL_ADAPTER } from './protocol-adapters/anthropic-messages'
import { CLAUDE_AGENT_SDK_PROTOCOL_ADAPTER } from './protocol-adapters/claude-agent-sdk'
import { OPENAI_COMPATIBLE_PROTOCOL_ADAPTER } from './protocol-adapters/openai-compatible'

/**
 * M6 · 引擎注册。
 * - claude:Claude Agent SDK(AgentSession),完整能力。
 * - anthropic:Anthropic Messages API,原生直连。
 * - openai:OpenAI Responses API,原生直连,覆盖文本/图片输入与流式输出。
 * 三种 kind 明确区分 Claude Agent SDK、Anthropic Messages 与 OpenAI-compatible 运行时。
 */

export function registerBuiltinEngines(): void {
  registerEngine({
    kind: 'claude',
    label: 'Claude Agent SDK',
    available: () => true,
    optional: true,
    nativeRuntime: CLAUDE_NATIVE_RUNTIME_ADAPTER,
    protocolAdapter: CLAUDE_AGENT_SDK_PROTOCOL_ADAPTER,
    // Provider 目前没有 engine capability 字段；这里只表示存在凭据，不宣称端点兼容 Claude。
    configured: () => listProviders().some((provider) => provider.hasToken),
    create: (
      meta: SessionMeta,
      emit: EngineEmit,
      resumeSdkSessionId?: string,
      initialEventSeq?: number
    ): Engine => new AgentSession(meta, emit, resumeSdkSessionId, initialEventSeq)
  })

  registerEngine({
    kind: 'anthropic',
    label: 'Anthropic Messages API',
    available: () => true,
    nativeRuntime: ANTHROPIC_NATIVE_RUNTIME_ADAPTER,
    protocolAdapter: ANTHROPIC_MESSAGES_PROTOCOL_ADAPTER,
    configured: () => listProviders().some(
      (provider) => provider.engine === 'anthropic' && provider.hasToken
    ),
    create: (
      meta: SessionMeta,
      emit: EngineEmit,
      resumeSdkSessionId?: string,
      initialEventSeq?: number
    ): Engine => new AnthropicEngine(meta, emit, resumeSdkSessionId, initialEventSeq)
  })

  registerEngine({
    ...openAIEngineFactory,
    nativeRuntime: OPENAI_NATIVE_RUNTIME_ADAPTER,
    protocolAdapter: OPENAI_COMPATIBLE_PROTOCOL_ADAPTER
  })
}
