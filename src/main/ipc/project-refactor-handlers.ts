import type { IpcMainInvokeEvent } from 'electron'
import type { ProjectRefactorInput } from '../../shared/types'
import { applyProjectRefactor, previewTypeScriptRename, rollbackProjectRefactor } from '../projectRefactor'
import { sessionManager } from '../sessionManager'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

type ProjectRefactorAction = 'preview-rename' | 'apply' | 'rollback'

export function handleProjectRefactorIpc(
  event: IpcMainInvokeEvent,
  rawAction: unknown,
  rawSessionId: unknown,
  rawValue: unknown
) {
  assertTrustedWorkflowLedgerSender(event)
  const action = requiredAction(rawAction)
  const sessionId = requiredIdentifier(rawSessionId, 'Session ID')
  const session = sessionManager.get(sessionId)
  if (!session) throw new Error('Session was not found')
  if (action === 'preview-rename') return previewTypeScriptRename(session.meta.cwd, sessionId, requiredInput(rawValue))
  if (action === 'apply') return applyProjectRefactor(sessionId, requiredIdentifier(rawValue, 'Refactor preview ID'))
  return rollbackProjectRefactor(sessionId, requiredIdentifier(rawValue, 'Refactor operation ID'))
}

function requiredAction(value: unknown): ProjectRefactorAction {
  if (value === 'preview-rename' || value === 'apply' || value === 'rollback') return value
  throw new Error('Project refactor action is invalid')
}

function requiredInput(value: unknown): ProjectRefactorInput {
  if (!value || typeof value !== 'object') throw new Error('TypeScript rename input is invalid')
  const input = value as Record<string, unknown>
  if (typeof input.path !== 'string' || typeof input.content !== 'string' ||
    typeof input.newName !== 'string' || !Number.isSafeInteger(input.line) || !Number.isSafeInteger(input.column)) {
    throw new Error('TypeScript rename input is invalid')
  }
  return {
    path: input.path,
    content: input.content,
    line: input.line as number,
    column: input.column as number,
    newName: input.newName
  }
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) {
    throw new Error(`${label} is invalid`)
  }
  return value.trim()
}
