import { createHash, timingSafeEqual } from 'node:crypto'

const CLAUDE_RUNTIME_ENV_KEYS = new Set([
  // Process launch and platform basics.
  'PATH',
  'Path',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',
  'USERNAME',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  // Explicit network routing and enterprise trust material.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CLAUDE_CODE_CERT_STORE',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  // Claude login and the selected Provider connection contract.
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS'
])

interface ClaudeRuntimeCapabilityManifestWithoutDigest {
  schemaVersion: 1
  runtime: 'claude-agent-sdk'
  filesystemSettings: 'disabled'
  mcpDiscovery: 'explicit-only'
  settingSources: []
  strictMcpConfig: true
  environmentKeys: string[]
  environmentDigest: string
}

export interface ClaudeRuntimeCapabilityManifest extends ClaudeRuntimeCapabilityManifestWithoutDigest {
  digest: string
}

export interface ClaudeRuntimeLaunchPolicy {
  env: NodeJS.ProcessEnv
  settingSources: []
  strictMcpConfig: true
  manifest: ClaudeRuntimeCapabilityManifest
}

export function buildClaudeRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of CLAUDE_RUNTIME_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string') env[key] = value
  }
  return env
}

export function createClaudeRuntimeLaunchPolicy(env: NodeJS.ProcessEnv): ClaudeRuntimeLaunchPolicy {
  assertDeclaredEnvironment(env)
  const sealedEnv = Object.freeze({ ...env }) as NodeJS.ProcessEnv
  const settingSources = Object.freeze([]) as unknown as []
  const manifest = freezeManifest(buildManifest(sealedEnv))
  return Object.freeze({
    env: sealedEnv,
    settingSources,
    strictMcpConfig: true,
    manifest
  })
}

export function assertClaudeRuntimeLaunchPolicy(policy: ClaudeRuntimeLaunchPolicy): void {
  if (!Array.isArray(policy.settingSources) || policy.settingSources.length !== 0) {
    throw new Error('Claude runtime filesystem settings must remain disabled')
  }
  if (policy.strictMcpConfig !== true) {
    throw new Error('Claude runtime MCP discovery must remain explicit-only')
  }
  assertDeclaredEnvironment(policy.env)
  const expected = buildManifest(policy.env)
  if (!sameDigest(expected.digest, policy.manifest.digest)) {
    throw new Error('Claude runtime capability manifest digest mismatch')
  }
  if (JSON.stringify(expected) !== JSON.stringify(policy.manifest)) {
    throw new Error('Claude runtime capability manifest does not match launch policy')
  }
}

function assertDeclaredEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (!CLAUDE_RUNTIME_ENV_KEYS.has(key) || typeof value !== 'string') {
      throw new Error('Claude runtime environment contains an undeclared capability')
    }
  }
}

function buildManifest(env: NodeJS.ProcessEnv): ClaudeRuntimeCapabilityManifest {
  const environmentEntries = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right))
  const withoutDigest: ClaudeRuntimeCapabilityManifestWithoutDigest = {
    schemaVersion: 1,
    runtime: 'claude-agent-sdk',
    filesystemSettings: 'disabled',
    mcpDiscovery: 'explicit-only',
    settingSources: [],
    strictMcpConfig: true,
    environmentKeys: environmentEntries.map(([key]) => key),
    environmentDigest: sha256(JSON.stringify(environmentEntries))
  }
  return { ...withoutDigest, digest: sha256(JSON.stringify(withoutDigest)) }
}

function freezeManifest(manifest: ClaudeRuntimeCapabilityManifest): ClaudeRuntimeCapabilityManifest {
  Object.freeze(manifest.settingSources)
  Object.freeze(manifest.environmentKeys)
  return Object.freeze(manifest)
}

function sameDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
