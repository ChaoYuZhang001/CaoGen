import { callMcpTool, type McpDiscoveryResult, type McpServerConfig, type McpToolDefinition } from './mcp-client'

export interface CaoGenToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface McpToolRuntime {
  canHandle(name: string): boolean
  execute(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }>
}

export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${sanitizeName(serverId)}__${sanitizeName(toolName)}`
}

export function toCaoGenTools(serverId: string, discovery: McpDiscoveryResult): CaoGenToolDefinition[] {
  return discovery.tools.map((tool) => toolToCaoGen(serverId, tool))
}

export function createMcpToolRuntime(configs: Record<string, McpServerConfig>): McpToolRuntime {
  const prefixMap = new Map<string, { serverId: string; config: McpServerConfig }>()
  for (const [serverId, config] of Object.entries(configs)) {
    prefixMap.set(`mcp__${sanitizeName(serverId)}__`, { serverId, config })
  }
  return {
    canHandle(name: string): boolean {
      return findConfig(prefixMap, name) !== null
    },
    async execute(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
      const found = findConfig(prefixMap, name)
      if (!found) return { ok: false, output: `未知 MCP 工具: ${name}` }
      const toolName = name.slice(found.prefix.length).replace(/_/g, '-')
      try {
        const result = await callMcpTool(found.config.config, toolName, args)
        return { ok: result.isError !== true, output: stringifyContent(result.content) }
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error) }
      }
    }
  }
}

function toolToCaoGen(serverId: string, tool: McpToolDefinition): CaoGenToolDefinition {
  const parameters = tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema
    : { type: 'object', properties: {} }
  return {
    type: 'function',
    function: {
      name: mcpToolName(serverId, tool.name),
      description: tool.description || `MCP tool ${tool.name} from ${serverId}`,
      parameters
    }
  }
}

function findConfig(
  prefixMap: Map<string, { serverId: string; config: McpServerConfig }>,
  name: string
): { prefix: string; config: { serverId: string; config: McpServerConfig } } | null {
  for (const [prefix, config] of prefixMap.entries()) {
    if (name.startsWith(prefix)) return { prefix, config }
  }
  return null
}

function stringifyContent(content: unknown[]): string {
  return content.map((item) => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text
    return JSON.stringify(item)
  }).join('\n')
}

function sanitizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'server'
}
