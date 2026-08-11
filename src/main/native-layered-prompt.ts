import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { SessionMeta } from '../shared/types'
import type { StableMessagePayload } from './stable-message-payload'
import { buildIdeDocumentContextPrompt } from './ide/ide-document-context'
import { buildEffectiveMemoryPrompt } from './memory/memory-retriever'
import { buildDigitalWorkerMemoryPrompt } from './digital-worker/worker-memory'
import { getSettings } from './settings'
import { buildSkillInvocationPrompt } from './skill/skill-invocation'

export interface LayeredPayloadResult {
  payload: StableMessagePayload
  hasMemoryContext: boolean
}

export async function augmentNativePayloadWithLayeredMemory(
  payload: StableMessagePayload,
  meta: SessionMeta,
  workerRootDir?: string
): Promise<LayeredPayloadResult> {
  if (!payload.text.trim()) return { payload, hasMemoryContext: false }
  const workerMemory = meta.digitalWorkerBinding?.kind === 'assigned'
    ? await buildDigitalWorkerMemoryPrompt(workerRootDir ?? process.env.CAOGEN_USER_DATA_DIR ?? '', meta)
    : ''
  let skillPrompt = ''
  let memory = ''
  let ideDocumentContext = ''
  try {
    const projectRoot = meta.sourceCwd ?? meta.cwd
    skillPrompt = buildSkillInvocationPrompt({
      enabled: getSettings().autoSkillLearningEnabled,
      projectRoot,
      query: payload.text,
      maxSkills: 2
    })
    memory = await buildEffectiveMemoryPrompt({
      rootDir: process.env.CAOGEN_MEMORY_DIR || resolve(homedir(), '.caogen', 'memory'),
      query: payload.text,
      projectRoot,
      limit: 6
    })
    ideDocumentContext = buildIdeDocumentContextPrompt(meta.id)
  } catch (error) {
    console.error('[caogen] layered memory retrieval failed:', error)
  }
  const hasMemoryContext = Boolean(memory.trim() || workerMemory.trim())
  if (!hasMemoryContext && !skillPrompt.trim() && !ideDocumentContext.trim()) {
    return { payload, hasMemoryContext: false }
  }
  return {
    payload: {
      ...payload,
      text: [skillPrompt, ideDocumentContext, memory, workerMemory, '## Current User Request', payload.text]
        .filter((item) => item.trim().length > 0)
        .join('\n\n')
    },
    hasMemoryContext
  }
}
