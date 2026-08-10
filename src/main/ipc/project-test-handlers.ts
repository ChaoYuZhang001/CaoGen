import type { IpcMainInvokeEvent } from 'electron'
import {
  cancelProjectTest,
  discoverProjectTests,
  runProjectTest
} from '../projectTestRunner'
import { sessionManager } from '../sessionManager'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

type ProjectTestAction = 'discover' | 'run' | 'cancel'

export function handleProjectTestIpc(
  event: IpcMainInvokeEvent,
  rawAction: unknown,
  rawSessionId: unknown,
  rawCommandId?: unknown
) {
  assertTrustedWorkflowLedgerSender(event)
  const action = requiredAction(rawAction)
  const sessionId = requiredIdentifier(rawSessionId, 'Session ID')
  const session = sessionManager.get(sessionId)
  if (!session) throw new Error('Session was not found')
  if (action === 'discover') return discoverProjectTests(session.meta.cwd)
  if (action === 'cancel') return cancelProjectTest(sessionId)
  const commandId = requiredIdentifier(rawCommandId, 'Test command ID')
  return runProjectTest(session.meta.cwd, sessionId, commandId)
}

function requiredAction(value: unknown): ProjectTestAction {
  if (value === 'discover' || value === 'run' || value === 'cancel') return value
  throw new Error('Project test action is invalid')
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 256) {
    throw new Error(`${label} is invalid`)
  }
  return value.trim()
}
