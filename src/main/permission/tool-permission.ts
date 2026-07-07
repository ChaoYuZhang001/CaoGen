import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'
import type { AppSettings, ToolRiskLevel } from '../../shared/types'

export type ToolPermissionDecisionKind = 'allow' | 'deny' | 'neutral'

export interface ToolRiskAssessment {
  level: ToolRiskLevel
  reasons: string[]
  path?: string
  pathInsideCwd?: boolean
}

export interface ToolPermissionDecision {
  kind: ToolPermissionDecisionKind
  reason: string
  risk: ToolRiskAssessment
  matchedRule?: string
}

interface ToolPermissionRequest {
  toolName: string
  input: Record<string, unknown>
  cwd: string
  now?: number
}

interface PermissionRule {
  raw: string
  tool?: string
  path?: string
  risk?: ToolRiskLevel
  riskAtLeast?: ToolRiskLevel
  riskAtMost?: ToolRiskLevel
  until?: number
}

const RISK_ORDER: ToolRiskLevel[] = ['low', 'medium', 'high', 'critical']
const READ_TOOLS = new Set(['read_file', 'view', 'list_dir', 'search_symbol', 'search_code', 'find_file', 'get_dependencies', 'task_decompose'])
const EDIT_TOOLS = new Set(['write_file', 'search_replace', 'edit_file'])
const CRITICAL_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+(?:\/|\*)/i,
  /\bdel\s+\/[sq]\b/i,
  /\brmdir\s+\/s\b/i,
  /\bRemove-Item\b[\s\S]*\b-Recurse\b[\s\S]*\b-Force\b/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\breg\s+delete\b/i
]
const HIGH_COMMAND_PATTERNS = [
  /\bsudo\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|powershell)\b/i,
  /\bInvoke-Expression\b/i,
  /\bpowershell\b[\s\S]*(?:-enc|-encodedcommand)\b/i
]

export function classifyToolRisk(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): ToolRiskAssessment {
  const reasons: string[] = []
  const pathValue = extractPath(toolName, input)
  const pathState = pathValue ? classifyPath(cwd, pathValue) : undefined
  if (pathState && !pathState.inside) {
    reasons.push('路径越界')
    return { level: 'critical', reasons, path: pathState.path, pathInsideCwd: false }
  }

  let level: ToolRiskLevel = 'medium'
  if (READ_TOOLS.has(toolName)) {
    level = 'low'
    reasons.push('只读工具')
  } else if (EDIT_TOOLS.has(toolName)) {
    level = 'medium'
    reasons.push('文件写入工具')
  } else if (toolName === 'bash') {
    const command = stringField(input.command)
    const commandRisk = classifyCommand(command)
    level = commandRisk.level
    reasons.push(commandRisk.reason)
  } else if (toolName.startsWith('gui_')) {
    level = 'high'
    reasons.push('GUI 自动化工具')
  } else if (toolName === 'task_dispatch_dag' || toolName === 'task_decompose_and_dispatch_dag') {
    level = 'high'
    reasons.push('多 Agent DAG 调度会创建子会话和 worktree')
  } else if (toolName === 'genesis_orchestrate') {
    level = 'high'
    reasons.push('Genesis 编排会规划多 Agent、隔离执行、验证 gate 和交付策略')
  } else if (toolName === 'code_forge_delivery') {
    const mode = stringField(input.mode)
    if (mode === 'commit' || mode === 'pr') {
      level = 'high'
      reasons.push('Code Forge 会提交或发布工程交付产物')
    } else {
      level = 'medium'
      reasons.push('Code Forge 会运行验证并生成交付报告或补丁')
    }
  } else {
    level = 'medium'
    reasons.push('未知或扩展工具')
  }

  if (pathState?.sensitive) {
    level = maxRisk(level, 'high')
    reasons.push('敏感路径')
  }

  return {
    level,
    reasons,
    path: pathState?.path,
    pathInsideCwd: pathState?.inside
  }
}

export function evaluateToolPermission(
  settings: AppSettings,
  request: ToolPermissionRequest
): ToolPermissionDecision {
  const risk = classifyToolRisk(request.toolName, request.input, request.cwd)
  const deny = findMatchingRule(joinRules(settings.permissionDenylist, settings.disallowedTools), request, risk)
  if (deny) {
    return { kind: 'deny', reason: `命中黑名单:${deny.raw}`, risk, matchedRule: deny.raw }
  }

  const temporary = findMatchingRule(settings.permissionTemporaryAllowlist, request, risk)
  if (temporary) {
    return { kind: 'allow', reason: `命中临时允许:${temporary.raw}`, risk, matchedRule: temporary.raw }
  }

  const allow = findMatchingRule(joinRules(settings.permissionAllowlist, settings.allowedTools), request, risk)
  if (allow) {
    return { kind: 'allow', reason: `命中白名单:${allow.raw}`, risk, matchedRule: allow.raw }
  }

  return { kind: 'neutral', reason: `风险等级:${risk.level};${risk.reasons.join(',')}`, risk }
}

function classifyCommand(command: string): { level: ToolRiskLevel; reason: string } {
  if (!command.trim()) return { level: 'medium', reason: '空 shell 命令' }
  if (CRITICAL_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return { level: 'critical', reason: '高破坏性 shell 命令' }
  }
  if (HIGH_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return { level: 'high', reason: '高风险 shell 命令' }
  }
  if (/^\s*(echo|pwd|cd|dir|ls|type|cat|node\s+-v|npm\s+--version|git\s+status)\b/i.test(command)) {
    return { level: 'low', reason: '低风险 shell 命令' }
  }
  return { level: 'medium', reason: '普通 shell 命令' }
}

function extractPath(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'browser_navigate') {
    const pathFromUrl = extractFileUrlPath(input.url)
    if (pathFromUrl) return pathFromUrl
  }
  if (
    toolName === 'task_decompose' ||
    toolName === 'task_dispatch_dag' ||
    toolName === 'task_decompose_and_dispatch_dag' ||
    toolName === 'genesis_orchestrate'
  ) {
    if (typeof input.cwd === 'string' && input.cwd.trim()) return input.cwd
  }
  const candidates = toolName === 'search_replace' || toolName === 'view'
    ? [input.file_path, input.path]
    : [input.path, input.file_path]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return undefined
}

function extractFileUrlPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'file:') return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

function classifyPath(cwd: string, rawPath: string): { path: string; inside: boolean; sensitive: boolean } {
  const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath)
  const rel = relative(resolve(cwd), target)
  const inside = !(rel.startsWith('..') || isAbsolute(rel))
  const normalized = rel.replace(/\\/g, '/')
  return {
    path: target,
    inside,
    sensitive: inside && /(^|\/)(\.env|id_rsa|id_ed25519|\.ssh|\.npmrc|\.pypirc)(\/|$)/i.test(normalized)
  }
}

function findMatchingRule(
  rawRules: string | undefined,
  request: ToolPermissionRequest,
  risk: ToolRiskAssessment
): PermissionRule | undefined {
  const rules = parseRules(rawRules, request.now ?? Date.now())
  return rules.find((rule) => matchesRule(rule, request, risk))
}

function parseRules(rawRules: string | undefined, now: number): PermissionRule[] {
  return (rawRules ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => parseRule(line))
    .filter((rule): rule is PermissionRule => rule !== null && (!rule.until || rule.until > now))
}

function parseRule(line: string): PermissionRule | null {
  const rule: PermissionRule = { raw: line }
  const tokens = line.split(/[,\s]+/).filter(Boolean)
  if (tokens.length === 1 && !tokens[0].includes('=')) {
    rule.tool = tokens[0]
    return rule
  }

  for (const token of tokens) {
    const splitAt = token.indexOf('=')
    if (splitAt <= 0) continue
    const key = token.slice(0, splitAt).trim()
    const value = token.slice(splitAt + 1).trim()
    if (!value) continue
    if (token.startsWith('risk>=')) rule.riskAtLeast = parseRisk(token.slice('risk>='.length))
    else if (token.startsWith('risk<=')) rule.riskAtMost = parseRisk(token.slice('risk<='.length))
    else if (key === 'tool') rule.tool = value
    else if (key === 'path') rule.path = value
    else if (key === 'risk') rule.risk = parseRisk(value)
    else if (key === 'until') rule.until = Number(value)
  }

  return rule.tool || rule.path || rule.risk || rule.riskAtLeast || rule.riskAtMost ? rule : null
}

function matchesRule(
  rule: PermissionRule,
  request: ToolPermissionRequest,
  risk: ToolRiskAssessment
): boolean {
  if (rule.tool && !wildcardMatch(rule.tool, request.toolName)) return false
  if (rule.path && (!risk.path || !pathMatches(rule.path, risk.path, request.cwd))) {
    return false
  }
  if (rule.risk && risk.level !== rule.risk) return false
  if (rule.riskAtLeast && compareRisk(risk.level, rule.riskAtLeast) < 0) return false
  if (rule.riskAtMost && compareRisk(risk.level, rule.riskAtMost) > 0) return false
  return true
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  const doubleStarPlaceholder = '\u0000'
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, doubleStarPlaceholder)
    .replace(/\*/g, '[^/\\\\]*')
    .replaceAll(doubleStarPlaceholder, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

function pathMatches(pattern: string, absolutePath: string, cwd: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/')
  const normalizedAbsolute = absolutePath.replace(/\\/g, '/')
  const relativePath = relative(resolve(cwd), absolutePath).replace(/\\/g, '/')
  return wildcardMatch(normalizedPattern, normalizedAbsolute) || wildcardMatch(normalizedPattern, relativePath)
}

function parseRisk(value: string): ToolRiskLevel | undefined {
  return RISK_ORDER.find((risk) => risk === value)
}

function compareRisk(left: ToolRiskLevel, right: ToolRiskLevel): number {
  return RISK_ORDER.indexOf(left) - RISK_ORDER.indexOf(right)
}

function maxRisk(left: ToolRiskLevel, right: ToolRiskLevel): ToolRiskLevel {
  return compareRisk(left, right) >= 0 ? left : right
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function joinRules(...parts: string[]): string {
  return parts.filter((part) => part.trim()).join('\n')
}
