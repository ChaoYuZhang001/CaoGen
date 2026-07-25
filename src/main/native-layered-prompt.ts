import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { SessionMeta } from '../shared/types'
import type { StableMessagePayload } from './stable-message-payload'
import { buildIdeDocumentContextPrompt } from './ide/ide-document-context'
import { buildEffectiveMemoryPrompt } from './memory/memory-retriever'
import { getSettings } from './settings'
import { buildSkillInvocationPrompt } from './skill/skill-invocation'

export async function augmentNativePayloadWithLayeredMemory(
  payload: StableMessagePayload,
  meta: SessionMeta
): Promise<StableMessagePayload> {
  if (!payload.text.trim()) return payload
  try {
    const projectRoot = meta.sourceCwd ?? meta.cwd
    const skillPrompt = buildSkillInvocationPrompt({
      enabled: getSettings().autoSkillLearningEnabled,
      projectRoot,
      query: payload.text,
      maxSkills: 2
    })
    const memory = await buildEffectiveMemoryPrompt({
      rootDir: process.env.CAOGEN_MEMORY_DIR || resolve(homedir(), '.caogen', 'memory'),
      query: payload.text,
      projectRoot,
      limit: 6
    })
    const ideDocumentContext = buildIdeDocumentContextPrompt(meta.id)
    if (!memory.trim() && !skillPrompt.trim() && !ideDocumentContext.trim()) return payload
    return {
      ...payload,
      text: [skillPrompt, ideDocumentContext, memory, '## Current User Request', payload.text]
        .filter((item) => item.trim().length > 0)
        .join('\n\n')
    }
  } catch (error) {
    console.error('[caogen] layered memory retrieval failed:', error)
    return payload
  }
}
