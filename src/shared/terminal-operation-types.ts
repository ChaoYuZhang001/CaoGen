import type { EffectStatus } from './effect-types'

export type TerminalBackend = 'pty' | 'pipe'

export interface TerminalExitInfo {
  exitCode: number | null
  signal?: number | string
  reason?: string
  at: number
}

export interface TerminalInfo {
  id: string
  sessionId?: string
  cwd: string
  shell: string
  pid?: number
  backend: TerminalBackend
  cols: number
  rows: number
  startedAt: number
  fallbackReason?: string
  exit?: TerminalExitInfo
}

export type TerminalEvent =
  | { kind: 'started'; terminal: TerminalInfo }
  | { kind: 'output'; id: string; data: string }
  | { kind: 'exit'; id: string; exit: TerminalExitInfo }
  | { kind: 'error'; id?: string; message: string; fatal: boolean }

interface TerminalEffectResultMetadata {
  effectStatus?: EffectStatus
  operationId?: string
}

export type TerminalStartResult =
  | ({ ok: true; terminal: TerminalInfo } & TerminalEffectResultMetadata)
  | ({ ok: false; error: string; snapshotId?: string } & TerminalEffectResultMetadata)

export type TerminalActionResult =
  | ({ ok: true } & TerminalEffectResultMetadata)
  | ({ ok: false; error: string; snapshotId?: string } & TerminalEffectResultMetadata)

export interface TerminalEffectApi {
  listTerminals(): Promise<TerminalInfo[]>
  startTerminal(
    sessionId: string,
    options?: { cols?: number; rows?: number; reuse?: boolean }
  ): Promise<TerminalStartResult>
  writeTerminal(id: string, data: string): Promise<TerminalActionResult>
  resizeTerminal(id: string, cols: number, rows: number): Promise<TerminalActionResult>
  closeTerminal(id: string): Promise<TerminalActionResult>
  onTerminalEvent(callback: (event: TerminalEvent) => void): () => void
}
