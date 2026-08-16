export type ProjectDebugTargetSource = 'package-main' | 'package-bin' | 'package-script' | 'workspace-entry'

export interface ProjectDebugTarget {
  id: string
  label: string
  source: ProjectDebugTargetSource
  relativePath: string
  runtime: 'node' | 'tsx'
  default: boolean
}

export interface ProjectDebugBreakpoint {
  path: string
  line: number
}

export interface ProjectDebugLocation {
  path: string
  line: number
  column: number
}

export interface ProjectDebugFrame {
  id: string
  name: string
  location: ProjectDebugLocation | null
}

export interface ProjectDebugVariable {
  id?: string
  name: string
  value: string
  type: string
  expandable: boolean
}

export interface ProjectDebugScope {
  name: string
  variables: ProjectDebugVariable[]
}

export type ProjectDebugStatus = 'idle' | 'starting' | 'running' | 'paused' | 'stopped' | 'failed'
export type ProjectDebugControlAction = 'continue' | 'pause' | 'step-over' | 'step-into' | 'step-out' | 'stop'

export interface ProjectDebugState {
  status: ProjectDebugStatus
  targetId: string
  targetLabel: string
  pauseReason: string
  frames: ProjectDebugFrame[]
  selectedFrameId: string
  scopes: ProjectDebugScope[]
  stdout: string
  stderr: string
  outputTruncated: boolean
  startedAt: string
  finishedAt: string
  exitCode: number | null
  error: string
  workflowArtifactId?: string
  workflowEvidenceId?: string
  workflowAcceptanceId?: string
  evidenceError?: string
}

export interface ProjectDebugDiscoveryResult {
  ok: boolean
  targets: ProjectDebugTarget[]
  error?: string
}

export interface ProjectDebugApi {
  discoverProjectDebugTargets(sessionId: string): Promise<ProjectDebugDiscoveryResult>
  getProjectDebugState(sessionId: string): Promise<ProjectDebugState>
  launchProjectDebug(sessionId: string, targetId: string, breakpoints: ProjectDebugBreakpoint[]): Promise<ProjectDebugState>
  controlProjectDebug(sessionId: string, action: ProjectDebugControlAction): Promise<ProjectDebugState>
  selectProjectDebugFrame(sessionId: string, frameId: string): Promise<ProjectDebugState>
  expandProjectDebugVariable(sessionId: string, variableId: string): Promise<ProjectDebugVariable[]>
}
