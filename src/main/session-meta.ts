import { randomUUID } from 'node:crypto'
import type {
  CaoGenDriveMode,
  EngineKind,
  PermissionModeId,
  SessionMeta,
  SessionRoutingScope,
  UsageTotals
} from '../shared/types'

function normalizeBudget(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
}

export function newSessionMeta(opts: {
  cwd: string
  driveMode?: CaoGenDriveMode
  parentSessionId?: string
  orchestrationId?: string
  childTaskId?: string
  childRole?: string
  isolated?: boolean
  sourceCwd?: string
  projectId?: string
  unassigned?: boolean
  repoRoot?: string
  worktreePath?: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
  worktreeState?: 'active' | 'removed'
  model: string
  providerId: string
  routingScope?: SessionRoutingScope
  budgetUsd?: number
  resumeSessionAt?: string
  engine?: EngineKind
  permissionMode: PermissionModeId
  title?: string
}): SessionMeta {
  return {
    id: randomUUID(),
    title: opts.title || '新会话',
    cwd: opts.cwd,
    driveMode: opts.driveMode,
    parentSessionId: opts.parentSessionId,
    orchestrationId: opts.orchestrationId,
    childTaskId: opts.childTaskId,
    childRole: opts.childRole,
    isolated: opts.isolated,
    sourceCwd: opts.sourceCwd,
    projectId: opts.projectId,
    unassigned: opts.unassigned,
    repoRoot: opts.repoRoot,
    worktreePath: opts.worktreePath,
    branch: opts.branch,
    baseBranch: opts.baseBranch,
    baseSha: opts.baseSha,
    worktreeState: opts.worktreeState,
    model: opts.model,
    providerId: opts.providerId,
    routingScope: opts.routingScope,
    budgetUsd: normalizeBudget(opts.budgetUsd),
    resumeSessionAt: opts.resumeSessionAt,
    engine: opts.engine,
    permissionMode: opts.permissionMode,
    status: 'starting',
    costUsd: 0,
    usage: emptyUsage(),
    contextTokens: 0,
    contextPressure: 'normal',
    createdAt: Date.now()
  }
}
