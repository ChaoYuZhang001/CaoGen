import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const CONTEXT_FILES = ['caogen.md', '.caogen.md', 'README.md'] as const
const ROOT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'tsconfig.json'
] as const
const MAX_CONTEXT_BYTES = 48 * 1024
const MAX_PROMPT_CHARS = 32_000

export type ProjectContextFileName = (typeof CONTEXT_FILES)[number]

export interface ProjectContextSource {
  fileName: ProjectContextFileName
  path: string
  bytes: number
  truncated: boolean
}

export interface ProjectDetectedStack {
  packageName?: string
  packageManager?: string
  nodeScripts: Array<{ name: string; command: string }>
  dependencies: Array<{ name: string; version: string; scope: 'runtime' | 'dev' }>
  techStack: string[]
  python?: { projectName?: string; dependencies: string[] }
  go?: { module?: string; version?: string; requirements: string[] }
  rust?: { packageName?: string; dependencies: string[] }
}

export interface ProjectContextReadResult {
  projectRoot: string
  source?: ProjectContextSource
  content: string
  detected: ProjectDetectedStack
  template: string
  prompt: string
}

interface ReadTextResult {
  text: string
  bytes: number
  truncated: boolean
}

/** 定位项目根目录:优先包含 caogen 上下文文件的上级目录,其次常见工程根标记。 */
export function resolveProjectRoot(startPath: string): string {
  const start = normalizeExistingDirectory(startPath)
  let current = start
  let firstMarkerDir: string | null = null
  while (true) {
    if (CONTEXT_FILES.some((name) => existsSync(join(current, name)))) return current
    if (!firstMarkerDir && ROOT_MARKERS.some((name) => existsSync(join(current, name)))) {
      firstMarkerDir = current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return firstMarkerDir ?? start
}

export function readProjectContext(projectPath: string): ProjectContextReadResult {
  const projectRoot = resolveProjectRoot(projectPath)
  const source = findContextSource(projectRoot)
  const content = source ? readTextLimited(source.path, MAX_CONTEXT_BYTES).text : ''
  const detected = detectProjectStack(projectRoot)
  const template = generateProjectContextTemplate(projectRoot, detected)
  const prompt = renderProjectContextPrompt({ projectRoot, source, content, detected })
  return { projectRoot, source, content, detected, template, prompt }
}

export async function loadProjectContext(projectPath: string): Promise<ProjectContextReadResult> {
  return readProjectContext(projectPath)
}

export function buildProjectContextSystemAppendSync(projectPath: string): string {
  try {
    return readProjectContext(projectPath).prompt
  } catch (err) {
    console.error('[caogen] 读取项目上下文失败:', err)
    return ''
  }
}

export async function buildProjectContextSystemAppend(projectPath: string): Promise<string> {
  return buildProjectContextSystemAppendSync(projectPath)
}

export function writeProjectContext(projectPath: string, content: string): ProjectContextReadResult {
  if (typeof content !== 'string') throw new Error('caogen.md 内容必须是字符串')
  const projectRoot = resolveProjectRoot(projectPath)
  const target = join(projectRoot, 'caogen.md')
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(target, content, 'utf8')
  return readProjectContext(projectRoot)
}

export function generateProjectContextTemplate(
  projectPath: string,
  detected = detectProjectStack(resolveProjectRoot(projectPath))
): string {
  const commands = detected.nodeScripts.slice(0, 8)
  const commandLines =
    commands.length > 0
      ? commands.map((item) => `- ${item.name}: ${item.command}`).join('\n')
      : '- install: \n- dev: \n- build: \n- test: '
  const stack = detected.techStack.length > 0 ? detected.techStack.join(' + ') : '请填写主要技术栈'
  return [
    '# 项目概述',
    `技术栈: ${stack}`,
    '架构说明: ',
    '',
    '# 代码规范',
    '- 命名: ',
    '- 格式: ',
    '- 禁止事项: ',
    '',
    '# 常用命令',
    commandLines,
    '',
    '# 测试要求',
    '- 单测规范: ',
    '- 覆盖率要求: ',
    '',
    '# 注意事项',
    '- 禁改文件: ',
    '- 特殊逻辑: ',
    '- 部署风险: ',
    ''
  ].join('\n')
}

function normalizeExistingDirectory(startPath: string): string {
  if (typeof startPath !== 'string' || !startPath.trim()) throw new Error('必须指定项目目录')
  const resolved = resolve(startPath)
  const info = statSync(resolved)
  return info.isDirectory() ? resolved : dirname(resolved)
}

function findContextSource(projectRoot: string): ProjectContextSource | undefined {
  for (const fileName of CONTEXT_FILES) {
    const path = join(projectRoot, fileName)
    if (!existsSync(path)) continue
    const read = readTextLimited(path, MAX_CONTEXT_BYTES)
    return { fileName, path, bytes: read.bytes, truncated: read.truncated }
  }
  return undefined
}

function readTextLimited(filePath: string, maxBytes: number): ReadTextResult {
  const buffer = readFileSync(filePath)
  const sliced = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer
  return {
    text: sliced.toString('utf8'),
    bytes: buffer.byteLength,
    truncated: buffer.byteLength > maxBytes
  }
}

function detectProjectStack(projectRoot: string): ProjectDetectedStack {
  const detected: ProjectDetectedStack = {
    nodeScripts: [],
    dependencies: [],
    techStack: []
  }
  readPackageJson(projectRoot, detected)
  readPyproject(projectRoot, detected)
  readGoMod(projectRoot, detected)
  readCargoToml(projectRoot, detected)
  detected.techStack = [...new Set(detected.techStack)].slice(0, 16)
  return detected
}

function readPackageJson(projectRoot: string, detected: ProjectDetectedStack): void {
  const packagePath = join(projectRoot, 'package.json')
  if (!existsSync(packagePath)) return
  const parsed = readJson(packagePath)
  if (!isRecord(parsed)) return
  if (typeof parsed.name === 'string') detected.packageName = parsed.name
  detected.packageManager = detectPackageManager(projectRoot)
  const scripts = isRecord(parsed.scripts) ? parsed.scripts : {}
  detected.nodeScripts = Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .slice(0, 24)
    .map(([name, command]) => ({ name, command }))
  addDependencies(parsed.dependencies, 'runtime', detected)
  addDependencies(parsed.devDependencies, 'dev', detected)
  inferNodeTech(detected)
}

function readPyproject(projectRoot: string, detected: ProjectDetectedStack): void {
  const filePath = join(projectRoot, 'pyproject.toml')
  if (!existsSync(filePath)) return
  const text = readTextLimited(filePath, 24 * 1024).text
  detected.techStack.push('Python')
  const projectName = matchTomlString(text, 'name')
  const dependencies = matchTomlArray(text, 'dependencies').slice(0, 20)
  detected.python = { projectName, dependencies }
}

function readGoMod(projectRoot: string, detected: ProjectDetectedStack): void {
  const filePath = join(projectRoot, 'go.mod')
  if (!existsSync(filePath)) return
  const text = readTextLimited(filePath, 24 * 1024).text
  detected.techStack.push('Go')
  const module = /^module\s+(.+)$/m.exec(text)?.[1]?.trim()
  const version = /^go\s+(.+)$/m.exec(text)?.[1]?.trim()
  const requirements = [...text.matchAll(/^\s*require\s+([^\s()]+)\s+([^\s()]+)/gm)]
    .slice(0, 20)
    .map((match) => `${match[1]} ${match[2]}`)
  detected.go = { module, version, requirements }
}

function readCargoToml(projectRoot: string, detected: ProjectDetectedStack): void {
  const filePath = join(projectRoot, 'Cargo.toml')
  if (!existsSync(filePath)) return
  const text = readTextLimited(filePath, 24 * 1024).text
  detected.techStack.push('Rust')
  const packageName = matchTomlString(text, 'name')
  const dependencies = extractTomlSectionKeys(text, 'dependencies').slice(0, 20)
  detected.rust = { packageName, dependencies }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch {
    return null
  }
}

function detectPackageManager(projectRoot: string): string | undefined {
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(projectRoot, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(projectRoot, 'package-lock.json'))) return 'npm'
  if (existsSync(join(projectRoot, 'bun.lockb')) || existsSync(join(projectRoot, 'bun.lock'))) return 'bun'
  return undefined
}

function addDependencies(value: unknown, scope: 'runtime' | 'dev', detected: ProjectDetectedStack): void {
  if (!isRecord(value)) return
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== 'string') continue
    detected.dependencies.push({ name, version, scope })
  }
}

function inferNodeTech(detected: ProjectDetectedStack): void {
  const names = new Set(detected.dependencies.map((item) => item.name))
  if (detected.packageName || detected.dependencies.length > 0 || detected.nodeScripts.length > 0) {
    detected.techStack.push('Node.js')
  }
  if (names.has('typescript')) detected.techStack.push('TypeScript')
  if (names.has('react')) detected.techStack.push('React')
  if (names.has('electron')) detected.techStack.push('Electron')
  if (names.has('vite') || names.has('electron-vite')) detected.techStack.push('Vite')
  if (names.has('vue')) detected.techStack.push('Vue')
  if (names.has('next')) detected.techStack.push('Next.js')
  if (names.has('tailwindcss')) detected.techStack.push('Tailwind CSS')
}

function renderProjectContextPrompt(input: {
  projectRoot: string
  source?: ProjectContextSource
  content: string
  detected: ProjectDetectedStack
}): string {
  const parts: string[] = []
  if (input.content.trim()) {
    parts.push(
      [
        '# 项目永久上下文',
        `来源: ${input.source?.path ?? '未找到上下文文件'}`,
        input.source?.truncated ? `提示: 文件超过 ${MAX_CONTEXT_BYTES} 字节,已截断注入。` : '',
        input.content.trim()
      ]
        .filter(Boolean)
        .join('\n')
    )
  }
  const detected = renderDetectedStack(input.detected)
  if (detected) parts.push(detected)
  const prompt = parts.join('\n\n').trim()
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n\n[项目上下文已截断]` : prompt
}

function renderDetectedStack(detected: ProjectDetectedStack): string {
  const lines: string[] = ['# 自动识别项目栈']
  if (detected.techStack.length > 0) lines.push(`- 技术栈: ${detected.techStack.join(', ')}`)
  if (detected.packageName) lines.push(`- package.json: ${detected.packageName}`)
  if (detected.packageManager) lines.push(`- 包管理器: ${detected.packageManager}`)
  if (detected.nodeScripts.length > 0) {
    lines.push('- 常用 npm scripts:')
    for (const item of detected.nodeScripts.slice(0, 12)) lines.push(`  - ${item.name}: ${item.command}`)
  }
  if (detected.dependencies.length > 0) {
    lines.push('- 关键依赖:')
    for (const item of detected.dependencies.slice(0, 24)) {
      lines.push(`  - ${item.name}@${item.version} (${item.scope})`)
    }
  }
  if (detected.python) {
    lines.push(`- Python: ${detected.python.projectName ?? 'pyproject.toml'}`)
    for (const dep of detected.python.dependencies.slice(0, 12)) lines.push(`  - ${dep}`)
  }
  if (detected.go) {
    lines.push(`- Go module: ${detected.go.module ?? 'go.mod'}${detected.go.version ? ` (go ${detected.go.version})` : ''}`)
  }
  if (detected.rust) {
    lines.push(`- Rust crate: ${detected.rust.packageName ?? 'Cargo.toml'}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

function matchTomlString(text: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text)
  return match?.[1]?.trim()
}

function matchTomlArray(text: string, key: string): string[] {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(text)
  if (!match) return []
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1])
}

function extractTomlSectionKeys(text: string, section: string): string[] {
  const sectionMatch = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|\\s*$)`, 'm').exec(text)
  if (!sectionMatch) return []
  return sectionMatch[1]
    .split(/\r?\n/)
    .map((line) => line.split('=')[0]?.trim())
    .filter((line): line is string => Boolean(line && !line.startsWith('#')))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
