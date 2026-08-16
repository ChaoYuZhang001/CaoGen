import { app, type IpcMainInvokeEvent } from 'electron'
import type { ProjectRefactorInput } from '../../shared/types'
import { applyProjectRefactor, previewTypeScriptRename, rollbackProjectRefactor } from '../projectRefactor'
import { sessionManager } from '../sessionManager'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { registerProjectRefactorReport } from '../task/workbench-report-artifacts'

type ProjectRefactorAction = 'preview-rename' | 'apply' | 'rollback'

export async function handleProjectRefactorIpc(
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
  if (action === 'apply') {
    const result = await applyProjectRefactor(sessionId, requiredIdentifier(rawValue, 'Refactor preview ID'))
    return finalizeRefactorReport(sessionId, 'apply', result)
  }
  const result = await rollbackProjectRefactor(sessionId, requiredIdentifier(rawValue, 'Refactor operation ID'))
  return finalizeRefactorReport(sessionId, 'rollback', result)
}

async function finalizeRefactorReport(
  sessionId: string,
  action: 'apply' | 'rollback',
  result: Awaited<ReturnType<typeof applyProjectRefactor | typeof rollbackProjectRefactor>>
) {
  const session = sessionManager.get(sessionId)
  const projectId = session?.meta.workspaceId ?? session?.meta.projectId
  const creatingRun = sessionManager.getTaskRun(sessionId)
  if (!projectId || !creatingRun) {
    result.evidenceError = 'Canonical refactor report requires a Project-owned current TaskRun'
    return result
  }
  try {
    const binding = await registerProjectRefactorReport({
      sessionId,
      projectId,
      creatingRunId: creatingRun.id,
      rootInput: { workflowRoot: app.getPath('userData'), workspaceRoot: app.getPath('userData') }
    }, action, result)
    result.workflowArtifactId = binding.artifactId
    result.workflowEvidenceId = binding.evidenceId
    result.workflowAcceptanceId = binding.acceptanceId
  } catch (error) {
    result.evidenceError = `Canonical refactor report finalization failed: ${error instanceof Error ? error.message : String(error)}`
  }
  return result
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
