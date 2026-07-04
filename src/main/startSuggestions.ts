import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { StartSuggestion, StartSuggestionPriority } from '../shared/types'

export interface StartSuggestionSignal {
  id?: string
  title?: string
  body?: string
  summary?: string
  source?: string
  status?: string
  kind?: string
  path?: string
  updatedAt?: string | number
  failed?: boolean
  ok?: boolean
  error?: string
  nextSteps?: string[]
}

export interface StartSuggestionInput {
  projectDir: string
  historySummaries?: StartSuggestionSignal[]
  worktreeSummaries?: StartSuggestionSignal[]
  memoryEntries?: StartSuggestionSignal[]
  routineSummaries?: StartSuggestionSignal[]
  routineRuns?: StartSuggestionSignal[]
  recentFailures?: StartSuggestionSignal[]
  maxSuggestions?: number
  maxFileBytes?: number
  maxTextChars?: number
}

export type StartSuggestionOptions = Omit<StartSuggestionInput, 'projectDir'>

interface ProjectContext {
  root: string
  realRoot: string
  maxFileBytes: number
  maxTextChars: number
}

interface RootFile {
  relPath: string
  size: number
  text: string
}

interface RootFileStat {
  relPath: string
  size: number
}

interface GitStatusSummary {
  total: number
  staged: number
  unstaged: number
  untracked: number
  samples: string[]
}

interface PackageSummary {
  name: string
  scripts: string[]
}

const DEFAULT_MAX_FILE_BYTES = 128_000
const DEFAULT_MAX_TEXT_CHARS = 64_000
const DEFAULT_MAX_SUGGESTIONS = 8
const MAX_GIT_BUFFER = 256_000
const GIT_TIMEOUT_MS = 2_000
const MAX_SIGNAL_TEXT = 280
const MAX_TODO_LINES = 3

const README_FILES = ['README.md', 'README.mdx', 'README.txt', 'README']
const TODO_FILES = ['TODO.md', 'TODO.txt', 'TODO']
const LOCK_FILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']
const PRIORITY_RANK: Record<StartSuggestionPriority, number> = {
  high: 0,
  medium: 1,
  low: 2
}

const TODO_RE = /\b(todo|fixme|xxx|hack|follow[- ]?up|next step|blocked|failing)\b|待办|未完成|下一步|后续|阻塞|失败|报错/i
const FAILURE_RE = /\b(failed|failure|error|exception|crash|blocked|timeout|timed out|cancelled)\b|失败|报错|异常|崩溃|阻塞|超时|取消/i
const UNFINISHED_RE = /\b(todo|pending|follow[- ]?up|next step|unfinished|blocked|wip|continue)\b|待办|未完成|下一步|后续|阻塞|继续/i
const WORKTREE_RE = /\b(conflict|dirty|uncommitted|unmerged|ahead|behind|changed|patch)\b|冲突|未提交|变更|补丁/i

export function getStartSuggestions(
  projectDir: string,
  options: StartSuggestionOptions = {}
): StartSuggestion[] {
  return buildStartSuggestions({ ...options, projectDir })
}

export function buildStartSuggestions(input: StartSuggestionInput): StartSuggestion[] {
  const context = createProjectContext(input)
  if (!context) return []

  const suggestions: StartSuggestion[] = []

  suggestions.push(...failureSuggestions(input))

  const gitStatus = readGitStatus(context.root)
  if (gitStatus && gitStatus.total > 0) suggestions.push(gitStatusSuggestion(gitStatus))

  const readmeTodo = readTodoSuggestion(context, README_FILES, 'readme-todo', 'README next step')
  if (readmeTodo) suggestions.push(readmeTodo)

  const todoFile = readTodoSuggestion(context, TODO_FILES, 'todo-file', 'Project TODO')
  if (todoFile) suggestions.push(todoFile)

  const worktree = worktreeSuggestion(input.worktreeSummaries ?? [])
  if (worktree) suggestions.push(worktree)

  const history = historySuggestion(input.historySummaries ?? [])
  if (history) suggestions.push(history)

  const packageJson = readRootTextFile(context, 'package.json')
  const lockfiles = LOCK_FILES.map((relPath) => statRootFile(context, relPath)).filter(
    (file): file is RootFileStat => file !== null
  )
  suggestions.push(...packageSuggestions(packageJson, lockfiles))

  return limitSuggestions(dedupeSuggestions(suggestions), input.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS)
}

function createProjectContext(input: StartSuggestionInput): ProjectContext | null {
  if (typeof input.projectDir !== 'string' || input.projectDir.trim() === '' || input.projectDir.includes('\0')) {
    return null
  }

  const root = path.resolve(input.projectDir)
  try {
    if (!statSync(root).isDirectory()) return null
    return {
      root,
      realRoot: realpathSync(root),
      maxFileBytes: normalizePositiveInteger(input.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
      maxTextChars: normalizePositiveInteger(input.maxTextChars, DEFAULT_MAX_TEXT_CHARS)
    }
  } catch {
    return null
  }
}

function readTodoSuggestion(
  context: ProjectContext,
  relPaths: string[],
  id: string,
  label: string
): StartSuggestion | null {
  for (const relPath of relPaths) {
    const file = readRootTextFile(context, relPath)
    if (!file) continue
    const lines = extractTodoLines(file.text)
    if (lines.length === 0) continue

    const excerpt = lines
      .slice(0, MAX_TODO_LINES)
      .map((line) => line.text)
      .join(' / ')
    const hasFailure = lines.some((line) => FAILURE_RE.test(line.text))

    return {
      id,
      title: `Pick up ${label}`,
      body: `${file.relPath} contains ${lines.length} actionable marker${lines.length === 1 ? '' : 's'}: ${excerpt}`,
      source: 'readme-todo',
      priority: hasFailure || id === 'todo-file' ? 'high' : 'medium',
      prompt: `Open ${file.relPath}, inspect the TODO/FIXME markers, and propose the smallest useful implementation step. Do not edit unrelated files.`
    }
  }
  return null
}

function failureSuggestions(input: StartSuggestionInput): StartSuggestion[] {
  const suggestions: StartSuggestion[] = []
  const recentFailure = firstFailed(input.recentFailures ?? [])
  if (recentFailure) {
    suggestions.push({
      id: 'recent-failure',
      title: 'Investigate the latest failed run',
      body: summarizeSignal(recentFailure, 'A recent failure was provided.'),
      source: 'recent-failure',
      priority: 'high',
      prompt: 'Review the recent failed run summary, identify the first concrete failure, and make the smallest verified fix.'
    })
  }

  const failedMemory = firstFailed(input.memoryEntries ?? [])
  if (failedMemory) {
    suggestions.push({
      id: 'memory-failure',
      title: 'Resolve the failed memory note',
      body: summarizeSignal(failedMemory, 'A memory entry points at a failed or blocked task.'),
      source: 'memory',
      priority: 'high',
      prompt: 'Use the failed memory entry as context, verify whether the issue still reproduces, and continue from the last confirmed state.'
    })
  }

  const failedRoutine = firstFailed([...(input.routineSummaries ?? []), ...(input.routineRuns ?? [])])
  if (failedRoutine) {
    suggestions.push({
      id: 'routine-failure',
      title: 'Repair the failed routine',
      body: summarizeSignal(failedRoutine, 'A routine summary reports a failed run.'),
      source: 'routine',
      priority: 'high',
      prompt: 'Inspect the failed routine summary, reproduce the failing command if possible, and fix or narrow the failure with evidence.'
    })
  }

  return suggestions
}

function gitStatusSuggestion(status: GitStatusSummary): StartSuggestion {
  const parts = [
    `${status.total} changed file${status.total === 1 ? '' : 's'}`,
    status.staged > 0 ? `${status.staged} staged` : '',
    status.unstaged > 0 ? `${status.unstaged} unstaged` : '',
    status.untracked > 0 ? `${status.untracked} untracked` : ''
  ].filter(Boolean)
  const sample = status.samples.length > 0 ? ` Samples: ${status.samples.join(', ')}` : ''

  return {
    id: 'git-dirty',
    title: 'Review uncommitted work',
    body: `${parts.join(', ')} are present before starting fresh work.${sample}`,
    source: 'git-status',
    priority: 'high',
    prompt: 'Inspect git status and the current diff, separate existing user work from the next task, and avoid reverting unrelated changes.'
  }
}

function worktreeSuggestion(worktrees: StartSuggestionSignal[]): StartSuggestion | null {
  const signal = worktrees.find((entry) => WORKTREE_RE.test(signalText(entry)))
  if (!signal) return null
  const text = signalText(signal)
  const conflict = /\b(conflict|unmerged)\b|冲突/i.test(text)

  return {
    id: 'worktree-review',
    title: conflict ? 'Resolve worktree conflict risk' : 'Review active worktree changes',
    body: summarizeSignal(signal, 'A worktree summary indicates active changes.'),
    source: 'worktree',
    priority: conflict ? 'high' : 'medium',
    prompt: 'Inspect the active worktree summary and decide whether to merge, patch, or leave it isolated before starting new edits.'
  }
}

function historySuggestion(history: StartSuggestionSignal[]): StartSuggestion | null {
  const signal = history.find((entry) => UNFINISHED_RE.test(signalText(entry)))
  if (!signal) return null

  return {
    id: 'history-continue',
    title: 'Continue recent unfinished work',
    body: summarizeSignal(signal, 'Recent history includes unfinished follow-up work.'),
    source: 'history',
    priority: 'medium',
    prompt: 'Read the recent history summary, confirm what remains true in the current repository, and continue only the still-relevant next step.'
  }
}

function packageSuggestions(packageJson: RootFile | null, lockfiles: RootFileStat[]): StartSuggestion[] {
  if (!packageJson) return lockfileSuggestion(lockfiles)

  const summary = parsePackageJson(packageJson.text)
  if (!summary) {
    return [
      {
        id: 'package-json-invalid',
        title: 'Fix package.json parsing',
        body: 'package.json exists but could not be parsed as an object.',
        source: 'package-json',
        priority: 'high',
        prompt: 'Open package.json, identify the JSON syntax or shape problem, and repair it without changing package semantics.'
      },
      ...lockfileSuggestion(lockfiles)
    ]
  }

  const suggestions: StartSuggestion[] = []
  const packageManager = detectPackageManager(lockfiles)
  const verificationScripts = ['typecheck', 'test', 'lint', 'build'].filter((script) =>
    summary.scripts.includes(script)
  )

  if (verificationScripts.length > 0) {
    const commands = verificationScripts.map((script) => formatScriptCommand(packageManager, script))
    suggestions.push({
      id: 'package-verify',
      title: 'Run available verification scripts',
      body: `${summary.name || 'This package'} exposes ${verificationScripts.join(', ')}. Suggested command order: ${commands.join(' && ')}.`,
      source: 'package-json',
      priority: 'medium',
      prompt: `Run the available verification scripts (${commands.join(', ')}), summarize the first failure if any, and fix only the smallest related issue.`
    })
  } else if (summary.scripts.length > 0) {
    suggestions.push({
      id: 'package-scripts',
      title: 'Inspect package scripts',
      body: `${summary.name || 'This package'} defines scripts: ${summary.scripts.slice(0, 6).join(', ')}.`,
      source: 'package-json',
      priority: 'low',
      prompt: 'Inspect package.json scripts and identify the most useful validation or development command for this repository.'
    })
  }

  if (lockfiles.length > 1) {
    suggestions.push({
      id: 'lockfile-multiple',
      title: 'Clarify the package manager',
      body: `Multiple lockfiles were found: ${lockfiles.map((file) => file.relPath).join(', ')}.`,
      source: 'lockfile',
      priority: 'medium',
      prompt: 'Inspect the lockfiles and package metadata, determine the intended package manager, and avoid regenerating unrelated lockfiles.'
    })
  } else {
    suggestions.push(...lockfileSuggestion(lockfiles))
  }

  return suggestions
}

function lockfileSuggestion(lockfiles: RootFileStat[]): StartSuggestion[] {
  if (lockfiles.length !== 1) return []
  const packageManager = detectPackageManager(lockfiles)
  return [
    {
      id: 'lockfile-manager',
      title: `Use ${packageManager} for dependency commands`,
      body: `${lockfiles[0].relPath} is present; keep install and script commands aligned with that lockfile.`,
      source: 'lockfile',
      priority: 'low',
      prompt: `Use ${packageManager} for dependency-related commands in this project unless package metadata proves otherwise.`
    }
  ]
}

function readGitStatus(root: string): GitStatusSummary | null {
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_BUFFER
  })

  if (result.error || result.status !== 0) return null
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) return null

  let staged = 0
  let unstaged = 0
  let untracked = 0
  const samples: string[] = []

  for (const line of lines) {
    const index = line[0] ?? ' '
    const worktree = line[1] ?? ' '
    const file = line.length > 3 ? line.slice(3).trim() : line.trim()
    if (index === '?' && worktree === '?') {
      untracked += 1
    } else {
      if (index !== ' ') staged += 1
      if (worktree !== ' ') unstaged += 1
    }
    if (samples.length < 4 && file) samples.push(file)
  }

  return { total: lines.length, staged, unstaged, untracked, samples }
}

function readRootTextFile(context: ProjectContext, relPath: string): RootFile | null {
  const file = statRootFile(context, relPath)
  if (!file || file.size > context.maxFileBytes) return null

  const fullPath = safeRootPath(context, relPath)
  if (!fullPath) return null

  try {
    const buffer = readFileSync(fullPath)
    if (buffer.includes(0)) return null
    const text = buffer.toString('utf8')
    return {
      ...file,
      text: text.length > context.maxTextChars ? text.slice(0, context.maxTextChars) : text
    }
  } catch {
    return null
  }
}

function statRootFile(context: ProjectContext, relPath: string): RootFileStat | null {
  const fullPath = safeRootPath(context, relPath)
  if (!fullPath) return null

  try {
    const stat = statSync(fullPath)
    if (!stat.isFile()) return null
    return { relPath, size: stat.size }
  } catch {
    return null
  }
}

function safeRootPath(context: ProjectContext, relPath: string): string | null {
  if (relPath.includes('\0') || path.isAbsolute(relPath) || relPath.split(/[\\/]+/).includes('..')) return null
  const fullPath = path.join(context.root, relPath)
  if (!existsSync(fullPath)) return null

  try {
    if (!lstatSync(fullPath).isFile()) return null
    const realPath = realpathSync(fullPath)
    if (!isWithinRoot(context.realRoot, realPath)) return null
    return realPath
  } catch {
    return null
  }
}

function isWithinRoot(realRoot: string, candidate: string): boolean {
  const relative = path.relative(realRoot, candidate)
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function extractTodoLines(text: string): Array<{ lineNumber: number; text: string }> {
  const lines = text.split(/\r?\n/)
  const matches: Array<{ lineNumber: number; text: string }> = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || !TODO_RE.test(line)) continue
    matches.push({
      lineNumber: i + 1,
      text: compact(line, 180)
    })
  }
  return matches
}

function parsePackageJson(text: string): PackageSummary | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const scripts = isRecord(value.scripts)
    ? Object.entries(value.scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([name]) => name)
        .sort()
    : []
  return {
    name: typeof value.name === 'string' ? value.name : '',
    scripts
  }
}

function detectPackageManager(lockfiles: RootFileStat[]): 'pnpm' | 'yarn' | 'npm' {
  if (lockfiles.some((file) => file.relPath === 'pnpm-lock.yaml')) return 'pnpm'
  if (lockfiles.some((file) => file.relPath === 'yarn.lock')) return 'yarn'
  return 'npm'
}

function formatScriptCommand(packageManager: 'pnpm' | 'yarn' | 'npm', script: string): string {
  if (packageManager === 'pnpm') return `pnpm ${script}`
  if (packageManager === 'yarn') return `yarn ${script}`
  return `npm run ${script}`
}

function firstFailed(signals: StartSuggestionSignal[]): StartSuggestionSignal | null {
  return signals.find(isFailedSignal) ?? null
}

function isFailedSignal(signal: StartSuggestionSignal): boolean {
  if (signal.failed === true || signal.ok === false) return true
  if (typeof signal.status === 'string' && FAILURE_RE.test(signal.status)) return true
  if (typeof signal.error === 'string' && signal.error.trim()) return true
  return FAILURE_RE.test(signalText(signal))
}

function summarizeSignal(signal: StartSuggestionSignal, fallback: string): string {
  const text = signalText(signal)
  return text ? compact(text, MAX_SIGNAL_TEXT) : fallback
}

function signalText(signal: StartSuggestionSignal): string {
  const parts = [
    signal.title,
    signal.summary,
    signal.body,
    signal.error,
    signal.status,
    signal.kind,
    signal.source,
    signal.path,
    Array.isArray(signal.nextSteps) ? signal.nextSteps.join(' ') : undefined
  ].filter((part): part is string => typeof part === 'string' && part.trim() !== '')
  return parts.join(' ').trim()
}

function dedupeSuggestions(suggestions: StartSuggestion[]): StartSuggestion[] {
  const byId = new Map<string, StartSuggestion>()
  for (const suggestion of suggestions) {
    const current = byId.get(suggestion.id)
    if (!current || PRIORITY_RANK[suggestion.priority] < PRIORITY_RANK[current.priority]) {
      byId.set(suggestion.id, suggestion)
    }
  }
  return Array.from(byId.values())
}

function limitSuggestions(suggestions: StartSuggestion[], maxSuggestions: number): StartSuggestion[] {
  const limit = normalizePositiveInteger(maxSuggestions, DEFAULT_MAX_SUGGESTIONS)
  return suggestions
    .map((suggestion, index) => ({ suggestion, index }))
    .sort((a, b) => PRIORITY_RANK[a.suggestion.priority] - PRIORITY_RANK[b.suggestion.priority] || a.index - b.index)
    .slice(0, limit)
    .map(({ suggestion }) => suggestion)
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function compact(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxChars) return oneLine
  return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trim()}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
