import { createHash } from 'node:crypto'
import type { OutboundContextItemView } from '../shared/types'

export function nativeAdditionalContextItems(
  handoff: string,
  hasConversationContext: boolean,
  hasMemoryContext = false
): OutboundContextItemView[] {
  const items: OutboundContextItemView[] = []
  if (handoff.trim()) {
    items.push({
      id: 'context:workflow',
      kind: 'workflow_context',
      label: 'Workflow handoff',
      dataClass: 'S4',
      egressPolicy: 'allow',
      decision: 'included',
      bytes: Buffer.byteLength(handoff, 'utf8'),
      digest: `sha256:${createHash('sha256').update(handoff).digest('hex')}`
    })
  }
  if (hasMemoryContext) {
    items.push({
      id: 'context:memory',
      kind: 'memory_context',
      label: 'Approved local memory',
      dataClass: 'S2',
      egressPolicy: 'allow',
      decision: 'included'
    })
  }
  if (hasConversationContext) {
    items.push({
      id: 'context:conversation',
      kind: 'conversation_context',
      label: 'Conversation history',
      dataClass: 'S2',
      egressPolicy: 'allow',
      decision: 'included'
    })
  }
  return items
}

export const anthropicAdditionalContextItems = nativeAdditionalContextItems
