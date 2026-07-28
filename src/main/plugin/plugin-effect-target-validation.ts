import { isAbsolute, relative } from 'node:path'
import type { EffectTarget, FileSystemIdentity } from '../../shared/effect-types'

type ManagedPluginTarget = Extract<EffectTarget, {
  kind: 'managed_plugin_install' | 'managed_plugin_uninstall'
}>

export function isManagedPluginEffectTarget(value: Record<string, unknown>): value is ManagedPluginTarget {
  if (!hasManagedRootFields(value) || !isPluginName(value.pluginName)) return false
  if (value.kind === 'managed_plugin_install') return isInstallTarget(value)
  if (value.kind === 'managed_plugin_uninstall') return isUninstallTarget(value)
  return false
}

function isInstallTarget(record: Record<string, unknown>): boolean {
  if (!isDigest(record.expectedDigest) || !isCount(record.expectedFiles) || !isCount(record.expectedBytes)) {
    return false
  }
  if (!isStagingPath(record.stagingRelativePath)) return false
  if (record.targetPreState === 'absent') {
    return record.targetPreIdentity === undefined &&
      record.targetPreDigest === undefined &&
      record.targetPreFiles === undefined &&
      record.targetPreBytes === undefined &&
      record.trashRelativePath === undefined
  }
  return record.targetPreState === 'directory' &&
    isFileSystemIdentity(record.targetPreIdentity) &&
    isDigest(record.targetPreDigest) &&
    isCount(record.targetPreFiles) &&
    isCount(record.targetPreBytes) &&
    isTrashPath(record.trashRelativePath, record.pluginName)
}

function isUninstallTarget(record: Record<string, unknown>): boolean {
  return record.rootPreState === undefined &&
    isFileSystemIdentity(record.rootIdentity) &&
    isFileSystemIdentity(record.targetPreIdentity) &&
    isDigest(record.targetPreDigest) &&
    isCount(record.targetPreFiles) &&
    isCount(record.targetPreBytes) &&
    isTrashPath(record.trashRelativePath, record.pluginName)
}

function hasManagedRootFields(record: Record<string, unknown>): boolean {
  if (!isAbsolutePath(record.rootPath) || !isAbsolutePath(record.rootAnchorPath)) return false
  if (!isFileSystemIdentity(record.rootAnchorIdentity)) return false
  if (record.kind === 'managed_plugin_uninstall') {
    return record.rootPath === record.rootAnchorPath &&
      sameIdentity(record.rootAnchorIdentity, record.rootIdentity)
  }
  if (record.rootPreState === 'directory') {
    return record.rootPath === record.rootAnchorPath &&
      sameIdentity(record.rootAnchorIdentity, record.rootIdentity)
  }
  return record.rootPreState === 'absent' &&
    record.rootIdentity === undefined &&
    isStrictDescendant(record.rootAnchorPath, record.rootPath)
}

function isStrictDescendant(parent: unknown, child: unknown): boolean {
  if (typeof parent !== 'string' || typeof child !== 'string') return false
  const rel = relative(parent, child)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function isPluginName(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) &&
    value.toLowerCase() !== '.trash' && value.toLowerCase() !== '.caogen-operations'
}

function isStagingPath(value: unknown): boolean {
  return typeof value === 'string' && /^\.caogen-operations\/[A-Za-z0-9_-]{8,80}-stage$/.test(value)
}

function isTrashPath(value: unknown, pluginName: unknown): boolean {
  if (typeof value !== 'string' || typeof pluginName !== 'string') return false
  return value.startsWith(`.trash/${pluginName}-`) &&
    /^[A-Za-z0-9_-]{8,80}$/.test(value.slice(`.trash/${pluginName}-`.length))
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value)
}

function isFileSystemIdentity(value: unknown): value is FileSystemIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const identity = value as Record<string, unknown>
  return typeof identity.device === 'string' && Boolean(identity.device) &&
    typeof identity.inode === 'string' && Boolean(identity.inode)
}

function sameIdentity(left: FileSystemIdentity, right: unknown): boolean {
  return isFileSystemIdentity(right) && left.device === right.device && left.inode === right.inode
}

function isDigest(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
