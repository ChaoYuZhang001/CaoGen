export type ConflictRisk = 'low' | 'medium' | 'unknown'

export interface WorktreeMergeFailure {
  ok: false
  error: string
}

export interface InspectMergeSuccess {
  ok: true
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
  changedFiles: number
  insertions: number
  deletions: number
  conflictRisk: ConflictRisk
}

export type InspectMergeResult = InspectMergeSuccess | WorktreeMergeFailure

export interface CreateSquashPatchSuccess {
  ok: true
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
  path: string
  patchText: string
  bytes: number
}

export type CreateSquashPatchResult = CreateSquashPatchSuccess | WorktreeMergeFailure

export type CanFastApplyPatchResult =
  | { ok: true; canApply: true }
  | { ok: true; canApply: false; error: string }
  | WorktreeMergeFailure

export interface ApplySquashPatchSuccess {
  ok: true
  repoRoot: string
  bytes: number
  changedFiles: number
  applied: boolean
}

export type ApplySquashPatchResult = ApplySquashPatchSuccess | WorktreeMergeFailure

export interface WorktreeConflictFileContent {
  path: string
  base: string
  worktree: string
  main: string
  baseMissing?: boolean
  worktreeMissing?: boolean
  mainMissing?: boolean
  truncated?: boolean
}

export interface WorktreeConflictFilesResult {
  ok: boolean
  files?: WorktreeConflictFileContent[]
  truncatedList?: boolean
  error?: string
}

export interface WorktreeMergeReceipt {
  schemaVersion?: 1
  sessionId: string
  branch: string
  baseSha: string
  filesChanged: number
  insertions: number
  deletions: number
  mergedAt: number
  patchSha256: string
}

export class WorktreeMergeReceiptFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeMergeReceiptFormatError'
  }
}

export type PullRequestTool = 'gh' | 'glab'

export interface CreatePullRequestOptions {
  repoRoot: string
  worktreePath: string
  branch: string
  title: string
  body?: string
  baseBranch?: string | null
}

export type CreatePullRequestResult =
  | { ok: true; created: true; tool: PullRequestTool; branch: string; url: string; pushed: boolean }
  | { ok: true; created: false; message: string }
  | WorktreeMergeFailure
