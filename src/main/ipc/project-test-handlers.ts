import { createHash } from 'node:crypto'
import { app } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  cancelProjectTest,
  discoverProjectTests,
  runProjectTest
} from '../projectTestRunner'
import { sessionManager } from '../sessionManager'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { registerSessionProducedArtifacts } from '../task/session-artifact-producer'
import { redactSensitiveValue } from '../security/secret-redaction'

type ProjectTestAction = 'discover' | 'run' | 'cancel'

export async function handleProjectTestIpc(
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
  const projectId = session.meta.workspaceId ?? session.meta.projectId
  const result = await runProjectTest(
    session.meta.cwd,
    sessionId,
    commandId,
    projectId
  )
  if (!projectId) return result
  const creatingRun = sessionManager.getTaskRun(sessionId)
  if (!creatingRun) {
    result.evidenceError = appendEvidenceError(result.evidenceError, 'Canonical test Artifact lacks current TaskRun')
    return result
  }
  try {
    const report = redactSensitiveValue({
      schemaVersion: 1,
      kind: 'caogen-project-test-report',
      testRunId: result.runId,
      commandId: result.commandId,
      label: result.label,
      source: result.source,
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutDigest: createHash('sha256').update(result.stdout).digest('hex'),
      stderrDigest: createHash('sha256').update(result.stderr).digest('hex'),
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated
    })
    const [binding] = await registerSessionProducedArtifacts({
      sessionId,
      projectId,
      creatingRunId: creatingRun.id,
      producerInvocationId: `project-test:${result.runId}`,
      artifacts: [{
        kind: 'test_report',
        title: `Project test: ${result.label}`,
        content: {
          storageKind: 'blob',
          bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
        },
        lineageKey: `project-test:${result.commandId}`,
        mediaType: 'application/vnd.caogen.test-report+json',
        producer: 'project_test_runner',
        metadata: {
          projectTestRunId: result.runId,
          commandId: result.commandId,
          status: result.status,
          localEvidenceId: result.evidenceId
        },
        evidenceKind: 'test_result',
        evidenceSummary: result.status === 'passed'
          ? 'The restricted Project test command exited successfully; output digests and execution metadata are retained.'
          : `The restricted Project test command ended with status ${result.status}; failure is retained and blocks handoff.`,
        evidenceVerifier: 'project-test-runner',
        acceptanceStatus: result.status === 'passed' ? 'passed' : 'failed',
        acceptanceCriterion: 'The selected restricted Project test command must complete with passed status.',
        createdAt: Date.parse(result.finishedAt)
      }],
      rootInput: {
        workflowRoot: app.getPath('userData'),
        workspaceRoot: app.getPath('userData')
      }
    })
    result.workflowArtifactId = binding.artifactId
    result.workflowEvidenceId = binding.evidenceId
    result.workflowAcceptanceId = binding.acceptanceId
  } catch (error) {
    result.evidenceError = appendEvidenceError(
      result.evidenceError,
      `Canonical test Artifact finalization failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return result
}

function appendEvidenceError(existing: string | undefined, next: string): string {
  return existing ? `${existing}; ${next}` : next
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
