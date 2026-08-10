export interface CodexNativeConfigSummary {
  modelProviders: number
  mcpServers: number
  projects: number
  features: number
  plugins: number
}

export interface CodexNativeConfigPreview {
  previewId: string
  source: 'CODEX_HOME' | 'user-profile'
  configPresent: boolean
  text: string
  protectedValueCount: number
  formattingNormalized: boolean
  summary: CodexNativeConfigSummary
  expiresAt: number
}

export interface CodexNativeConfigBackupView {
  id: string
  createdAt: string
  source: CodexNativeConfigPreview['source']
  configPresent: boolean
}

export interface CodexNativeConfigApplyResult {
  operationId: string
  appliedAt: string
  backup: CodexNativeConfigBackupView
  preview: CodexNativeConfigPreview
}

export interface CodexNativeConfigRollbackResult {
  operationId: string
  restoredBackupId: string
  configPresent: boolean
}
