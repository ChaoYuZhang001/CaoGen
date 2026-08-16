export type ProjectFileKind = 'file' | 'directory'

export interface ProjectFileEntry {
  path: string
  name: string
  kind: ProjectFileKind
  size?: number
  mtimeMs: number
}

export interface ListProjectFilesResult {
  ok: boolean
  root?: string
  entries: ProjectFileEntry[]
  truncated?: boolean
  error?: string
}

export interface ProjectTextSearchMatch {
  path: string
  line: number
  column: number
  snippet: string
  matchStart: number
  matchLength: number
}

export interface SearchProjectTextResult {
  ok: boolean
  query?: string
  matches: ProjectTextSearchMatch[]
  filesScanned?: number
  filesMatched?: number
  truncated?: boolean
  error?: string
}

export interface ProjectDiagnostic {
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
  severity: 'error' | 'warning' | 'info'
  source: string
  code: string
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

export interface ProjectSymbolLocation {
  name: string
  kind: string
  path: string
  line: number
  column: number
  endLine: number
  signature: string
  exported: boolean
}

export interface ProjectSymbolSearchResult {
  ok: boolean
  symbols: ProjectSymbolLocation[]
  error?: string
}

export interface TypeScriptLanguageInput {
  path: string
  content: string
  line: number
  column: number
}

export interface SemanticCompletionItem {
  label: string
  kind: string
  detail: string
  insertText: string
}

export interface SemanticCompletionResult {
  ok: boolean
  engine: 'typescript-lsp'
  items: SemanticCompletionItem[]
  error?: string
}

export interface SemanticHoverResult {
  ok: boolean
  engine: 'typescript-lsp'
  markdown: string
  error?: string
}

export interface SemanticDefinitionLocation {
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
}

export interface SemanticDefinitionResult {
  ok: boolean
  engine: 'typescript-lsp'
  locations: SemanticDefinitionLocation[]
  error?: string
}

export interface SemanticDiagnostic extends ProjectDiagnostic {}

export interface SemanticDiagnosticsResult {
  ok: boolean
  engine: 'typescript-lsp'
  diagnostics: SemanticDiagnostic[]
  error?: string
}

export interface ReadTextFileResult {
  ok: boolean
  path?: string
  content?: string
  bytes?: number
  mtimeMs?: number
  error?: string
}

export interface WriteTextFileResult {
  ok: boolean
  path?: string
  bytes?: number
  mtimeMs?: number
  error?: string
}
