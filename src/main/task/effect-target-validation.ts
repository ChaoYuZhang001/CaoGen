import type { EffectTarget, FileSystemIdentity } from '../../shared/types'

export function isEffectTarget(value: unknown): value is EffectTarget {
  if (!isRecord(value)) return false
  if (value.kind === 'file_content') return isFileContentTarget(value)
  if (value.kind === 'git_commit') return isGitCommitTarget(value)
  if (value.kind === 'git_index_update') return isGitIndexUpdateTarget(value)
  if (value.kind === 'git_merge') return isGitMergeTarget(value)
  if (value.kind === 'git_push') return isGitPushTarget(value)
  if (value.kind === 'worktree_patch_apply') return isWorktreePatchTarget(value)
  if (value.kind === 'code_forge_patch') return isCodeForgePatchTarget(value)
  if (value.kind === 'git_worktree_create') return isGitWorktreeCreateTarget(value)
  if (value.kind === 'git_worktree_remove') return isGitWorktreeRemoveTarget(value)
  if (value.kind === 'pull_request_create') return isPullRequestTarget(value)
  return value.kind === 'unsupported' && isString(value.toolName)
}

function isGitIndexUpdateTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.gitCommonDir),
    isFileSystemIdentity(record.gitCommonDirIdentity),
    isString(record.worktreeGitDir),
    isFileSystemIdentity(record.worktreeGitDirIdentity),
    isString(record.objectDir),
    isFileSystemIdentity(record.objectDirIdentity),
    record.objectFormat === 'sha1' || record.objectFormat === 'sha256',
    isString(record.indexPath),
    record.preHeadState === 'commit' || record.preHeadState === 'unborn',
    isOptionalString(record.preHead),
    isOptionalString(record.headRef),
    record.preIndexState === 'absent' || record.preIndexState === 'file',
    isOptionalFileSystemIdentity(record.preIndexIdentity),
    isOptionalString(record.preIndexSha256),
    isOptionalNonNegativeInteger(record.preIndexBytes),
    isString(record.preIndexEntriesDigest),
    isString(record.expectedIndexEntriesDigest),
    isGitIndexOperation(record.operation),
    isStringArray(record.paths),
    record.worktreeReadScope === 'none' || record.worktreeReadScope === 'paths' || record.worktreeReadScope === 'all',
    isOptionalString(record.scopePath),
    isOptionalString(record.patchSha256),
    isOptionalNonNegativeInteger(record.patchBytes),
    isString(record.artifactRoot),
    isFileSystemIdentity(record.artifactRootIdentity),
    isString(record.indexArtifactPath),
    isFileSystemIdentity(record.indexArtifactIdentity),
    isString(record.indexArtifactSha256),
    isNonNegativeInteger(record.indexArtifactBytes),
    isString(record.objectManifestPath),
    isFileSystemIdentity(record.objectManifestIdentity),
    isString(record.objectManifestSha256),
    isNonNegativeInteger(record.objectCount)
  ].every(Boolean)
}

function isGitIndexOperation(value: unknown): boolean {
  return value === 'stage_paths' || value === 'stage_all' || value === 'unstage_paths' || value === 'apply_cached_hunk'
}

function isFileContentTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.rootPath),
    isOptionalFileSystemIdentity(record.rootIdentity),
    isString(record.relativePath),
    record.preState === 'absent' || record.preState === 'file',
    isOptionalFileSystemIdentity(record.preFileIdentity),
    isOptionalString(record.preSha256),
    record.expectedState === undefined || record.expectedState === 'absent' || record.expectedState === 'file',
    isString(record.expectedSha256),
    isOptionalNonNegativeInteger(record.expectedBytes),
    record.expectedBytes !== undefined
  ].every(Boolean)
}

function isGitCommitTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.repoRoot),
    isString(record.branch),
    isString(record.preHead),
    isString(record.stagedDiffDigest),
    isString(record.messageDigest)
  ].every(Boolean)
}

function isGitMergeTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.repoRoot),
    isString(record.gitCommonDir),
    isString(record.worktreeGitDir),
    isFileSystemIdentity(record.repoRootIdentity),
    isFileSystemIdentity(record.gitCommonDirIdentity),
    isFileSystemIdentity(record.worktreeGitDirIdentity),
    isString(record.destinationRef),
    isString(record.preHead),
    isString(record.preTree),
    isString(record.sourceRef),
    isString(record.sourceSha),
    typeof record.sourceWasAncestor === 'boolean',
    record.mode === 'no_ff_v1'
  ].every(Boolean)
}

function isGitPushTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.repoRoot),
    isString(record.remote),
    isString(record.pushUrlDigest),
    isString(record.branch),
    isString(record.ref),
    isString(record.intendedSha)
  ].every(Boolean)
}

function isWorktreePatchTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.gitCommonDir),
    isFileSystemIdentity(record.gitCommonDirIdentity),
    isString(record.worktreePath),
    isFileSystemIdentity(record.worktreeRootIdentity),
    isString(record.baseSha),
    isString(record.headSha),
    isString(record.preHead),
    isString(record.patchPath),
    isFileSystemIdentity(record.patchFileIdentity),
    isString(record.patchSha256),
    isOptionalNonNegativeInteger(record.patchBytes),
    record.patchBytes !== undefined,
    isStringArray(record.changedPaths),
    record.mode === undefined || record.mode === 'apply' || record.mode === 'reverse'
  ].every(Boolean)
}

function isCodeForgePatchTarget(record: Record<string, unknown>): boolean {
  return [
    record.targetKind === 'repository' || record.targetKind === 'managed-worktree',
    isOptionalString(record.sessionId),
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.gitCommonDir),
    isFileSystemIdentity(record.gitCommonDirIdentity),
    isString(record.worktreePath),
    isFileSystemIdentity(record.worktreeRootIdentity),
    isString(record.worktreeGitDir),
    isFileSystemIdentity(record.worktreeGitDirIdentity),
    isOptionalString(record.branch),
    isOptionalNullableString(record.baseBranch),
    isString(record.baseSha),
    isString(record.headSha),
    isStringArray(record.changedPaths),
    isNonNegativeInteger(record.insertions),
    isNonNegativeInteger(record.deletions),
    record.conflictRisk === undefined || record.conflictRisk === 'low' || record.conflictRisk === 'medium' || record.conflictRisk === 'unknown',
    record.canApply === undefined || typeof record.canApply === 'boolean',
    isOptionalString(record.applyError),
    record.conflictFiles === undefined || isStringArray(record.conflictFiles),
    isString(record.sourceStateDigest),
    isString(record.artifactRoot),
    isFileSystemIdentity(record.artifactRootIdentity),
    isString(record.artifactPath),
    record.artifactPreState === 'absent' || record.artifactPreState === 'file',
    isOptionalFileSystemIdentity(record.artifactPreFileIdentity),
    isOptionalString(record.artifactPreSha256),
    isOptionalNonNegativeInteger(record.artifactPreBytes),
    isString(record.patchSha256),
    isNonNegativeInteger(record.patchBytes)
  ].every(Boolean)
}

function isGitWorktreeCreateTarget(record: Record<string, unknown>): boolean {
  return [
    isManagedWorktreeMetadata(record),
    isString(record.sourceCwd),
    isFileSystemIdentity(record.sourceCwdIdentity),
    isString(record.sourceWorktreeGitDir),
    isFileSystemIdentity(record.sourceWorktreeGitDirIdentity),
    isString(record.worktreeParentPath),
    record.worktreeParentPreState === 'absent' || record.worktreeParentPreState === 'directory',
    isOptionalFileSystemIdentity(record.worktreeParentPreIdentity),
    isString(record.worktreeParentAnchorPath),
    isFileSystemIdentity(record.worktreeParentAnchorIdentity),
    isOptionalNullableString(record.sourceHeadRef)
  ].every(Boolean)
}

function isGitWorktreeRemoveTarget(record: Record<string, unknown>): boolean {
  return [
    isManagedWorktreeMetadata(record),
    isString(record.sourceCwd),
    isFileSystemIdentity(record.sourceCwdIdentity),
    isString(record.sourceWorktreeGitDir),
    isFileSystemIdentity(record.sourceWorktreeGitDirIdentity),
    isString(record.sourceHead),
    isOptionalNullableString(record.sourceHeadRef),
    isFileSystemIdentity(record.worktreeRootIdentity),
    isString(record.worktreeGitDir),
    isFileSystemIdentity(record.worktreeGitDirIdentity),
    isString(record.branchSha),
    isString(record.headSha),
    isString(record.worktreeStatusDigest),
    isString(record.worktreeOperationStateDigest),
    isString(record.preStateDigest),
    typeof record.force === 'boolean',
    typeof record.deleteBranch === 'boolean'
  ].every(Boolean)
}

function isManagedWorktreeMetadata(record: Record<string, unknown>): boolean {
  return [
    isString(record.sessionId),
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.gitCommonDir),
    isFileSystemIdentity(record.gitCommonDirIdentity),
    isString(record.worktreePath),
    isString(record.worktreeCwd),
    isString(record.sourcePrefix),
    isString(record.branch),
    isString(record.branchRef),
    isString(record.baseSha),
    isOptionalNullableString(record.baseBranch),
    isManagedWorktreeProjectionRecord(record.registryRecord)
  ].every(Boolean)
}

function isManagedWorktreeProjectionRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  return [
    isString(value.sessionId),
    isString(value.repoRoot),
    isString(value.sourceCwd),
    isString(value.worktreePath),
    isString(value.cwd),
    isString(value.branch),
    isString(value.baseSha),
    isOptionalNullableString(value.baseBranch),
    value.state === 'active' || value.state === 'removed',
    isNonNegativeFiniteNumber(value.createdAt),
    isNonNegativeFiniteNumber(value.updatedAt)
  ].every(Boolean)
}

function isNonNegativeFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isPullRequestTarget(record: Record<string, unknown>): boolean {
  return [
    record.provider === 'github' || record.provider === 'gitlab',
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.remote),
    isString(record.remoteUrlDigest),
    isString(record.host),
    isString(record.projectPath),
    isString(record.repositoryDigest),
    isString(record.sourceBranch),
    isString(record.sourceSha),
    isString(record.baseBranch),
    isString(record.titleDigest),
    isString(record.bodyDigest),
    isString(record.marker)
  ].every(Boolean)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalFileSystemIdentity(value: unknown): boolean {
  return value === undefined || isFileSystemIdentity(value)
}

function isFileSystemIdentity(value: unknown): value is FileSystemIdentity {
  if (!isRecord(value)) return false
  return [isString(value.device), isString(value.inode)].every(Boolean)
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString)
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}
