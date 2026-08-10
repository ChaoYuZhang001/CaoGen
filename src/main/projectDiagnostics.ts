import { languageForFile, parseCodeDiagnostics } from './indexer/parsers/languages'
import { listProjectFiles, readTextFile } from './fileOps'

const MAX_DIAGNOSTIC_FILES = 1_000
const MAX_DIAGNOSTIC_FILE_BYTES = 512_000
const MAX_DIAGNOSTICS = 200

export interface ProjectDiagnostic {
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
  severity: 'error'
  source: 'tree-sitter'
  code: 'syntax'
  message: string
}

export interface ProjectDiagnosticsResult {
  ok: boolean
  diagnostics: ProjectDiagnostic[]
  analyzedFiles: number
  supportedFiles: number
  truncated: boolean
  error?: string
}

export async function collectProjectDiagnostics(projectRoot: string): Promise<ProjectDiagnosticsResult> {
  const listing = await listProjectFiles(projectRoot)
  if (listing.ok === false) return failure(listing.error)
  const supported = listing.entries.filter((entry) => entry.kind === 'file' && languageForFile(entry.path))
  const candidates = supported.slice(0, MAX_DIAGNOSTIC_FILES)
  const diagnostics: ProjectDiagnostic[] = []
  let analyzedFiles = 0
  let truncated = listing.truncated || supported.length > candidates.length

  for (const entry of candidates) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      truncated = true
      break
    }
    const read = await readTextFile(projectRoot, entry.path, { maxBytes: MAX_DIAGNOSTIC_FILE_BYTES })
    if (!read.ok) continue
    const parsed = parseCodeDiagnostics(entry.path, read.content)
    if (!parsed) continue
    analyzedFiles += 1
    for (const diagnostic of parsed) {
      diagnostics.push({
        path: entry.path,
        ...diagnostic,
        severity: 'error',
        source: 'tree-sitter',
        code: 'syntax'
      })
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        truncated = true
        break
      }
    }
  }

  return {
    ok: true,
    diagnostics,
    analyzedFiles,
    supportedFiles: supported.length,
    truncated
  }
}

function failure(error: string): ProjectDiagnosticsResult {
  return { ok: false, diagnostics: [], analyzedFiles: 0, supportedFiles: 0, truncated: false, error }
}
