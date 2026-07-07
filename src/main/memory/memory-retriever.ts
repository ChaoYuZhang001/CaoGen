import { searchMemories, type MemoryLayer, type MemorySearchHit } from './memory-manager'

export interface BuildMemoryPromptInput {
  rootDir: string
  query: string
  projectRoot?: string
  layers?: MemoryLayer[]
  limit?: number
}

export async function retrieveRelevantMemories(input: BuildMemoryPromptInput): Promise<MemorySearchHit[]> {
  return searchMemories(input.rootDir, {
    query: input.query,
    projectRoot: input.projectRoot,
    layers: input.layers,
    limit: input.limit
  })
}

export async function buildLayeredMemoryPrompt(input: BuildMemoryPromptInput): Promise<string> {
  const hits = await retrieveRelevantMemories(input)
  if (hits.length === 0) return ''
  const blocks = hits.map((hit) => {
    const entry = hit.entry
    return [
      `### ${entry.title}`,
      `- Layer: ${entry.layer}`,
      `- Source: ${entry.source}`,
      `- Score: ${hit.score.toFixed(3)}`,
      entry.tags.length > 0 ? `- Tags: ${entry.tags.join(', ')}` : '',
      '',
      entry.body
    ].filter(Boolean).join('\n')
  })
  return `## Relevant CaoGen Memory\n\n${blocks.join('\n\n')}\n`
}
