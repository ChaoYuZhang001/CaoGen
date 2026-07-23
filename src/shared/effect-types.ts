export type EffectStatus =
  | 'prepared'
  | 'executing'
  | 'waiting_reconciliation'
  | 'confirmed'
  | 'failed'
  | 'compensated'
  | 'abandoned'

export type EffectEvidenceKind =
  | 'prepared'
  | 'executing'
  | 'execution_result'
  | 'reconciliation'
  | 'retry_authorized'
  | 'manual_confirmation'
  | 'compensation'

export type InteractiveOperationKind =
  | 'file_write'
  | 'workspace_hunk_discard'
  | 'git_commit'
  | 'git_index_update'
  | 'managed_worktree_create'
  | 'managed_worktree_remove'
  | 'worktree_patch_apply'
  | 'git_push'
  | 'pull_request_create'

export type InteractiveOperationSource = 'renderer' | 'dag' | 'session_lifecycle'

export interface TaskRunOperationMetadata {
  schemaVersion: 1
  operationId: string
  source: InteractiveOperationSource
  kind: InteractiveOperationKind
  sourceSessionId: string
  projectId?: string
  title: string
}

export interface EffectLease {
  id: string
  ownerId: string
  fencingToken: number
  acquiredAt: number
  expiresAt: number
  releasedAt?: number
}

export interface EffectEvidenceRecord {
  id: string
  kind: EffectEvidenceKind
  digest: string
  observedAt: number
  verifier: string
  generation: number
}

export interface FileSystemIdentity {
  device: string
  inode: string
}

export interface ManagedWorktreeProjectionRecord {
  sessionId: string
  repoRoot: string
  sourceCwd: string
  worktreePath: string
  cwd: string
  branch: string
  baseSha: string
  baseBranch: string | null
  state: 'active' | 'removed'
  createdAt: number
  updatedAt: number
}

export type EffectTarget =
  | {
      kind: 'file_content'
      rootPath: string
      rootIdentity?: FileSystemIdentity
      relativePath: string
      preState: 'absent' | 'file'
      preFileIdentity?: FileSystemIdentity
      preSha256?: string
      preBytes?: number
      expectedState?: 'absent' | 'file'
      expectedSha256: string
      expectedBytes: number
    }
  | {
      kind: 'git_commit'
      repoRoot: string
      branch: string
      preHead: string
      stagedDiffDigest: string
      messageDigest: string
    }
  | {
      kind: 'git_index_update'
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDir: string
      gitCommonDirIdentity: FileSystemIdentity
      worktreeGitDir: string
      worktreeGitDirIdentity: FileSystemIdentity
      objectDir: string
      objectDirIdentity: FileSystemIdentity
      objectFormat: 'sha1' | 'sha256'
      indexPath: string
      preHeadState: 'commit' | 'unborn'
      preHead?: string
      headRef?: string
      preIndexState: 'absent' | 'file'
      preIndexIdentity?: FileSystemIdentity
      preIndexSha256?: string
      preIndexBytes?: number
      preIndexEntriesDigest: string
      expectedIndexEntriesDigest: string
      operation: 'stage_paths' | 'stage_all' | 'unstage_paths' | 'apply_cached_hunk'
      paths: string[]
      worktreeReadScope: 'none' | 'paths' | 'all'
      scopePath?: string
      patchSha256?: string
      patchBytes?: number
      artifactRoot: string
      artifactRootIdentity: FileSystemIdentity
      indexArtifactPath: string
      indexArtifactIdentity: FileSystemIdentity
      indexArtifactSha256: string
      indexArtifactBytes: number
      objectManifestPath: string
      objectManifestIdentity: FileSystemIdentity
      objectManifestSha256: string
      objectCount: number
    }
  | {
      kind: 'git_merge'
      repoRoot: string
      gitCommonDir: string
      worktreeGitDir: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDirIdentity: FileSystemIdentity
      worktreeGitDirIdentity: FileSystemIdentity
      destinationRef: string
      preHead: string
      preTree: string
      sourceRef: string
      sourceSha: string
      sourceWasAncestor: boolean
      mode: 'no_ff_v1'
    }
  | {
      kind: 'git_push'
      repoRoot: string
      remote: string
      pushUrlDigest: string
      branch: string
      ref: string
      intendedSha: string
    }
  | {
      kind: 'worktree_patch_apply'
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDir: string
      gitCommonDirIdentity: FileSystemIdentity
      worktreePath: string
      worktreeRootIdentity: FileSystemIdentity
      baseSha: string
      headSha: string
      preHead: string
      patchPath: string
      patchFileIdentity: FileSystemIdentity
      patchSha256: string
      patchBytes: number
      changedPaths: string[]
      mode?: 'apply' | 'reverse'
    }
  | {
      kind: 'code_forge_patch'
      targetKind: 'repository' | 'managed-worktree'
      sessionId?: string
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDir: string
      gitCommonDirIdentity: FileSystemIdentity
      worktreePath: string
      worktreeRootIdentity: FileSystemIdentity
      worktreeGitDir: string
      worktreeGitDirIdentity: FileSystemIdentity
      branch?: string
      baseBranch?: string | null
      baseSha: string
      headSha: string
      changedPaths: string[]
      insertions: number
      deletions: number
      conflictRisk?: 'low' | 'medium' | 'unknown'
      canApply?: boolean
      applyError?: string
      conflictFiles?: string[]
      sourceStateDigest: string
      artifactRoot: string
      artifactRootIdentity: FileSystemIdentity
      artifactPath: string
      artifactPreState: 'absent' | 'file'
      artifactPreFileIdentity?: FileSystemIdentity
      artifactPreSha256?: string
      artifactPreBytes?: number
      patchSha256: string
      patchBytes: number
    }
  | {
      kind: 'git_worktree_create'
      sessionId: string
      sourceCwd: string
      sourceCwdIdentity: FileSystemIdentity
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDir: string
      gitCommonDirIdentity: FileSystemIdentity
      sourceWorktreeGitDir: string
      sourceWorktreeGitDirIdentity: FileSystemIdentity
      worktreePath: string
      worktreeCwd: string
      sourcePrefix: string
      worktreeParentPath: string
      worktreeParentPreState: 'absent' | 'directory'
      worktreeParentPreIdentity?: FileSystemIdentity
      worktreeParentAnchorPath: string
      worktreeParentAnchorIdentity: FileSystemIdentity
      branch: string
      branchRef: string
      baseSha: string
      baseBranch: string | null
      sourceHeadRef: string | null
      registryRecord: ManagedWorktreeProjectionRecord
    }
  | {
      kind: 'git_worktree_remove'
      sessionId: string
      sourceCwd: string
      sourceCwdIdentity: FileSystemIdentity
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDir: string
      gitCommonDirIdentity: FileSystemIdentity
      sourceWorktreeGitDir: string
      sourceWorktreeGitDirIdentity: FileSystemIdentity
      sourceHead: string
      sourceHeadRef: string | null
      worktreePath: string
      worktreeCwd: string
      sourcePrefix: string
      worktreeRootIdentity: FileSystemIdentity
      worktreeGitDir: string
      worktreeGitDirIdentity: FileSystemIdentity
      branch: string
      branchRef: string
      branchSha: string
      headSha: string
      baseSha: string
      baseBranch: string | null
      worktreeStatusDigest: string
      worktreeOperationStateDigest: string
      preStateDigest: string
      force: boolean
      deleteBranch: boolean
      registryRecord: ManagedWorktreeProjectionRecord
    }
  | {
      kind: 'pull_request_create'
      provider: 'github' | 'gitlab'
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      remote: string
      remoteUrlDigest: string
      host: string
      projectPath: string
      repositoryDigest: string
      sourceBranch: string
      sourceSha: string
      baseBranch: string
      titleDigest: string
      bodyDigest: string
      marker: string
    }
  | {
      kind: 'unsupported'
      toolName: string
    }

export interface EffectRecord {
  schemaVersion: 1
  id: string
  effectKey: string
  resourceKey: string
  sessionId: string
  runId: string
  stepId?: string
  toolExecutionId?: string
  toolUseId: string
  toolName: string
  generation: number
  revision: number
  status: EffectStatus
  reconcilability: 'queryable' | 'opaque'
  target: EffectTarget
  targetDigest: string
  intentDigest: string
  inputDigest: string
  lease?: EffectLease
  evidence: EffectEvidenceRecord[]
  compensationEffectId?: string
  createdAt: number
  updatedAt: number
  terminalAt?: number
  error?: string
}
