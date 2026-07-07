import { ensureProjectIndex, type DependencyView } from '../../indexer'

export interface GetDependenciesInput {
  file_path: string
}

export async function runGetDependencies(projectRoot: string, input: GetDependenciesInput): Promise<DependencyView> {
  const indexer = await ensureProjectIndex(projectRoot)
  return indexer.dependencies(input.file_path)
}

export function formatDependenciesResult(view: DependencyView): string {
  return [
    `文件: ${view.filePath}`,
    `正向依赖(${view.dependencies.length}):`,
    ...(view.dependencies.length > 0 ? view.dependencies.map((item) => `- ${item}`) : ['- 无']),
    `反向依赖(${view.dependents.length}):`,
    ...(view.dependents.length > 0 ? view.dependents.map((item) => `- ${item}`) : ['- 无']),
    `外部导入(${view.externalImports.length}):`,
    ...(view.externalImports.length > 0 ? view.externalImports.map((item) => `- ${item}`) : ['- 无'])
  ].join('\n')
}
