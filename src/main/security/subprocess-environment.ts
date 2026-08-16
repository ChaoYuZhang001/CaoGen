const BASE_ENV_KEYS = new Set([
  'APPDATA',
  'COLORTERM',
  'COMSPEC',
  'ComSpec',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LANGUAGE',
  'LOCALAPPDATA',
  'LOGNAME',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'Path',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'SHELL',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR'
])

const EXECUTION_INJECTION_KEYS = new Set([
  'BASH_ENV',
  'CDPATH',
  'ENV',
  'GIT_CONFIG_PARAMETERS',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PERL5OPT',
  'PERL5LIB',
  'PROMPT_COMMAND',
  'PYTHONHOME',
  'PYTHONPATH',
  'RUBYLIB',
  'RUBYOPT',
  'SHELLOPTS',
  'ZDOTDIR'
])

const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:ACCESS_KEY|API_KEY|APIKEY|AUTH|AUTHORIZATION|COOKIE|CREDENTIAL|CREDENTIALS|KEY_ID|PASSWORD|PASSWD|PRIVATE_KEY|REFRESH_TOKEN|SECRET|SESSION_TOKEN|SIGNATURE|TOKEN)(?:_|$)/i
const CLOUD_CREDENTIAL_PREFIX = /^(?:ALIBABA|AWS|AZURE|CLOUDFLARE|DIGITALOCEAN|GCP|GH|GITHUB|GITLAB|GOOGLE|OCI|OPENAI|ANTHROPIC|GEMINI|NPM|SLACK|STRIPE|VERCEL)_/i
const NON_SENSITIVE_PACKAGE_CONFIG_KEYS = new Set([
  'NPM_CONFIG_REGISTRY',
  'PIP_INDEX_URL'
])

export interface MinimalSubprocessEnvironmentOptions {
  source?: NodeJS.ProcessEnv
  allowSensitiveOverrides?: boolean
}

export function buildMinimalSubprocessEnv(
  overrides: NodeJS.ProcessEnv = {},
  options: MinimalSubprocessEnvironmentOptions = {}
): NodeJS.ProcessEnv {
  const source = options.source ?? process.env
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && isBaseEnvironmentKey(key) && isSafeEnvironmentValue(value)) {
      env[key] = value
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (
      typeof value === 'string' &&
      isSafeEnvironmentName(key, options.allowSensitiveOverrides === true) &&
      isSafeEnvironmentValue(value)
    ) {
      env[key] = value
    }
  }
  return env
}

// Only use this after the main process has authorized and digest-bound the
// configuration supplying the explicit variables (for example, an MCP server).
export function buildAuthorizedSubprocessEnv(
  overrides: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return buildMinimalSubprocessEnv(overrides, { source, allowSensitiveOverrides: true })
}

export function isSensitiveSubprocessEnvironmentName(name: string): boolean {
  const normalized = name.trim().toUpperCase()
  if (NON_SENSITIVE_PACKAGE_CONFIG_KEYS.has(normalized)) return false
  return normalized.startsWith('CAOGEN_') ||
    normalized === 'SSH_AUTH_SOCK' ||
    normalized === 'SSH_AGENT_PID' ||
    normalized === 'GPG_AGENT_INFO' ||
    CLOUD_CREDENTIAL_PREFIX.test(normalized) ||
    SENSITIVE_ENV_NAME.test(normalized)
}

function isBaseEnvironmentKey(name: string): boolean {
  return BASE_ENV_KEYS.has(name) || /^LC_[A-Z0-9_]+$/.test(name)
}

function isSafeEnvironmentName(name: string, allowSensitive: boolean): boolean {
  if (!name || name !== name.trim() || name.includes('=') || /[\0-\x1F\x7F]/.test(name)) return false
  const normalized = name.toUpperCase()
  if (
    EXECUTION_INJECTION_KEYS.has(normalized) ||
    normalized.startsWith('DYLD_') ||
    normalized.startsWith('CAOGEN_')
  ) {
    return false
  }
  return allowSensitive || !isSensitiveSubprocessEnvironmentName(name)
}

function isSafeEnvironmentValue(value: string): boolean {
  return !value.includes('\0')
}
