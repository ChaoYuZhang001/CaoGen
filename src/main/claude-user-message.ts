import { app } from 'electron'
import { join } from 'node:path'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import type { SessionMeta } from '../shared/types'
import type { StableMessagePayload } from './stable-message-payload'
import { readReferencedFiles } from './fileSuggest'
import { buildEffectiveMemoryPrompt } from './memory/memory-retriever'
import { buildSkillInvocationPrompt } from './skill/skill-invocation'
import { buildIdeDocumentContextPrompt } from './ide/ide-document-context'
import { buildProjectContextSystemAppendSync } from './agent/context-loader'
import { imageToContentBlock } from './attachmentOps'
import { getSettings } from './settings'

export interface PreparedClaudeUserMessage {
  message: {
    type: 'user'
    message: { role: 'user'; content: ContentBlockParam[] }
    parent_tool_use_id: null
    session_id: string
  }
  projectContextAppend: string
}

export async function prepareClaudeUserMessage(input: {
  payload: StableMessagePayload
  meta: SessionMeta
  lastProjectContextAppend: string
}): Promise<PreparedClaudeUserMessage> {
  const { payload, meta } = input
  const mentions = extractMentions(payload.text)
  const injected = mentions.length > 0 ? readReferencedFiles(meta.cwd, mentions) : ''
  let promptText = injected ? payload.text + injected : payload.text
  const memory = promptText
    ? await buildEffectiveMemoryPrompt({
        rootDir: join(app.getPath('userData'), 'memory'),
        query: promptText,
        projectRoot: meta.sourceCwd ?? meta.cwd,
        limit: 6
      }).catch((error) => {
        console.error('[caogen] layered memory retrieval failed:', error)
        return ''
      })
    : ''
  if (memory.trim()) {
    promptText = [memory, '## Current User Request', promptText].join('\n\n')
  }
  promptText = appendPromptSection(
    buildSkillInvocationPrompt({
      enabled: getSettings().autoSkillLearningEnabled,
      projectRoot: meta.sourceCwd ?? meta.cwd,
      query: payload.text,
      maxSkills: 2
    }),
    promptText
  )
  promptText = appendPromptSection(buildIdeDocumentContextPrompt(meta.id), promptText)

  const projectContextAppend = buildProjectContextSystemAppendSync(meta.sourceCwd ?? meta.cwd)
  if (projectContextAppend && projectContextAppend !== input.lastProjectContextAppend) {
    promptText = ['# 项目上下文已更新', projectContextAppend, promptText].filter(Boolean).join('\n\n')
  }

  const content: ContentBlockParam[] = []
  if (promptText) content.push({ type: 'text', text: promptText })
  for (const image of payload.images) {
    content.push((await imageToContentBlock(image.path)) as unknown as ContentBlockParam)
  }
  return {
    message: {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: meta.sdkSessionId ?? ''
    },
    projectContextAppend: projectContextAppend || input.lastProjectContextAppend
  }
}

function appendPromptSection(section: string, promptText: string): string {
  if (!section.trim()) return promptText
  return promptText.includes('## Current User Request')
    ? [section, promptText].join('\n\n')
    : [section, '## Current User Request', promptText].join('\n\n')
}

function extractMentions(text: string): string[] {
  const out: string[] = []
  const re = /@([A-Za-z0-9._\-/\\]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const path = match[1].replace(/[.,;:)]+$/, '')
    if (path) out.push(path)
  }
  return out
}
