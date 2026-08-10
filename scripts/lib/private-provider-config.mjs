import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const PRIVATE_DIRECTORY_NAME = '.caogen-private'
const DEFAULT_PROVIDER_FILE_NAME = 'provider-parity.json'
const MAX_PROVIDER_CONFIG_BYTES = 1024 * 1024

export class PrivateProviderConfigError extends Error {
  constructor(code) {
    super(code)
    this.name = 'PrivateProviderConfigError'
    this.code = code
  }
}

export function defaultPrivateProviderConfigPath(homeDirectory = homedir()) {
  return path.join(path.resolve(homeDirectory), PRIVATE_DIRECTORY_NAME, DEFAULT_PROVIDER_FILE_NAME)
}

export function resolvePrivateProviderConfig({
  setting,
  repoRoot = process.cwd(),
  homeDirectory = homedir(),
  allowInline = false,
  allowTestOverride = false
} = {}) {
  const explicit = typeof setting === 'string' ? setting.trim() : ''
  if (explicit && !allowTestOverride) {
    throw new PrivateProviderConfigError('provider_config_override_disabled')
  }
  if (explicit.startsWith('[')) {
    if (!allowInline) throw new PrivateProviderConfigError('provider_config_inline_disabled')
    if (Buffer.byteLength(explicit, 'utf8') > MAX_PROVIDER_CONFIG_BYTES) {
      throw new PrivateProviderConfigError('provider_config_too_large')
    }
    return { source: 'inline', text: explicit }
  }

  const usesPrivateDefault = explicit.length === 0
  const file = usesPrivateDefault
    ? defaultPrivateProviderConfigPath(homeDirectory)
    : path.resolve(repoRoot, explicit)
  const privateDirectory = path.dirname(defaultPrivateProviderConfigPath(homeDirectory))

  if (usesPrivateDefault) assertPrivateDirectory(privateDirectory)
  return {
    source: usesPrivateDefault ? 'private-default' : 'file',
    text: readPrivateJsonFile(file)
  }
}

function assertPrivateDirectory(directory) {
  if (!existsSync(directory)) throw new PrivateProviderConfigError('provider_config_missing')
  let info
  try {
    info = lstatSync(directory)
  } catch {
    throw new PrivateProviderConfigError('provider_config_unreadable')
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PrivateProviderConfigError('provider_config_directory_not_private')
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new PrivateProviderConfigError('provider_config_directory_permissions')
  }
}

function readPrivateJsonFile(file) {
  if (path.extname(file).toLowerCase() !== '.json') {
    throw new PrivateProviderConfigError('provider_config_not_json')
  }
  if (!existsSync(file)) throw new PrivateProviderConfigError('provider_config_missing')
  let info
  try {
    info = lstatSync(file)
  } catch {
    throw new PrivateProviderConfigError('provider_config_unreadable')
  }
  if (!samePath(realpathSync.native(file), path.resolve(file)) || !info.isFile() || info.isSymbolicLink()) {
    throw new PrivateProviderConfigError('provider_config_not_regular')
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new PrivateProviderConfigError('provider_config_permissions')
  }
  if (info.size > MAX_PROVIDER_CONFIG_BYTES) {
    throw new PrivateProviderConfigError('provider_config_too_large')
  }
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new PrivateProviderConfigError('provider_config_unreadable')
  }
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(left)
  const normalizedRight = path.normalize(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}
