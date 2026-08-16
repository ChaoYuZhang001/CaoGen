import type {
  ProjectDebugState,
  ProjectRefactorApplyResult,
  ProjectRefactorRollbackResult
} from '../../shared/types'
import type { ArtifactLifecycleRootInput } from './artifact-lifecycle-types'
import {
  registerSessionProducedArtifacts,
  type SessionProducedArtifactBinding
} from './session-artifact-producer'
import { stableValueDigest } from './tool-idempotency'

interface WorkbenchReportOwner {
  sessionId: string
  projectId: string
  creatingRunId: string
  rootInput: ArtifactLifecycleRootInput
}

export async function registerProjectDebugReport(
  owner: WorkbenchReportOwner,
  state: ProjectDebugState
): Promise<SessionProducedArtifactBinding> {
  if (state.status !== 'stopped' && state.status !== 'failed') {
    throw new Error('Project debug report requires a terminal state')
  }
  const identity = stableValueDigest({
    schema: 'caogen.project-debug-report.v1',
    sessionId: owner.sessionId,
    targetId: state.targetId,
    startedAt: state.startedAt
  })
  const report = {
    schemaVersion: 1,
    kind: 'project_debug_report',
    targetId: state.targetId,
    targetLabelDigest: stableValueDigest(state.targetLabel),
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    exitCode: state.exitCode,
    stdoutDigest: stableValueDigest(state.stdout),
    stdoutBytes: Buffer.byteLength(state.stdout, 'utf8'),
    stderrDigest: stableValueDigest(state.stderr),
    stderrBytes: Buffer.byteLength(state.stderr, 'utf8'),
    outputTruncated: state.outputTruncated,
    errorDigest: state.error ? stableValueDigest(state.error) : undefined
  }
  const [binding] = await registerSessionProducedArtifacts({
    ...owner,
    producerInvocationId: `project-debug:${identity}`,
    artifacts: [{
      kind: 'test_report',
      title: `Project debug report: ${safeTitle(state.targetLabel)}`,
      content: {
        storageKind: 'blob',
        bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
      },
      lineageKey: `project-debug:${state.targetId}`,
      mediaType: 'application/vnd.caogen.project-debug-report+json',
      producer: 'project_debugger',
      metadata: {
        targetId: state.targetId,
        status: state.status,
        exitCode: state.exitCode,
        outputTruncated: state.outputTruncated
      },
      evidenceKind: 'test_result',
      evidenceSummary: state.status === 'failed'
        ? 'The debug target failed; terminal status and output/error digests were retained without raw process output.'
        : 'The debug target stopped; terminal status and output digests were retained without raw process output.',
      evidenceVerifier: 'project-debugger',
      acceptanceStatus: state.status === 'failed' ? 'failed' : 'passed',
      acceptanceCriterion: 'The debug target must reach a non-failed terminal state and retain a digest-bound report.',
      createdAt: timestamp(state.finishedAt)
    }]
  })
  return binding
}

export async function registerProjectRefactorReport(
  owner: WorkbenchReportOwner,
  action: 'apply' | 'rollback',
  result: ProjectRefactorApplyResult | ProjectRefactorRollbackResult
): Promise<SessionProducedArtifactBinding> {
  const completedAt = action === 'apply'
    ? (result as ProjectRefactorApplyResult).appliedAt
    : (result as ProjectRefactorRollbackResult).rolledBackAt
  const files = [...result.files].sort()
  const report = {
    schemaVersion: 1,
    kind: action === 'apply' ? 'project_refactor_apply_report' : 'project_refactor_rollback_report',
    operationId: result.operationId,
    ...(action === 'apply' ? { refactorKind: (result as ProjectRefactorApplyResult).kind } : {}),
    files,
    fileSetDigest: stableValueDigest(files),
    completedAt
  }
  const [binding] = await registerSessionProducedArtifacts({
    ...owner,
    producerInvocationId: `project-refactor:${action}:${result.operationId}`,
    artifacts: [{
      kind: 'report',
      title: action === 'apply' ? 'TypeScript rename report' : 'TypeScript rename rollback report',
      content: {
        storageKind: 'blob',
        bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
      },
      lineageKey: `project-refactor:${result.operationId}`,
      mediaType: 'application/vnd.caogen.project-refactor-report+json',
      producer: 'project_refactor',
      metadata: {
        operationId: result.operationId,
        action,
        fileCount: result.files.length,
        fileSetDigest: report.fileSetDigest
      },
      evidenceKind: 'delivery_check',
      evidenceSummary: action === 'apply'
        ? 'The bounded TypeScript rename completed and its affected Project-relative file set was retained.'
        : 'The bounded TypeScript rename rollback completed and its restored Project-relative file set was retained.',
      evidenceVerifier: 'project-refactor',
      acceptanceCriterion: action === 'apply'
        ? 'The refactor apply operation must finish successfully and retain its affected file set.'
        : 'The refactor rollback operation must finish successfully and retain its restored file set.',
      createdAt: timestamp(completedAt)
    }]
  })
  return binding
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function safeTitle(value: string): string {
  const title = value.replace(/\s+/g, ' ').trim() || 'target'
  return title.length <= 120 ? title : title.slice(0, 120)
}
