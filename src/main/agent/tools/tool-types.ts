import type { SandboxMode } from '../../../shared/types'
import type { WorkflowArtifactKind, WorkflowEvidenceKind } from '../../../shared/workflow-types'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolExecResult {
  ok: boolean
  output: string
  sandboxMode?: SandboxMode
  modeUsed?: SandboxMode
  sandboxed?: boolean
  fallbackReason?: string
  /** Main-process only; stripped after canonical Artifact registration. */
  producedArtifacts?: ToolProducedArtifactDescriptor[]
}

export interface ToolProducedArtifactDescriptor {
  kind: WorkflowArtifactKind
  title: string
  path: string
  lineageKey: string
  producer: string
  mediaType?: string
  metadata?: Record<string, unknown>
  evidenceKind?: WorkflowEvidenceKind
  evidenceSummary: string
  evidenceVerifier: string
  acceptanceStatus?: 'passed' | 'failed'
  acceptanceCriterion?: string
  requiredCanonicalRegistration?: boolean
}
