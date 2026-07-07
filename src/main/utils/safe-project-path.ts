import { lstat, realpath, stat } from 'node:fs/promises'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface SafeProjectPath {
  root: string
  fullPath: string
  relativePath: string
}

export async function normalizeProjectRoot(projectRoot: string): Promise<string> {
  if (!projectRoot.trim()) throw new Error('项目目录不能为空')
  const root = await realpath(resolve(projectRoot))
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('项目目录不存在或不是目录')
  return root
}

export function normalizeProjectRootSync(projectRoot: string): string {
  if (!projectRoot.trim()) throw new Error('项目目录不能为空')
  const root = realpathSync(resolve(projectRoot))
  const info = statSync(root)
  if (!info.isDirectory()) throw new Error('项目目录不存在或不是目录')
  return root
}

export async function resolveExistingProjectPath(projectRoot: string, rawPath: string): Promise<SafeProjectPath> {
  const inputRoot = resolve(projectRoot)
  const root = await normalizeProjectRoot(projectRoot)
  const candidate = candidatePath(root, rawPath, inputRoot)
  ensureInsideRoot(root, candidate)
  await assertNoSymlinkInExistingPath(root, candidate)
  const realTarget = await realpath(candidate)
  ensureInsideRoot(root, realTarget)
  return { root, fullPath: realTarget, relativePath: toProjectRelative(root, realTarget) }
}

export function resolveExistingProjectPathSync(projectRoot: string, rawPath: string): SafeProjectPath {
  const inputRoot = resolve(projectRoot)
  const root = normalizeProjectRootSync(projectRoot)
  const candidate = candidatePath(root, rawPath, inputRoot)
  ensureInsideRoot(root, candidate)
  assertNoSymlinkInExistingPathSync(root, candidate)
  const realTarget = realpathSync(candidate)
  ensureInsideRoot(root, realTarget)
  return { root, fullPath: realTarget, relativePath: toProjectRelative(root, realTarget) }
}

export async function resolveWritableProjectPath(projectRoot: string, rawPath: string): Promise<SafeProjectPath> {
  const inputRoot = resolve(projectRoot)
  const root = await normalizeProjectRoot(projectRoot)
  const candidate = candidatePath(root, rawPath, inputRoot)
  ensureInsideRoot(root, candidate)
  await assertNoSymlinkInExistingPath(root, candidate, false)
  const targetInfo = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (targetInfo?.isSymbolicLink()) throw new Error('写入目标不能是符号链接或 junction')
  const parent = dirname(candidate)
  const realParent = await realpath(nearestExistingAncestor(root, parent))
  ensureInsideRoot(root, realParent)
  return { root, fullPath: candidate, relativePath: toProjectRelative(root, candidate) }
}

export function resolveWritableProjectPathSync(projectRoot: string, rawPath: string): SafeProjectPath {
  const inputRoot = resolve(projectRoot)
  const root = normalizeProjectRootSync(projectRoot)
  const candidate = candidatePath(root, rawPath, inputRoot)
  ensureInsideRoot(root, candidate)
  assertNoSymlinkInExistingPathSync(root, candidate, false)
  try {
    if (lstatSync(candidate).isSymbolicLink()) throw new Error('写入目标不能是符号链接或 junction')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = dirname(candidate)
  const realParent = realpathSync(nearestExistingAncestorSync(root, parent))
  ensureInsideRoot(root, realParent)
  return { root, fullPath: candidate, relativePath: toProjectRelative(root, candidate) }
}

export function ensureInsideRoot(root: string, fullPath: string): void {
  const rel = relative(root, fullPath)
  if (rel === '') return
  if (!rel.startsWith('..') && !isAbsolute(rel)) return
  throw new Error('路径越过了项目目录边界')
}

export function toProjectRelative(root: string, fullPath: string): string {
  return relative(root, fullPath).split(sep).join('/')
}

function candidatePath(root: string, rawPath: string, inputRoot: string): string {
  if (!rawPath.trim()) throw new Error('文件路径不能为空')
  if (rawPath.includes('\0')) throw new Error('文件路径包含非法字符')
  if (!isAbsolute(rawPath)) return resolve(root, rawPath)

  const requested = resolve(rawPath)
  for (const rootAlias of rootAliases(root, inputRoot)) {
    const rel = relative(rootAlias, requested)
    if (isInsideRelative(rel)) return resolve(root, rel)
  }
  return requested
}

async function assertNoSymlinkInExistingPath(
  root: string,
  target: string,
  includeTarget = true
): Promise<void> {
  const parts = pathPartsInsideRoot(root, target)
  let current = root
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1)
  for (let index = 0; index < limit; index++) {
    current = join(current, parts[index])
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return
    if (info.isSymbolicLink()) throw new Error('路径不能包含符号链接或 junction')
  }
}

function assertNoSymlinkInExistingPathSync(root: string, target: string, includeTarget = true): void {
  const parts = pathPartsInsideRoot(root, target)
  let current = root
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1)
  for (let index = 0; index < limit; index++) {
    current = join(current, parts[index])
    let info: ReturnType<typeof lstatSync> | null
    try {
      info = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink()) throw new Error('路径不能包含符号链接或 junction')
  }
}

function nearestExistingAncestor(root: string, target: string): string {
  let current = target
  while (true) {
    try {
      statSync(current)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      ensureInsideRoot(root, parent)
      current = parent
    }
  }
}

function nearestExistingAncestorSync(root: string, target: string): string {
  return nearestExistingAncestor(root, target)
}

function pathPartsInsideRoot(root: string, target: string): string[] {
  ensureInsideRoot(root, target)
  const rel = relative(root, target)
  return rel ? rel.split(/[\\/]+/).filter(Boolean) : []
}

function rootAliases(root: string, inputRoot: string): string[] {
  const aliases = new Set<string>([root, inputRoot])
  for (const value of [root, inputRoot]) {
    addDarwinPrivateAlias(aliases, value, '/private/var', '/var')
    addDarwinPrivateAlias(aliases, value, '/private/tmp', '/tmp')
  }
  return Array.from(aliases)
}

function addDarwinPrivateAlias(aliases: Set<string>, value: string, privatePrefix: string, publicPrefix: string): void {
  if (value === privatePrefix || value.startsWith(`${privatePrefix}/`)) {
    aliases.add(`${publicPrefix}${value.slice(privatePrefix.length)}`)
  }
  if (value === publicPrefix || value.startsWith(`${publicPrefix}/`)) {
    aliases.add(`${privatePrefix}${value.slice(publicPrefix.length)}`)
  }
}

function isInsideRelative(rel: string): boolean {
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
