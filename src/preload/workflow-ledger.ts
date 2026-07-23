import { ipcRenderer } from 'electron'
import type {
  AgentDeskApi,
  WorkflowAcceptanceInput,
  WorkflowAcceptanceReviewInput,
  WorkflowArtifactEdgeInput,
  WorkflowArtifactInput,
  WorkflowArtifactGraphScope,
  WorkflowArtifactLocationInput,
  WorkflowEvidenceCreateInput,
  WorkflowEvidenceLinkInput,
  WorkflowEvidenceScope,
  WorkflowLedgerExportOptions,
  WorkflowLedgerScope
} from '../shared/types'

type WorkflowLedgerApi = Pick<
  AgentDeskApi,
  | 'listWorkflowLedger'
  | 'verifyWorkflowLedger'
  | 'exportWorkflowLedger'
  | 'diagnoseWorkflowLedger'
  | 'planWorkflowLedgerRepair'
  | 'saveWorkflowAcceptance'
  | 'createWorkflowArtifact'
  | 'createWorkflowArtifactEdge'
  | 'createWorkflowArtifactLocation'
  | 'listWorkflowArtifactEdges'
  | 'listWorkflowArtifactLocations'
  | 'queryWorkflowArtifactGraph'
  | 'verifyWorkflowArtifactGraph'
  | 'createWorkflowEvidence'
  | 'listWorkflowEvidence'
  | 'queryWorkflowEvidence'
  | 'verifyWorkflowEvidence'
  | 'reviewWorkflowAcceptance'
  | 'createWorkflowEvidenceLink'
>

export const workflowLedgerApi: WorkflowLedgerApi = {
  listWorkflowLedger: (scope?: WorkflowLedgerScope) => ipcRenderer.invoke('workflowLedger:list', scope),
  verifyWorkflowLedger: () => ipcRenderer.invoke('workflowLedger:verify'),
  exportWorkflowLedger: (options?: WorkflowLedgerExportOptions) =>
    ipcRenderer.invoke('workflowLedger:export', options),
  diagnoseWorkflowLedger: () => ipcRenderer.invoke('workflowLedger:diagnose'),
  planWorkflowLedgerRepair: () => ipcRenderer.invoke('workflowLedger:repairPlan'),
  saveWorkflowAcceptance: (input: WorkflowAcceptanceInput) =>
    ipcRenderer.invoke('workflowLedger:saveAcceptance', input),
  createWorkflowArtifact: (input: WorkflowArtifactInput) => ipcRenderer.invoke('workflowLedger:createArtifact', input),
  createWorkflowArtifactEdge: (input: WorkflowArtifactEdgeInput) =>
    ipcRenderer.invoke('workflowLedger:createArtifactEdge', input),
  createWorkflowArtifactLocation: (input: WorkflowArtifactLocationInput) =>
    ipcRenderer.invoke('workflowLedger:createArtifactLocation', input),
  listWorkflowArtifactEdges: (scope?: WorkflowArtifactGraphScope) =>
    ipcRenderer.invoke('workflowLedger:listArtifactEdges', scope),
  listWorkflowArtifactLocations: (scope?: WorkflowArtifactGraphScope) =>
    ipcRenderer.invoke('workflowLedger:listArtifactLocations', scope),
  queryWorkflowArtifactGraph: (artifactId: string) =>
    ipcRenderer.invoke('workflowLedger:queryArtifactGraph', artifactId),
  verifyWorkflowArtifactGraph: () => ipcRenderer.invoke('workflowLedger:verifyArtifactGraph'),
  createWorkflowEvidence: (input: WorkflowEvidenceCreateInput) =>
    ipcRenderer.invoke('workflowLedger:createEvidence', input),
  listWorkflowEvidence: (scope?: WorkflowEvidenceScope) =>
    ipcRenderer.invoke('workflowLedger:listEvidence', scope),
  queryWorkflowEvidence: (scope?: WorkflowEvidenceScope) =>
    ipcRenderer.invoke('workflowLedger:queryEvidence', scope),
  verifyWorkflowEvidence: () => ipcRenderer.invoke('workflowLedger:verifyEvidence'),
  reviewWorkflowAcceptance: (input: WorkflowAcceptanceReviewInput) =>
    ipcRenderer.invoke('workflowLedger:reviewAcceptance', input),
  createWorkflowEvidenceLink: (input: WorkflowEvidenceLinkInput) => ipcRenderer.invoke('workflowLedger:createEvidenceLink', input)
}
