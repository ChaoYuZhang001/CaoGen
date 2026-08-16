import { ipcRenderer } from 'electron'
import type {
  AgentDeskApi,
  WorkflowAcceptanceInput,
  WorkflowAcceptanceReviewInput,
  WorkflowArtifactAcceptanceCreateInput,
  WorkflowArtifactExportInput,
  WorkflowArtifactCompareInput,
  WorkflowArtifactIntegrityInput,
  WorkflowArtifactManifestExportInput,
  WorkflowProjectDeliveryIntegrityInput,
  WorkflowProjectDeliveryManifestExportInput,
  WorkflowProjectDeliveryPackageExportInput,
  WorkflowDeliveryIdentityPassphraseInput,
  WorkflowDeliveryIdentityRevokeInput,
  WorkflowDeliveryIdentityRotateInput,
  WorkflowDeliveryIdentityTrustInput,
  WorkflowDeliveryTrustPolicyUpdateInput,
  WorkflowProjectDeliveryPackageVerificationReceiptSaveInput,
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
  | 'getProjectDeliveryWorkbench'
  | 'verifyWorkflowLedger'
  | 'exportWorkflowLedger'
  | 'diagnoseWorkflowLedger'
  | 'planWorkflowLedgerRepair'
  | 'saveWorkflowAcceptance'
  | 'createWorkflowArtifactAcceptance'
  | 'exportWorkflowArtifact'
  | 'compareWorkflowArtifacts'
  | 'verifyWorkflowArtifactIntegrity'
  | 'exportWorkflowArtifactManifest'
  | 'verifyWorkflowProjectDelivery'
  | 'exportWorkflowProjectDeliveryManifest'
  | 'exportWorkflowProjectDeliveryPackage'
  | 'verifyWorkflowProjectDeliveryPackage'
  | 'listWorkflowDeliveryTrustedIdentities'
  | 'trustWorkflowDeliveryIdentity'
  | 'revokeWorkflowDeliveryIdentity'
  | 'updateWorkflowDeliveryTrustPolicy'
  | 'exportWorkflowDeliveryIdentityTrustBundle'
  | 'importWorkflowDeliveryIdentityTrustBundle'
  | 'exportWorkflowDeliveryIdentityBackup'
  | 'restoreWorkflowDeliveryIdentityBackup'
  | 'rotateWorkflowDeliveryIdentity'
  | 'saveWorkflowProjectDeliveryPackageVerificationReceipt'
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
  | 'startWorkflowAcceptanceRepair'
  | 'createWorkflowEvidenceLink'
>

export const workflowLedgerApi: WorkflowLedgerApi = {
  listWorkflowLedger: (scope?: WorkflowLedgerScope) => ipcRenderer.invoke('workflowLedger:list', scope),
  getProjectDeliveryWorkbench: (projectId: string) =>
    ipcRenderer.invoke('workflowLedger:projectDeliveryWorkbench', projectId),
  verifyWorkflowLedger: () => ipcRenderer.invoke('workflowLedger:verify'),
  exportWorkflowLedger: (options?: WorkflowLedgerExportOptions) =>
    ipcRenderer.invoke('workflowLedger:export', options),
  diagnoseWorkflowLedger: () => ipcRenderer.invoke('workflowLedger:diagnose'),
  planWorkflowLedgerRepair: () => ipcRenderer.invoke('workflowLedger:repairPlan'),
  saveWorkflowAcceptance: (input: WorkflowAcceptanceInput) =>
    ipcRenderer.invoke('workflowLedger:saveAcceptance', input),
  createWorkflowArtifactAcceptance: (input: WorkflowArtifactAcceptanceCreateInput) =>
    ipcRenderer.invoke('workflowLedger:createArtifactAcceptance', input),
  exportWorkflowArtifact: (input: WorkflowArtifactExportInput) =>
    ipcRenderer.invoke('workflowLedger:exportArtifact', input),
  compareWorkflowArtifacts: (input: WorkflowArtifactCompareInput) =>
    ipcRenderer.invoke('workflowLedger:compareArtifacts', input),
  verifyWorkflowArtifactIntegrity: (input: WorkflowArtifactIntegrityInput) =>
    ipcRenderer.invoke('workflowLedger:verifyArtifactIntegrity', input),
  exportWorkflowArtifactManifest: (input: WorkflowArtifactManifestExportInput) =>
    ipcRenderer.invoke('workflowLedger:exportArtifactManifest', input),
  verifyWorkflowProjectDelivery: (input: WorkflowProjectDeliveryIntegrityInput) =>
    ipcRenderer.invoke('workflowLedger:verifyProjectDelivery', input),
  exportWorkflowProjectDeliveryManifest: (input: WorkflowProjectDeliveryManifestExportInput) =>
    ipcRenderer.invoke('workflowLedger:exportProjectDeliveryManifest', input),
  exportWorkflowProjectDeliveryPackage: (input: WorkflowProjectDeliveryPackageExportInput) =>
    ipcRenderer.invoke('workflowLedger:exportProjectDeliveryPackage', input),
  verifyWorkflowProjectDeliveryPackage: () =>
    ipcRenderer.invoke('workflowLedger:verifyProjectDeliveryPackage'),
  listWorkflowDeliveryTrustedIdentities: () =>
    ipcRenderer.invoke('workflowLedger:listDeliveryTrustedIdentities'),
  trustWorkflowDeliveryIdentity: (input: WorkflowDeliveryIdentityTrustInput) =>
    ipcRenderer.invoke('workflowLedger:trustDeliveryIdentity', input),
  revokeWorkflowDeliveryIdentity: (input: WorkflowDeliveryIdentityRevokeInput) =>
    ipcRenderer.invoke('workflowLedger:revokeDeliveryIdentity', input),
  updateWorkflowDeliveryTrustPolicy: (input: WorkflowDeliveryTrustPolicyUpdateInput) =>
    ipcRenderer.invoke('workflowLedger:updateDeliveryTrustPolicy', input),
  exportWorkflowDeliveryIdentityTrustBundle: () =>
    ipcRenderer.invoke('workflowLedger:exportDeliveryIdentityTrustBundle'),
  importWorkflowDeliveryIdentityTrustBundle: (expectedRevision: number) =>
    ipcRenderer.invoke('workflowLedger:importDeliveryIdentityTrustBundle', expectedRevision),
  exportWorkflowDeliveryIdentityBackup: (input: WorkflowDeliveryIdentityPassphraseInput) =>
    ipcRenderer.invoke('workflowLedger:exportDeliveryIdentityBackup', input),
  restoreWorkflowDeliveryIdentityBackup: (input: WorkflowDeliveryIdentityPassphraseInput) =>
    ipcRenderer.invoke('workflowLedger:restoreDeliveryIdentityBackup', input),
  rotateWorkflowDeliveryIdentity: (input: WorkflowDeliveryIdentityRotateInput) =>
    ipcRenderer.invoke('workflowLedger:rotateDeliveryIdentity', input),
  saveWorkflowProjectDeliveryPackageVerificationReceipt: (
    input: WorkflowProjectDeliveryPackageVerificationReceiptSaveInput
  ) => ipcRenderer.invoke('workflowLedger:saveProjectDeliveryPackageVerificationReceipt', input),
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
  startWorkflowAcceptanceRepair: (acceptanceId: string) =>
    ipcRenderer.invoke('workflowLedger:startAcceptanceRepair', acceptanceId),
  createWorkflowEvidenceLink: (input: WorkflowEvidenceLinkInput) => ipcRenderer.invoke('workflowLedger:createEvidenceLink', input)
}
