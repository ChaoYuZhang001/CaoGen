export type ProjectTestCommandSource = 'package-script' | 'pytest' | 'cargo' | 'go' | 'gradle'

export interface ProjectTestCommand {
  id: string
  label: string
  source: ProjectTestCommandSource
  default: boolean
}

export interface ProjectTestDiscoveryResult {
  ok: boolean
  commands: ProjectTestCommand[]
  error?: string
}

export type ProjectTestRunStatus = 'passed' | 'failed' | 'cancelled' | 'timed_out' | 'output_limit' | 'launch_failed'

export interface ProjectTestRunResult {
  runId: string
  commandId: string
  label: string
  source: ProjectTestCommandSource
  status: ProjectTestRunStatus
  startedAt: string
  finishedAt: string
  durationMs: number
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  evidenceId: string
  evidenceError?: string
  workflowArtifactId?: string
  workflowEvidenceId?: string
  workflowAcceptanceId?: string
}

export interface ProjectTestApi {
  discoverProjectTests(sessionId: string): Promise<ProjectTestDiscoveryResult>
  runProjectTest(sessionId: string, commandId: string): Promise<ProjectTestRunResult>
  cancelProjectTest(sessionId: string): Promise<boolean>
}
