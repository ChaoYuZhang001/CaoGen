import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type {
  WorkspaceDiff,
  WorkspaceDiffFile,
  WorkspaceDiffHunk,
  WorkspaceDiffLine
} from '../shared/types'

const MAX_DIFF_CHARS = 1_000_000
const MAX_EXEC_BUFFER = MAX_DIFF_CHARS * 20
const MAX_UNTRACKED_FILE_BYTES = 250_000

type MutableWorkspaceDiffFile = WorkspaceDiffFile

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function getWorkspaceDiff(cwd: string): WorkspaceDiff {
  let output: Buffer
  let repoRoot: string
  try {
    repoRoot = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    output = execFileSync('git', ['-C', cwd, 'diff', '--no-ext-diff', '--binary', '--', '.'], {
      encoding: 'buffer',
      maxBuffer: MAX_EXEC_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return {
      ok: false,
      cwd,
      files: [],
      rawBytes: 0,
      error: errorMessage(error)
    }
  }

  const rawBytes = output.length
  const text = output.toString('utf8')
  const truncated = text.length > MAX_DIFF_CHARS
  const parseText = truncated ? text.slice(0, MAX_DIFF_CHARS) : text
  const untracked = truncated ? { files: [], rawBytes: 0 } : getUntrackedFilesDiff(cwd, repoRoot)

  return {
    ok: true,
    cwd,
    files: [...parseUnifiedDiff(parseText), ...untracked.files],
    rawBytes: rawBytes + untracked.rawBytes,
    ...(truncated ? { truncated: true } : {})
  }
}

function getUntrackedFilesDiff(cwd: string, repoRoot: string): { files: WorkspaceDiffFile[]; rawBytes: number } {
  let output: Buffer
  try {
    output = execFileSync(
      'git',
      ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', '.'],
      {
        encoding: 'buffer',
        maxBuffer: MAX_EXEC_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  } catch {
    return { files: [], rawBytes: 0 }
  }

  const paths = output.toString('utf8').split('\0').filter(Boolean)
  let rawBytes = 0
  const files: WorkspaceDiffFile[] = []
  for (const relPath of paths) {
    const fullPath = path.join(repoRoot, relPath)
    let buffer: Buffer
    try {
      buffer = readFileSync(fullPath)
    } catch {
      continue
    }
    rawBytes += buffer.length
    if (buffer.includes(0) || buffer.length > MAX_UNTRACKED_FILE_BYTES) {
      files.push({
        oldPath: relPath,
        newPath: relPath,
        status: 'binary',
        hunks: [],
        binary: true
      })
      continue
    }

    const lines = buffer.toString('utf8').split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    files.push({
      oldPath: relPath,
      newPath: relPath,
      status: 'added',
      hunks: [
        {
          header: `@@ -0,0 +1,${lines.length} @@`,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: lines.length,
          lines: lines.map<WorkspaceDiffLine>((line, idx) => ({
            type: 'add',
            text: line,
            newLine: idx + 1
          }))
        }
      ]
    })
  }

  return { files, rawBytes }
}

function parseUnifiedDiff(text: string): WorkspaceDiffFile[] {
  const files: MutableWorkspaceDiffFile[] = []
  let currentFile: MutableWorkspaceDiffFile | null = null
  let currentHunk: WorkspaceDiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      currentFile = createFileFromHeader(line)
      files.push(currentFile)
      currentHunk = null
      oldLine = 0
      newLine = 0
      continue
    }

    if (!currentFile) continue

    if (line.startsWith('new file mode ')) {
      currentFile.status = 'added'
      continue
    }

    if (line.startsWith('deleted file mode ')) {
      currentFile.status = 'deleted'
      continue
    }

    if (line.startsWith('rename from ')) {
      currentFile.status = 'renamed'
      currentFile.oldPath = unquoteGitPath(line.slice('rename from '.length))
      continue
    }

    if (line.startsWith('rename to ')) {
      currentFile.status = 'renamed'
      currentFile.newPath = unquoteGitPath(line.slice('rename to '.length))
      continue
    }

    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      currentFile.status = 'binary'
      currentFile.binary = true
      currentHunk = null
      continue
    }

    if (line === 'GIT binary patch') {
      currentFile.status = 'binary'
      currentFile.binary = true
      currentHunk = null
      continue
    }

    if (line.startsWith('--- ')) {
      currentFile.oldPath = parseFilePathLine(line.slice(4))
      continue
    }

    if (line.startsWith('+++ ')) {
      currentFile.newPath = parseFilePathLine(line.slice(4))
      continue
    }

    const hunkMatch = line.match(HUNK_RE)
    if (hunkMatch) {
      const hunk: WorkspaceDiffHunk = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: []
      }
      currentFile.hunks.push(hunk)
      currentHunk = hunk
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      continue
    }

    if (!currentHunk) continue

    if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        text: line.slice(1),
        oldLine,
        newLine
      })
      oldLine += 1
      newLine += 1
      continue
    }

    if (line.startsWith('+')) {
      currentHunk.lines.push({
        type: 'add',
        text: line.slice(1),
        newLine
      })
      newLine += 1
      continue
    }

    if (line.startsWith('-')) {
      currentHunk.lines.push({
        type: 'delete',
        text: line.slice(1),
        oldLine
      })
      oldLine += 1
    }
  }

  return files
}

function createFileFromHeader(line: string): MutableWorkspaceDiffFile {
  const paths = parseDiffGitPaths(line)
  return {
    oldPath: paths.oldPath,
    newPath: paths.newPath,
    status: 'modified',
    hunks: []
  }
}

function parseDiffGitPaths(line: string): { oldPath: string; newPath: string } {
  const body = line.slice('diff --git '.length)
  const splitAt = body.lastIndexOf(' b/')
  if (splitAt === -1) {
    return { oldPath: '', newPath: '' }
  }

  const oldPath = stripPathPrefix(body.slice(0, splitAt), 'a/')
  const newPath = stripPathPrefix(body.slice(splitAt + 1), 'b/')
  return { oldPath, newPath }
}

function parseFilePathLine(path: string): string {
  const clean = unquoteGitPath(path.split('\t')[0])
  if (clean === '/dev/null') return clean
  if (clean.startsWith('a/') || clean.startsWith('b/')) return clean.slice(2)
  return clean
}

function stripPathPrefix(path: string, prefix: 'a/' | 'b/'): string {
  const clean = unquoteGitPath(path)
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : clean
}

function unquoteGitPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed
  }

  try {
    return JSON.parse(trimmed) as string
  } catch {
    return trimmed.slice(1, -1)
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const maybeError = error as {
      message?: unknown
      stderr?: unknown
      code?: unknown
    }
    const stderr =
      Buffer.isBuffer(maybeError.stderr) || typeof maybeError.stderr === 'string'
        ? String(maybeError.stderr).trim()
        : ''
    if (stderr) return stderr
    if (typeof maybeError.message === 'string' && maybeError.message.trim()) {
      return maybeError.message
    }
    if (maybeError.code !== undefined) return String(maybeError.code)
  }
  return String(error)
}
