import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface SecureSkillTarget {
  target: string
  parent: string
  parentIdentity: string
  exists: boolean
}

export function normalizeSkillRelativePath(value: string): string {
  if (typeof value !== 'string') throw new Error('relativePath must be a string')
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized || normalized.length > 512 || normalized.startsWith('/') || normalized.includes('\0') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Skill relativePath is invalid')
  }
  if (!normalized.endsWith('/SKILL.md') || normalized.split('/').length < 2) {
    throw new Error('Skill relativePath must target <skill>/SKILL.md')
  }
  return normalized
}

export function skillMaterializationPath(projectRoot: string, relativePath: string): string {
  const skillRoot = resolve(projectRoot, '.caogen', 'skills')
  const normalized = normalizeSkillRelativePath(relativePath)
  const target = resolve(skillRoot, ...normalized.split('/'))
  assertInside(skillRoot, target)
  return target
}

export function securelyWriteMaterializedSkill(
  projectRoot: string,
  relativePath: string,
  content: string,
  allowedExistingDigests: ReadonlySet<string>
): void {
  const secure = secureSkillTarget(projectRoot, relativePath, true)
  if (!secure) throw new Error(`Unable to create controlled Skill path: ${relativePath}`)
  if (secure.exists) {
    const current = readFileSync(secure.target, 'utf8')
    if (current === content) return
    if (!allowedExistingDigests.has(materializedContentDigest(current))) {
      throw new Error(`Materialized Skill changed outside Learning control: ${relativePath}`)
    }
  }

  const temp = join(secure.parent, `.${basename(secure.target)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    )
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined

    const revalidated = secureSkillTarget(projectRoot, relativePath, false)
    if (!revalidated || revalidated.parent !== secure.parent || revalidated.target !== secure.target ||
      revalidated.parentIdentity !== secure.parentIdentity) {
      throw new Error(`Controlled Skill parent changed before commit: ${relativePath}`)
    }
    renameSync(temp, secure.target)
    const committed = requireRegularFileNoSymlink(secure.target, 'materialized Skill')
    assertInside(realpathSync(resolve(projectRoot, '.caogen', 'skills')), realpathSync(secure.target))
    if (committed.size !== Buffer.byteLength(content, 'utf8') || readFileSync(secure.target, 'utf8') !== content) {
      throw new Error(`Materialized Skill verification failed: ${relativePath}`)
    }
    fsyncDirectory(secure.parent)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temp, { force: true })
    throw error
  }
}

export function securelyRemoveMaterializedSkill(
  projectRoot: string,
  relativePath: string,
  allowedExistingDigests: ReadonlySet<string>
): void {
  const secure = secureSkillTarget(projectRoot, relativePath, false)
  if (!secure || !secure.exists) return
  const currentDigest = materializedContentDigest(readFileSync(secure.target, 'utf8'))
  if (!allowedExistingDigests.has(currentDigest)) {
    throw new Error(`Materialized Skill changed outside Learning control: ${relativePath}`)
  }
  const revalidated = secureSkillTarget(projectRoot, relativePath, false)
  if (!revalidated || !revalidated.exists || revalidated.parent !== secure.parent ||
    revalidated.target !== secure.target || revalidated.parentIdentity !== secure.parentIdentity) {
    throw new Error(`Controlled Skill target changed before removal: ${relativePath}`)
  }
  rmSync(secure.target, { force: true })
  fsyncDirectory(secure.parent)
}

export function materializedContentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function secureSkillTarget(
  projectRoot: string,
  relativePath: string,
  createParents: boolean
): SecureSkillTarget | undefined {
  const normalized = normalizeSkillRelativePath(relativePath)
  const requestedProjectRoot = resolve(projectRoot)
  const projectStat = requireDirectoryNoSymlink(requestedProjectRoot, 'project root')
  if (!projectStat.isDirectory()) throw new Error(`Project root is not a directory: ${requestedProjectRoot}`)
  const canonicalProjectRoot = realpathSync(requestedProjectRoot)

  let current = canonicalProjectRoot
  for (const component of ['.caogen', 'skills']) {
    const next = safeChildDirectory(current, component, canonicalProjectRoot, createParents)
    if (!next) return undefined
    current = next
  }
  const skillRoot = realpathSync(current)
  assertInside(canonicalProjectRoot, skillRoot)

  const parts = normalized.split('/')
  const fileName = parts.pop()
  if (!fileName) throw new Error(`Skill relativePath is invalid: ${relativePath}`)
  for (const component of parts) {
    const next = safeChildDirectory(current, component, skillRoot, createParents)
    if (!next) return undefined
    current = next
  }

  const target = join(current, fileName)
  assertInside(skillRoot, target)
  const stat = optionalLstat(target)
  if (stat) {
    requireRegularFileNoSymlink(target, 'materialized Skill')
    assertInside(skillRoot, realpathSync(target))
  }
  return { target, parent: current, parentIdentity: fileIdentity(lstatSync(current)), exists: Boolean(stat) }
}

function safeChildDirectory(
  parent: string,
  component: string,
  controlledRoot: string,
  create: boolean
): string | undefined {
  const target = join(parent, component)
  assertInside(controlledRoot, target)
  let stat = optionalLstat(target)
  if (!stat) {
    if (!create) return undefined
    try {
      mkdirSync(target, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    stat = optionalLstat(target)
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Controlled Skill parent must be a real directory: ${target}`)
  }
  const canonical = realpathSync(target)
  assertInside(controlledRoot, canonical)
  return target
}

function requireDirectoryNoSymlink(target: string, label: string): Stats {
  const stat = optionalLstat(target)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${target}`)
  }
  return stat
}

function requireRegularFileNoSymlink(target: string, label: string): Stats {
  const stat = optionalLstat(target)
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${target}`)
  }
  return stat
}

function optionalLstat(target: string): Stats | undefined {
  try {
    return lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory, constants.O_RDONLY | noFollowFlag())
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
}

function fileIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`
}

function assertInside(root: string, target: string): void {
  const fromRoot = relative(resolve(root), resolve(target))
  if (fromRoot === '') return
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    throw new Error(`Path escapes controlled Skill root: ${target}`)
  }
}
