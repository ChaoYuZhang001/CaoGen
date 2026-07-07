import { parseSkillMarkdown, type SkillDefinition, type SkillScope } from './skill-loader'

export type SkillTestSeverity = 'error' | 'warning'

export interface SkillTestDiagnostic {
  code:
    | 'empty_markdown'
    | 'oversized_markdown'
    | 'parse_failed'
    | 'missing_name'
    | 'missing_description'
    | 'missing_steps'
    | 'missing_verification'
    | 'dangerous_command'
    | 'unsafe_path'
    | 'secret_reference'
    | 'weak_trigger'
  severity: SkillTestSeverity
  message: string
  line?: number
  excerpt?: string
}

export interface SkillTesterOptions {
  maxBytes?: number
  sourcePath?: string
  scope?: SkillScope
  requireTrigger?: boolean
}

export interface SkillTestResult {
  ok: boolean
  skill?: SkillDefinition
  diagnostics: SkillTestDiagnostic[]
}

const DEFAULT_MAX_BYTES = 128 * 1024

const DANGEROUS_PATTERNS: Array<{ code: SkillTestDiagnostic['code']; pattern: RegExp; message: string }> = [
  { code: 'dangerous_command', pattern: /\brm\s+-rf\b/i, message: '包含 rm -rf 破坏性删除命令。' },
  { code: 'dangerous_command', pattern: /\bRemove-Item\b[\s\S]{0,80}\b-Recurse\b/i, message: '包含递归删除命令。' },
  { code: 'dangerous_command', pattern: /\bdel\b[\s\S]{0,80}\s\/[sq]\b/i, message: '包含 Windows 静默/递归删除命令。' },
  { code: 'dangerous_command', pattern: /\bformat\s+[A-Z]:/i, message: '包含格式化磁盘命令。' },
  { code: 'dangerous_command', pattern: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[\s\S]{0,120}\|\s*(?:sh|bash|iex|Invoke-Expression)\b/i, message: '包含远程脚本直接执行模式。' },
  { code: 'unsafe_path', pattern: /(?:^|[\s"'`])(?:\/|[A-Za-z]:\\)(?:Windows|System32|Users|home|etc)\b/i, message: '引用了高风险绝对系统路径。' },
  { code: 'unsafe_path', pattern: /\.\.[\\/]/, message: '包含目录上跳路径，可能逃逸项目边界。' },
  { code: 'secret_reference', pattern: /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\b/i, message: '提到了密钥或凭据字段，需人工确认不会沉淀敏感信息。' }
]

export class SkillTester {
  private readonly maxBytes: number
  private readonly sourcePath: string
  private readonly scope: SkillScope
  private readonly requireTrigger: boolean

  constructor(options: SkillTesterOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.sourcePath = options.sourcePath ?? 'generated/SKILL.md'
    this.scope = options.scope ?? 'project'
    this.requireTrigger = options.requireTrigger ?? false
  }

  test(markdown: string): SkillTestResult {
    const diagnostics: SkillTestDiagnostic[] = []
    const raw = markdown.trim()
    if (!raw) {
      return {
        ok: false,
        diagnostics: [{ code: 'empty_markdown', severity: 'error', message: 'SKILL.md 内容为空。' }]
      }
    }

    const bytes = Buffer.byteLength(markdown, 'utf8')
    if (bytes > this.maxBytes) {
      diagnostics.push({
        code: 'oversized_markdown',
        severity: 'error',
        message: `SKILL.md 超过大小限制: ${bytes} > ${this.maxBytes} 字节。`
      })
    }

    let skill: SkillDefinition | undefined
    try {
      skill = parseSkillMarkdown(this.sourcePath, markdown, this.scope)
    } catch (error) {
      diagnostics.push({
        code: 'parse_failed',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }

    if (skill) diagnostics.push(...this.structureDiagnostics(skill))
    diagnostics.push(...staticDiagnostics(markdown))

    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      skill,
      diagnostics
    }
  }

  private structureDiagnostics(skill: SkillDefinition): SkillTestDiagnostic[] {
    const diagnostics: SkillTestDiagnostic[] = []
    if (!skill.name.trim()) diagnostics.push({ code: 'missing_name', severity: 'error', message: '缺少 Skill 名称。' })
    if (!skill.description.trim()) {
      diagnostics.push({ code: 'missing_description', severity: 'error', message: '缺少 Skill 描述。' })
    }
    if (skill.steps.length === 0) {
      diagnostics.push({ code: 'missing_steps', severity: 'error', message: '缺少“执行步骤/Steps”列表。' })
    }
    if (skill.verification.length === 0) {
      diagnostics.push({ code: 'missing_verification', severity: 'error', message: '缺少“验证/Verification”列表。' })
    }
    if (this.requireTrigger && !skill.trigger?.trim()) {
      diagnostics.push({ code: 'weak_trigger', severity: 'warning', message: '未设置 trigger，匹配召回可能偏弱。' })
    }
    return diagnostics
  }
}

export function testSkillMarkdown(markdown: string, options: SkillTesterOptions = {}): SkillTestResult {
  return new SkillTester(options).test(markdown)
}

function staticDiagnostics(markdown: string): SkillTestDiagnostic[] {
  const diagnostics: SkillTestDiagnostic[] = []
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    for (const item of DANGEROUS_PATTERNS) {
      if (!item.pattern.test(line)) continue
      diagnostics.push({
        code: item.code,
        severity: item.code === 'secret_reference' ? 'warning' : 'error',
        message: item.message,
        line: index + 1,
        excerpt: line.trim().slice(0, 180)
      })
    }
  }
  return diagnostics
}
