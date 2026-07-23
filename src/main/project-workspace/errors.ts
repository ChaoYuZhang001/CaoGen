export class ProjectWorkspaceError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`)
    this.name = 'ProjectWorkspaceError'
    this.code = code
    this.details = details
  }
}
