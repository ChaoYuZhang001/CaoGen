import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'

export interface SdkAgentLoadResult {
  agents: Record<string, AgentDefinition>
  diagnostics: string[]
}

type Frontmatter = Record<string, string>

const MAX_AGENT_FILES = 120
const MAX_AGENT_BYTES = 96 * 1024

export function loadSdkAgentDefinitions(cwd: string): SdkAgentLoadResult {
  const diagnostics: string[] = []
  const agents: Record<string, AgentDefinition> = {}
  let scanned = 0

  for (const root of agentRoots(cwd)) {
    if (!isDirectory(root)) continue
    for (const file of agentFiles(root)) {
      if (scanned >= MAX_AGENT_FILES) {
        diagnostics.push(`Agent 文件数量超过上限 ${MAX_AGENT_FILES},其余已跳过。`)
        return { agents, diagnostics }
      }
      scanned += 1
      try {
        const parsed = parseAgentFile(file)
        if (!parsed) continue
        const name = uniqueName(parsed.name, agents)
        agents[name] = parsed.definition
      } catch (err) {
        diagnostics.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return { agents, diagnostics }
}

function agentRoots(cwd: string): string[] {
  return [
    join(cwd, '.claude', 'agents'),
    join(homedir(), '.claude', 'agents')
  ]
}

function agentFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of safeReadDir(root)) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    if (ext !== '.md' && ext !== '.json') continue
    files.push(join(root, entry.name))
  }
  return files.sort((a, b) => a.localeCompare(b))
}

function parseAgentFile(filePath: string): { name: string; definition: AgentDefinition } | null {
  const stat = statSync(filePath)
  if (stat.size > MAX_AGENT_BYTES) {
    throw new Error(`Agent 定义超过 ${MAX_AGENT_BYTES} bytes`)
  }
  const text = readFileSync(filePath, 'utf8')
  const ext = extname(filePath).toLowerCase()
  return ext === '.json' ? parseJsonAgent(filePath, text) : parseMarkdownAgent(filePath, text)
}

function parseJsonAgent(filePath: string, text: string): { name: string; definition: AgentDefinition } | null {
  const value = JSON.parse(text) as unknown
  if (!isRecord(value)) return null
  const name = normalizeAgentName(firstString(value.name, value.type, basename(filePath, '.json')))
  const description = firstString(value.description, value.summary)
  const prompt = firstString(value.prompt, value.systemPrompt, value.instructions)
  if (!prompt) throw new Error('JSON Agent 缺少 prompt/systemPrompt/instructions')
  const tools = stringArray(value.tools)
  const disallowedTools = stringArray(value.disallowedTools)
  const skills = stringArray(value.skills)
  const model = firstString(value.model)
  const initialPrompt = firstString(value.initialPrompt)
  const maxTurns = numberValue(value.maxTurns)
  return {
    name,
    definition: {
      description: description || firstLine(prompt) || name,
      prompt,
      ...(tools.length > 0 ? { tools } : {}),
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(model ? { model } : {}),
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {})
    }
  }
}

function parseMarkdownAgent(filePath: string, text: string): { name: string; definition: AgentDefinition } | null {
  const parsed = splitFrontmatter(text)
  const name = normalizeAgentName(parsed.frontmatter.name || parsed.frontmatter.title || basename(filePath, '.md'))
  const prompt = parsed.body.trim()
  if (!prompt) throw new Error('Markdown Agent 缺少正文 prompt')
  const tools = listValue(parsed.frontmatter.tools)
  const disallowedTools = listValue(parsed.frontmatter.disallowedTools)
  const skills = listValue(parsed.frontmatter.skills)
  return {
    name,
    definition: {
      description: parsed.frontmatter.description || parsed.frontmatter.summary || firstLine(prompt) || name,
      prompt,
      ...(tools.length > 0 ? { tools } : {}),
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(parsed.frontmatter.model ? { model: parsed.frontmatter.model } : {})
    }
  }
}

function splitFrontmatter(text: string): { frontmatter: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { frontmatter: {}, body: text }
  const frontmatter: Frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const found = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (!found) continue
    frontmatter[found[1]] = trimQuotes(found[2])
  }
  return { frontmatter, body: text.slice(match[0].length) }
}

function uniqueName(baseName: string, agents: Record<string, AgentDefinition>): string {
  let name = baseName
  let index = 2
  while (Object.prototype.hasOwnProperty.call(agents, name)) {
    name = `${baseName}-${index}`
    index += 1
  }
  return name
}

function normalizeAgentName(value: string): string {
  const clean = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return clean || 'agent'
}

function firstLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean) ?? ''
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function listValue(value: string | undefined): string[] {
  if (!value) return []
  const body = value.replace(/^\[/, '').replace(/\]$/, '')
  return body
    .split(',')
    .map((item) => trimQuotes(item).trim())
    .filter(Boolean)
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.floor(value))
}

function trimQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function safeReadDir(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}
