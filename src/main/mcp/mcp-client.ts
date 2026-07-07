import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

export type McpTransport = 'stdio' | 'sse' | 'http'

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: McpTransport
  headers?: Record<string, string>
}

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpResourceDefinition {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpPromptDefinition {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpDiscoveryResult {
  serverInfo?: { name?: string; version?: string }
  tools: McpToolDefinition[]
  resources: McpResourceDefinition[]
  prompts: McpPromptDefinition[]
}

export interface McpCallToolResult {
  content: unknown[]
  isError?: boolean
}

export interface ClaudeDesktopMcpImportResult {
  configPath: string
  servers: Record<string, McpServerConfig>
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface McpClient {
  request(method: string, params?: unknown): Promise<unknown>
  close(): Promise<void>
}

interface SseEvent {
  event: string
  data: string
}

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 10_000

export async function discoverMcpServer(config: McpServerConfig, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpDiscoveryResult> {
  const client = createClient(config, timeoutMs)
  try {
    const initialize = await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'caogen', version: '0.1.2' }
    })
    const [tools, resources, prompts] = await Promise.all([
      client.request('tools/list').catch(() => ({ tools: [] })),
      client.request('resources/list').catch(() => ({ resources: [] })),
      client.request('prompts/list').catch(() => ({ prompts: [] }))
    ])
    return {
      serverInfo: readServerInfo(initialize),
      tools: readArrayField(tools, 'tools').filter(isMcpTool),
      resources: readArrayField(resources, 'resources').filter(isMcpResource),
      prompts: readArrayField(prompts, 'prompts').filter(isMcpPrompt)
    }
  } finally {
    await client.close()
  }
}

export async function callMcpTool(
  config: McpServerConfig,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<McpCallToolResult> {
  const client = createClient(config, timeoutMs)
  try {
    await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'caogen', version: '0.1.2' }
    })
    const result = await client.request('tools/call', { name, arguments: args })
    if (!isRecord(result)) return { content: [{ type: 'text', text: String(result) }] }
    const content = Array.isArray(result.content) ? result.content : []
    return { content, isError: result.isError === true }
  } finally {
    await client.close()
  }
}

export function defaultClaudeDesktopConfigPath(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

export async function loadClaudeDesktopMcpServers(
  configPath = defaultClaudeDesktopConfigPath()
): Promise<ClaudeDesktopMcpImportResult> {
  const resolvedPath = resolve(configPath)
  const raw = await readFile(resolvedPath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) throw new Error('Claude Desktop 配置缺少 mcpServers')

  const servers: Record<string, McpServerConfig> = {}
  for (const [serverId, value] of Object.entries(parsed.mcpServers)) {
    const config = normalizeMcpServerConfig(value)
    if (config) servers[serverId] = config
  }
  return { configPath: resolvedPath, servers }
}

export function builtinMcpServerTemplates(): Record<string, McpServerConfig> {
  return {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      transport: 'stdio'
    },
    git: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-git'],
      transport: 'stdio'
    },
    memory: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      transport: 'stdio'
    },
    sequentialThinking: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      transport: 'stdio'
    }
  }
}

function createClient(config: McpServerConfig, timeoutMs: number): McpClient {
  if (config.command) return createStdioClient(config, timeoutMs)
  if (config.url && config.transport === 'sse') return createSseClient(config, timeoutMs)
  if (config.url) return createHttpClient(config, timeoutMs)
  throw new Error('MCP server 需要 command 或 url')
}

function createHttpClient(config: McpServerConfig, timeoutMs: number): McpClient {
  let id = 0
  const url = config.url
  if (!url) throw new Error('MCP HTTP URL 不能为空')
  return {
    async request(method: string, params?: unknown): Promise<unknown> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const requestId = ++id
        const body: JsonRpcRequest = { jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(config.headers ?? {}) },
          body: JSON.stringify(body),
          signal: controller.signal
        })
        if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
        if (isEventStreamResponse(response)) return await readSseResponse(response, requestId, controller)
        return decodeResponse(await response.json(), requestId)
      } finally {
        clearTimeout(timer)
      }
    },
    async close(): Promise<void> {
      return undefined
    }
  }
}

function createSseClient(config: McpServerConfig, timeoutMs: number): McpClient {
  const url = config.url
  if (!url) throw new Error('MCP SSE URL 不能为空')

  let id = 0
  let endpoint: string | null = null
  let closed = false
  const controller = new AbortController()
  const pending = new Map<number, PendingRequest>()
  let endpointReadyResolve: (() => void) | null = null
  const endpointReady = new Promise<void>((resolveReady) => {
    endpointReadyResolve = resolveReady
  })
  const ready = openSseStream(url, config.headers, controller, (event) => {
    if (event.event === 'endpoint') {
      endpoint = resolveSseEndpoint(url, event.data)
      endpointReadyResolve?.()
      return
    }
    const message = parseJsonRpcEvent(event.data)
    if (!message || typeof message.id !== 'number') return
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    clearTimeout(item.timer)
    try {
      item.resolve(decodeResponse(message, message.id))
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }).catch((error) => {
    rejectPending(pending, error instanceof Error ? error : new Error(String(error)))
  })

  return {
    async request(method: string, params?: unknown): Promise<unknown> {
      if (closed) throw new Error('MCP SSE client 已关闭')
      await ready
      await endpointReady
      if (!endpoint) throw new Error('MCP SSE server 未返回 endpoint 事件')

      const requestId = ++id
      const payload: JsonRpcRequest = { jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }
      return await new Promise<unknown>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          rejectPromise(new Error(`MCP SSE 请求超时: ${method}`))
        }, timeoutMs)
        pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, timer })
        void fetch(endpoint as string, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(config.headers ?? {}) },
          body: JSON.stringify(payload)
        }).then((response) => {
          if (!response.ok) throw new Error(`MCP SSE POST ${response.status}`)
        }).catch((error) => {
          pending.delete(requestId)
          clearTimeout(timer)
          rejectPromise(error instanceof Error ? error : new Error(String(error)))
        })
      })
    },
    async close(): Promise<void> {
      closed = true
      controller.abort()
      rejectPending(pending, new Error('MCP SSE client 已关闭'))
    }
  }
}

function createStdioClient(config: McpServerConfig, timeoutMs: number): McpClient {
  const args = Array.isArray(config.args) ? config.args : []
  const child = spawn(config.command as string, args, {
    env: { ...process.env, ...(config.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let id = 0
  let buffer = ''
  const pending = new Map<number, PendingRequest>()

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let message: JsonRpcResponse
      try {
        message = JSON.parse(trimmed) as JsonRpcResponse
      } catch {
        continue
      }
      if (typeof message.id !== 'number') continue
      const item = pending.get(message.id)
      if (!item) continue
      pending.delete(message.id)
      clearTimeout(item.timer)
      try {
        item.resolve(decodeResponse(message, message.id))
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })

  child.on('error', (error) => rejectAll(child, pending, error))
  child.on('exit', (code) => rejectAll(child, pending, new Error(`MCP stdio 进程退出: ${code ?? 'null'}`)))

  return {
    request(method: string, params?: unknown): Promise<unknown> {
      const requestId = ++id
      const payload: JsonRpcRequest = { jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          rejectPromise(new Error(`MCP 请求超时: ${method}`))
        }, timeoutMs)
        pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, timer })
        child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8')
      })
    },
    async close(): Promise<void> {
      for (const item of pending.values()) clearTimeout(item.timer)
      pending.clear()
      if (!child.killed) child.kill()
    }
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

function rejectAll(child: ChildProcessWithoutNullStreams, pending: Map<number, PendingRequest>, error: Error): void {
  rejectPending(pending, error)
  if (!child.killed) child.kill()
}

function rejectPending(pending: Map<number, PendingRequest>, error: Error): void {
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(error)
  }
  pending.clear()
}

function decodeResponse(value: unknown, id: number): unknown {
  if (!isRecord(value)) throw new Error(`MCP 响应不是对象: ${id}`)
  if (isRecord(value.error)) {
    const message = typeof value.error.message === 'string' ? value.error.message : JSON.stringify(value.error)
    throw new Error(`MCP 错误: ${message}`)
  }
  return value.result
}

async function readSseResponse(response: Response, id: number, controller: AbortController): Promise<unknown> {
  if (!response.body) throw new Error('MCP SSE 响应缺少 body')
  for await (const event of iterateSseEvents(response.body)) {
    const message = parseJsonRpcEvent(event.data)
    if (!message || message.id !== id) continue
    controller.abort()
    return decodeResponse(message, id)
  }
  throw new Error(`MCP SSE 响应未包含请求 ${id}`)
}

async function openSseStream(
  url: string,
  headers: Record<string, string> | undefined,
  controller: AbortController,
  onEvent: (event: SseEvent) => void
): Promise<void> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'text/event-stream', ...(headers ?? {}) },
    signal: controller.signal
  })
  if (!response.ok) throw new Error(`MCP SSE GET ${response.status}`)
  if (!response.body) throw new Error('MCP SSE stream 缺少 body')
  ;(async () => {
    try {
      for await (const event of iterateSseEvents(response.body as ReadableStream<Uint8Array>)) onEvent(event)
    } catch (error) {
      if (!controller.signal.aborted) throw error
    }
  })().catch(() => undefined)
}

async function* iterateSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const event = parseSseEvent(part)
        if (event) yield event
      }
    }
    buffer += decoder.decode()
    const event = parseSseEvent(buffer)
    if (event) yield event
  } finally {
    reader.releaseLock()
  }
}

function parseSseEvent(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/)
  let event = 'message'
  const data: string[] = []
  for (const line of lines) {
    if (line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'event') event = value || 'message'
    if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

function parseJsonRpcEvent(data: string): JsonRpcResponse | null {
  try {
    const parsed = JSON.parse(data) as unknown
    return isRecord(parsed) ? (parsed as JsonRpcResponse) : null
  } catch {
    return null
  }
}

function isEventStreamResponse(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
}

function resolveSseEndpoint(baseUrl: string, endpointValue: string): string {
  try {
    return new URL(endpointValue, baseUrl).toString()
  } catch {
    throw new Error(`MCP SSE endpoint 无效: ${endpointValue}`)
  }
}

function readServerInfo(value: unknown): { name?: string; version?: string } | undefined {
  if (!isRecord(value) || !isRecord(value.serverInfo)) return undefined
  return {
    name: typeof value.serverInfo.name === 'string' ? value.serverInfo.name : undefined,
    version: typeof value.serverInfo.version === 'string' ? value.serverInfo.version : undefined
  }
}

function readArrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return []
  return value[key]
}

function isMcpTool(value: unknown): value is McpToolDefinition {
  return isRecord(value) && typeof value.name === 'string'
}

function isMcpResource(value: unknown): value is McpResourceDefinition {
  return isRecord(value) && typeof value.uri === 'string'
}

function isMcpPrompt(value: unknown): value is McpPromptDefinition {
  return isRecord(value) && typeof value.name === 'string'
}

function normalizeMcpServerConfig(value: unknown): McpServerConfig | null {
  if (!isRecord(value)) return null
  const command = typeof value.command === 'string' && value.command.trim() ? value.command.trim() : undefined
  const url = typeof value.url === 'string' && value.url.trim() ? value.url.trim() : undefined
  const transport =
    value.transport === 'stdio' || value.transport === 'sse' || value.transport === 'http'
      ? value.transport
      : url
        ? 'http'
        : command
          ? 'stdio'
          : undefined
  if (!command && !url) return null
  const env = isStringRecord(value.env)
  const headers = isStringRecord(value.headers)
  return {
    ...(command ? { command } : {}),
    ...(Array.isArray(value.args) ? { args: value.args.filter((item): item is string => typeof item === 'string') } : {}),
    ...(env ? { env } : {}),
    ...(url ? { url } : {}),
    ...(transport ? { transport } : {}),
    ...(headers ? { headers } : {})
  }
}

function isStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
