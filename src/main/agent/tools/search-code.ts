import { ensureProjectIndex, type CodeSearchMatch } from '../../indexer'

export interface SearchCodeInput {
  query: string
  glob?: string
  limit?: number
}

export async function runSearchCode(projectRoot: string, input: SearchCodeInput): Promise<CodeSearchMatch[]> {
  const indexer = await ensureProjectIndex(projectRoot)
  return indexer.searchCode(input.query, input.glob, input.limit)
}

export function formatSearchCodeResult(matches: CodeSearchMatch[]): string {
  if (matches.length === 0) return 'search_code 未找到匹配代码'
  return matches.map((match) => `${match.filePath}:${match.line} | ${match.snippet}`).join('\n')
}
