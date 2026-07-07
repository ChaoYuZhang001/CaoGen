import { ensureProjectIndex, type IndexedFile } from '../../indexer'

export interface FindFileInput {
  pattern: string
  limit?: number
}

export async function runFindFile(projectRoot: string, input: FindFileInput): Promise<IndexedFile[]> {
  const indexer = await ensureProjectIndex(projectRoot)
  return indexer.findFiles(input.pattern, input.limit)
}

export function formatFindFileResult(files: IndexedFile[]): string {
  if (files.length === 0) return 'find_file 未找到匹配文件'
  return files.map((file) => `${file.path} | ${file.language} | ${file.size} bytes`).join('\n')
}
