import { AnthropicEngine } from './anthropicEngine'
import { registerEngine } from './engine'
import { openAIEngineFactory } from './openaiEngine'
import { listProviders } from './providers'
import type { Engine, EngineEmit } from './engine'
import type { SessionMeta } from '../shared/types'
import {
  ANTHROPIC_NATIVE_RUNTIME_ADAPTER,
  OPENAI_NATIVE_RUNTIME_ADAPTER
} from './native-runtime-contract'
import { ANTHROPIC_MESSAGES_PROTOCOL_ADAPTER } from './protocol-adapters/anthropic-messages'
import { OPENAI_COMPATIBLE_PROTOCOL_ADAPTER } from './protocol-adapters/openai-compatible'

/**
 * M6 · 引擎注册。
 * - anthropic:Anthropic Messages API,原生直连。
 * - openai:OpenAI Responses API,原生直连,覆盖文本/图片输入与流式输出。
 * 两种 kind 明确区分 Anthropic Messages 与 OpenAI-compatible 运行时。
 */

export function registerBuiltinEngines(): void {
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
