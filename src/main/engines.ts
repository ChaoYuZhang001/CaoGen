import { execFileSync } from 'node:child_process'
import { AgentSession } from './agentSession'
import { registerEngine } from './engine'
import type { Engine, EngineEmit } from './engine'
import type { SessionMeta } from '../shared/types'

/**
 * M6 · 引擎注册。
 * - claude:Claude Agent SDK(AgentSession),完整能力,默认引擎。
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
const geminiInstalled = cliExists('gemini')

export function registerBuiltinEngines(): void {
  registerEngine({
    kind: 'claude',
    label: 'Claude Agent SDK',
    available: () => true,
    create: (meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string): Engine =>
      new AgentSession(meta, emit, resumeSdkSessionId)
  })

  // 占位工厂:CLI 已装则提示"适配器开发中",未装则 UI 置灰。
  // 不注册假实现——create 被意外调用时抛错并回退由调用方处理。
  registerEngine({
    kind: 'codex',
    label: `Codex CLI${codexInstalled ? '(适配器开发中)' : '(未安装)'}`,
    available: () => false,
    create: () => {
      throw new Error('Codex 引擎适配器尚未实现')
    }
  })

  registerEngine({
    kind: 'gemini',
    label: `Gemini CLI${geminiInstalled ? '(适配器开发中)' : '(未安装)'}`,
    available: () => false,
    create: () => {
      throw new Error('Gemini 引擎适配器尚未实现')
    }
  })
}
