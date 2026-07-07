import { ensureProjectIndex, type IndexedSymbol } from '../../indexer'

export interface SearchSymbolInput {
  name: string
  kind?: string
  limit?: number
}

export async function runSearchSymbol(projectRoot: string, input: SearchSymbolInput): Promise<IndexedSymbol[]> {
  const indexer = await ensureProjectIndex(projectRoot)
  return indexer.searchSymbols(input.name, input.kind, input.limit)
}

export function formatSearchSymbolResult(symbols: IndexedSymbol[]): string {
  if (symbols.length === 0) return 'search_symbol 未找到匹配符号'
  return symbols
    .map((symbol) =>
      [
        `${symbol.filePath}:${symbol.line}:${symbol.column}`,
        `${symbol.kind}${symbol.exported ? ' exported' : ''}`,
        symbol.name,
        symbol.signature
      ].join(' | ')
    )
    .join('\n')
}
