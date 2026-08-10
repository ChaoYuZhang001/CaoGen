import { disposeProjectIndexers, ensureProjectIndex, type IndexedSymbol } from './indexer'

const MAX_QUERY_CHARS = 128
const MAX_SYMBOL_RESULTS = 50

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

export async function searchProjectSymbols(
  projectRoot: string,
  queryValue: string,
  limitValue = 30
): Promise<ProjectSymbolSearchResult> {
  try {
    const query = normalizedSymbol(queryValue)
    const limit = Math.min(MAX_SYMBOL_RESULTS, Math.max(1, Math.floor(limitValue) || 30))
    const indexer = await ensureProjectIndex(projectRoot, { watch: true })
    return { ok: true, symbols: deduplicateDefinitions(indexer.searchSymbols(query, undefined, limit)).map(symbolView) }
  } catch (error) {
    return { ok: false, symbols: [], error: errorMessage(error) }
  }
}

export async function resolveProjectDefinition(
  projectRoot: string,
  currentPathValue: string,
  symbolValue: string
): Promise<ProjectSymbolSearchResult> {
  try {
    const symbol = normalizedSymbol(symbolValue)
    const currentPath = normalizedRelativePath(currentPathValue)
    const indexer = await ensureProjectIndex(projectRoot, { watch: true })
    const dependencyPaths = new Set(indexer.dependencies(currentPath).dependencies)
    const matches = deduplicateDefinitions(indexer.searchSymbols(symbol, undefined, MAX_SYMBOL_RESULTS)
      .filter((item) => item.name === symbol))
      .sort((left, right) => definitionRank(left, currentPath, dependencyPaths) - definitionRank(right, currentPath, dependencyPaths))
    return { ok: true, symbols: matches.map(symbolView) }
  } catch (error) {
    return { ok: false, symbols: [], error: errorMessage(error) }
  }
}

function deduplicateDefinitions(symbols: IndexedSymbol[]): IndexedSymbol[] {
  const definitions = new Map<string, IndexedSymbol>()
  for (const symbol of symbols) {
    const key = `${symbol.filePath}\0${symbol.line}\0${symbol.name}`
    const current = definitions.get(key)
    if (!current || (current.kind === 'export' && symbol.kind !== 'export')) definitions.set(key, symbol)
  }
  return [...definitions.values()]
}

export async function disposeProjectLanguageIntelligence(): Promise<void> {
  await disposeProjectIndexers()
}

function definitionRank(symbol: IndexedSymbol, currentPath: string, dependencies: ReadonlySet<string>): number {
  if (symbol.filePath === currentPath) return 0
  if (dependencies.has(symbol.filePath)) return 1
  return symbol.exported ? 2 : 3
}

function symbolView(symbol: IndexedSymbol): ProjectSymbolLocation {
  return {
    name: symbol.name,
    kind: symbol.kind,
    path: symbol.filePath,
    line: symbol.line,
    column: symbol.column,
    endLine: symbol.endLine,
    signature: symbol.signature,
    exported: symbol.exported
  }
}

function normalizedSymbol(value: string): string {
  const symbol = value.trim()
  if (!symbol || symbol.length > MAX_QUERY_CHARS || !/^[\p{L}_$][\p{L}\p{N}_$-]*$/u.test(symbol)) {
    throw new Error('Symbol query is invalid')
  }
  return symbol
}

function normalizedRelativePath(value: string): string {
  const path = value.replace(/\\/g, '/').trim()
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || path.includes('\0')) {
    throw new Error('Project file path is invalid')
  }
  return path
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
