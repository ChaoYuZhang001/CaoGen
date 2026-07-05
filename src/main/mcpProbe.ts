import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * MCP 运行态探测(P5.9 治理):对配置里的 MCP server 做真实连接测试。
 * - stdio 型:spawn 命令,发 JSON-RPC initialize,等首个响应(证明协议真通)
 * - http/sse 型:HEAD/GET url,2xx/3xx/401/405 视为可达(server 在线,鉴权另说)
 * 绝不长驻:探测完立即杀进程;单个 8s 超时;并发上限 4。
 */

export interface McpProbeInput {
  /** registry item id(回传对齐用) */
  id: string
  /** mcp 配置对象(command/args/env 或 url) */
  config: Record<string, unknown>
}

export interface McpProbeResult {
  id: string
  /** ok=真实握手/可达;error 附原因 */
  ok: boolean
  transport: 'stdio' | 'http' | 'unknown'
  /** initialize 响应里的 serverInfo.name/version(stdio 才有) */
  serverName?: string
  serverVersion?: string
  latencyMs?: number
  error?: string
}

const PROBE_TIMEOUT_MS = 8_000
const MAX_CONCURRENT = 4

export async function probeMcpServers(inputs: McpProbeInput[]): Promise<McpProbeResult[]> {
  const results: McpProbeResult[] = []
  // 简单并发池
  const queue = [...inputs]
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, async () => {
    while (queue.length > 0) {
      const input = queue.shift()
      if (!input) break
      results.push(await probeOne(input))
    }
  })
  await Promise.all(workers)
  return results
}

async function probeOne(input: McpProbeInput): Promise<McpProbeResult> {
  const config = input.config ?? {}
  const url = typeof config.url === 'string' ? config.url : undefined
  const command = typeof config.command === 'string' ? config.command : undefined

  if (url) return probeHttp(input.id, url)
  if (command) return probeStdio(input.id, command, config)
  return { id: input.id, ok: false, transport: 'unknown', error: '配置里既无 command 也无 url' }
}

async function probeHttp(id: string, url: string): Promise<McpProbeResult> {
  const started = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, { method: 'HEAD', signal: controller.signal })
      // 部分 server 不支持 HEAD
      if (res.status === 405 || res.status === 404) {
        res = await fetch(url, { method: 'GET', signal: controller.signal })
      }
    } finally {
      clearTimeout(timer)
    }
    // 401/403 = server 在线但要鉴权;仍算"可达"
    const reachable = res.ok || [301, 302, 401, 403, 405].includes(res.status)
    return {
      id,
      ok: reachable,
      transport: 'http',
      latencyMs: Date.now() - started,
      error: reachable ? undefined : `HTTP ${res.status}`
    }
  } catch (err) {
    return {
      id,
      ok: false,
      transport: 'http',
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

async function probeStdio(
  id: string,
  command: string,
  config: Record<string, unknown>
): Promise<McpProbeResult> {
  const args = Array.isArray(config.args) ? config.args.filter((a): a is string => typeof a === 'string') : []
  const extraEnv =
    config.env && typeof config.env === 'object' ? (config.env as Record<string, string>) : {}
  const started = Date.now()

  return new Promise<McpProbeResult>((resolvePromise) => {
    let settled = false
    const done = (result: McpProbeResult): void => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出
      }
      resolvePromise(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      resolvePromise({
        id,
        ok: false,
        transport: 'stdio',
        error: err instanceof Error ? err.message : String(err)
      })
      return
    }

    const timer = setTimeout(
      () => done({ id, ok: false, transport: 'stdio', latencyMs: Date.now() - started, error: `无响应(${PROBE_TIMEOUT_MS}ms 超时)` }),
      PROBE_TIMEOUT_MS
    )

    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      // MCP stdio 按行分帧 JSON-RPC
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        try {
          const msg = JSON.parse(text) as Record<string, unknown>
          if (msg.id === 1 && msg.result && typeof msg.result === 'object') {
            const result = msg.result as Record<string, unknown>
            const info = (result.serverInfo ?? {}) as Record<string, unknown>
            clearTimeout(timer)
            done({
              id,
              ok: true,
              transport: 'stdio',
              serverName: typeof info.name === 'string' ? info.name : undefined,
              serverVersion: typeof info.version === 'string' ? info.version : undefined,
              latencyMs: Date.now() - started
            })
            return
          }
        } catch {
          // 非 JSON 行(server 日志),忽略
        }
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      done({ id, ok: false, transport: 'stdio', error: err.message })
    })
    child.on('exit', (code) => {
      if (!settled) {
        clearTimeout(timer)
        done({
          id,
          ok: false,
          transport: 'stdio',
          latencyMs: Date.now() - started,
          error: `进程退出(code ${code ?? 'null'}),未完成 initialize 握手`
        })
      }
    })

    // 发 MCP initialize 请求(JSON-RPC 2.0,行分帧)
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'caogen-probe', version: '1.0' }
      }
    }
    void delay(50).then(() => {
      try {
        child.stdin?.write(`${JSON.stringify(initialize)}\n`)
      } catch {
        // 进程可能已退出,exit 分支兜底
      }
    })
  })
}
