import { execFileSync } from 'node:child_process'
import { AgentSession } from './agentSession'
import { registerEngine } from './engine'
import { openAIEngineFactory } from './openaiEngine'
import { CodexEngine } from './codexEngine'
import { geminiEngineFactory } from './geminiEngine'
import type { Engine, EngineEmit } from './engine'
import type { SessionMeta } from '../shared/types'

/**
 * M6 · 引擎注册。
 * - claude:Claude Agent SDK(AgentSession),完整能力,默认引擎。
 * - openai:OpenAI Responses API,原生直连,覆盖文本/图片输入与流式输出。
 * - codex / gemini:探测本机 CLI 是否安装;适配器尚未实现,可用性
 *   如实上报为 false(UI 置灰),避免"能选但不能用"的假象。
 *   接入路径:各自实现 Engine 接口,把 CLI 的流式输出翻译成 AgentEvent。
 */

/** 探测 CLI 是否在 PATH 上(启动时一次,结果缓存) */
function cliExists(bin: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      stdio: 'ignore',
      timeout: 3000
    })
    return true
  } catch {
    return false
  }
}

const codexInstalled = cliExists('codex')

export function registerBuiltinEngines(): void {
  registerEngine({
    kind: 'claude',
    label: 'Claude Agent SDK',
    available: () => true,
    create: (meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string): Engine =>
      new AgentSession(meta, emit, resumeSdkSessionId)
  })

  registerEngine(openAIEngineFactory)

  // Codex CLI 引擎(实验性):CLI 已装才可用,spawn `codex` 翻译事件
  registerEngine({
    kind: 'codex',
    label: `Codex CLI${codexInstalled ? '(实验性)' : '(未安装)'}`,
    available: () => codexInstalled,
    create: (meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string): Engine =>
      new CodexEngine(meta, emit, resumeSdkSessionId)
  })

  // Gemini CLI 引擎(实验性):工厂内部用 geminiCliAvailable() 自探测
  registerEngine(geminiEngineFactory)
}
