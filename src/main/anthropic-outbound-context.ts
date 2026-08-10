import type { OutboundContextItemView } from '../shared/types'

export function anthropicAdditionalContextItems(
  handoff: string,
  hasConversationContext: boolean
): OutboundContextItemView[] {
  const items: OutboundContextItemView[] = []
  if (handoff.trim()) {
    items.push({
      id: 'context:workflow',
      kind: 'workflow_context',
      label: 'Workflow handoff',
      dataClass: 'S4',
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
