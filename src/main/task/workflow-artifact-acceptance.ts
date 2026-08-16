import { digest } from './workflow-ledger-codec'

const MANUAL_ARTIFACT_ACCEPTANCE_PREFIX = 'acceptance:artifact:manual:'

export interface WorkflowArtifactAcceptanceIdentities {
  acceptanceId: string
  criterionId: string
  evidenceId: string
  linkId: string
}

export function workflowArtifactAcceptanceIdentities(
  artifactId: string
): WorkflowArtifactAcceptanceIdentities {
  const identity = digest({ contract: 'artifact-acceptance-v1', artifactId })
  return {
    acceptanceId: `${MANUAL_ARTIFACT_ACCEPTANCE_PREFIX}${identity}`,
    criterionId: `criterion:artifact:manual:${identity}`,
    evidenceId: `evidence:artifact-acceptance-binding:${identity}`,
    linkId: `evidence-link:artifact-acceptance-binding:${identity}`
  }
}

export function isManualWorkflowArtifactAcceptanceId(acceptanceId: string): boolean {
  return acceptanceId.startsWith(MANUAL_ARTIFACT_ACCEPTANCE_PREFIX)
}
