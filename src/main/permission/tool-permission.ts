import { fileURLToPath } from 'node:url'
import { isAbsolute, posix, relative, resolve } from 'node:path'
import type { AppSettings, ToolRiskLevel } from '../../shared/types'

export type ToolPermissionDecisionKind = 'allow' | 'deny' | 'neutral'

export interface ToolRiskAssessment {
  level: ToolRiskLevel
  reasons: string[]
  path?: string
  paths?: string[]
  pathInsideCwd?: boolean
  invalidInput?: boolean
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

interface ExtractedPaths {
  values: string[]
  invalidReason?: string
}

interface ClassifiedPath {
  path: string
  inside: boolean
  sensitive: boolean
}

interface ClassifiedRequestPaths {
  states: ClassifiedPath[]
  rejection?: ToolRiskAssessment
}

type PathRuleMatchMode = 'any' | 'all'

const RISK_ORDER: ToolRiskLevel[] = ['low', 'medium', 'high', 'critical']
const READ_TOOLS = new Set(['read_file', 'view', 'list_dir', 'search_symbol', 'search_code', 'find_file', 'get_dependencies', 'task_decompose'])
const EDIT_TOOLS = new Set(['write_file', 'search_replace', 'edit_file'])
const FIXED_MUTATION_RISKS: Partial<Record<string, { level: ToolRiskLevel; reason: string }>> = {
  git_stage: { level: 'medium', reason: '暂存指定 Git 文件' },
  git_stage_all: { level: 'high', reason: '暂存当前范围全部 Git 变更' },
  mcp_discover: { level: 'high', reason: 'MCP 连接可能启动本机进程或访问外部服务' },
  mcp_call_tool: { level: 'high', reason: 'MCP 连接可能启动本机进程或调用外部工具' }
}
const BLOCKED_CODE_FORGE_MODES = new Set(['commit', 'pr'])
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
  const classifiedPaths = classifyRequestPaths(toolName, input, cwd)
  if (classifiedPaths.rejection) return classifiedPaths.rejection
  const pathStates = classifiedPaths.states

  let level: ToolRiskLevel = 'medium'
  if (READ_TOOLS.has(toolName)) {
    level = 'low'
    reasons.push('只读工具')
  } else if (toolName === 'search_replace' && input.dry_run === true) {
    level = 'low'
    reasons.push('只读替换预览')
  } else if (EDIT_TOOLS.has(toolName)) {
    level = 'medium'
    reasons.push('文件写入工具')
  } else if (FIXED_MUTATION_RISKS[toolName]) {
    const fixedRisk = FIXED_MUTATION_RISKS[toolName] as { level: ToolRiskLevel; reason: string }
    level = fixedRisk.level
    reasons.push(fixedRisk.reason)
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
    const codeForge = classifyCodeForgeRisk(input)
    level = codeForge.level
    reasons.push(codeForge.reason)
  } else {
    level = 'medium'
    reasons.push('未知或扩展工具')
  }

  if (pathStates.some((state) => state.sensitive)) {
    level = maxRisk(level, 'high')
    reasons.push('敏感路径')
  }

  return {
    level,
    reasons,
    path: pathStates[0]?.path,
    paths: pathStates.length > 0 ? pathStates.map((state) => state.path) : undefined,
    pathInsideCwd: pathStates.length > 0 ? true : undefined
  }
}

function classifyRequestPaths(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): ClassifiedRequestPaths {
  const extracted = extractPaths(toolName, input)
  if (extracted.invalidReason) {
    return {
      states: [],
      rejection: {
        level: 'critical',
        reasons: [extracted.invalidReason],
        pathInsideCwd: false,
        invalidInput: true
      }
    }
  }
  const states = extracted.values.map((value) => classifyPath(cwd, value))
  const outside = states.find((state) => !state.inside)
  if (!outside) return { states }
  return {
    states,
    rejection: {
      level: 'critical',
      reasons: ['路径越界'],
      path: outside.path,
      paths: states.map((state) => state.path),
      pathInsideCwd: false
    }
  }
}

function classifyCodeForgeRisk(input: Record<string, unknown>): { level: ToolRiskLevel; reason: string } {
  const mode = stringField(input.mode)
  if (BLOCKED_CODE_FORGE_MODES.has(mode)) {
    return { level: 'high', reason: '已停用的 Code Forge 复合持久交付请求' }
  }
  const legacyInput = input.createPatch === true ||
    input.verificationCommand !== undefined ||
    input.verificationCommands !== undefined ||
    ['repoRoot', 'worktreePath', 'baseSha', 'baseBranch', 'branch'].some((field) => input[field] !== undefined)
  if ((mode === '' || mode === 'report') && !legacyInput) {
    return { level: 'low', reason: '只读 Code Forge 交付报告' }
  }
  return { level: 'medium', reason: 'Code Forge 会生成可查询 patch artifact' }
}

export function evaluateToolPermission(
  settings: AppSettings,
  request: ToolPermissionRequest
): ToolPermissionDecision {
  const risk = classifyToolRisk(request.toolName, request.input, request.cwd)
  if (risk.invalidInput) {
    return { kind: 'deny', reason: `无效工具输入:${risk.reasons.join(',')}`, risk }
  }
  const deny = findMatchingRule(
    joinRules(settings.permissionDenylist, settings.disallowedTools),
    request,
    risk,
    'any'
  )
  if (deny) {
    return { kind: 'deny', reason: `命中黑名单:${deny.raw}`, risk, matchedRule: deny.raw }
  }

  const temporary = findMatchingRule(settings.permissionTemporaryAllowlist, request, risk, 'all')
  if (temporary) {
    return { kind: 'allow', reason: `命中临时允许:${temporary.raw}`, risk, matchedRule: temporary.raw }
  }

  const allow = findMatchingRule(
    joinRules(settings.permissionAllowlist, settings.allowedTools),
    request,
    risk,
    'all'
  )
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

function extractPaths(toolName: string, input: Record<string, unknown>): ExtractedPaths {
  if (toolName === 'git_stage') return extractGitStagePaths(input.paths)
  const pathValue = extractPath(toolName, input)
  return { values: pathValue ? [pathValue] : [] }
}

function extractGitStagePaths(value: unknown): ExtractedPaths {
  if (!Array.isArray(value) || value.length === 0) {
    return { values: [], invalidReason: 'git_stage paths 必须是非空数组' }
  }
  const paths: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      return { values: [], invalidReason: 'git_stage paths 只接受字符串路径' }
    }
    const normalized = candidate.trim()
    if (normalized !== candidate || !isValidGitStagePath(normalized)) {
      return { values: [], invalidReason: 'git_stage paths 包含空值、绝对路径、越界路径或 pathspec' }
    }
    paths.push(normalized)
  }
  return { values: paths }
}

function isValidGitStagePath(value: string): boolean {
  if (!value || value.includes('\0')) return false
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return false
  if (value.startsWith(':')) return false
  const normalized = posix.normalize(value.replace(/\\/g, '/'))
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../')
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

function classifyPath(cwd: string, rawPath: string): ClassifiedPath {
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
  risk: ToolRiskAssessment,
  pathMode: PathRuleMatchMode
): PermissionRule | undefined {
  const rules = parseRules(rawRules, request.now ?? Date.now())
  return rules.find((rule) => matchesRule(rule, request, risk, pathMode))
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
  risk: ToolRiskAssessment,
  pathMode: PathRuleMatchMode
): boolean {
  if (rule.tool && !wildcardMatch(rule.tool, request.toolName)) return false
  if (rule.path && !matchesRiskPaths(rule.path, risk, request.cwd, pathMode)) return false
  if (rule.risk && risk.level !== rule.risk) return false
  if (rule.riskAtLeast && compareRisk(risk.level, rule.riskAtLeast) < 0) return false
  if (rule.riskAtMost && compareRisk(risk.level, rule.riskAtMost) > 0) return false
  return true
}

function matchesRiskPaths(
  pattern: string,
  risk: ToolRiskAssessment,
  cwd: string,
  mode: PathRuleMatchMode
): boolean {
  const paths = risk.paths ?? (risk.path ? [risk.path] : [])
  if (paths.length === 0) return false
  const matches = (candidate: string): boolean => pathMatches(pattern, candidate, cwd)
  return mode === 'any' ? paths.some(matches) : paths.every(matches)
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
