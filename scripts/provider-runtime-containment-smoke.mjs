import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-runtime-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  compile(outDir)
  const runtime = await import(pathToFileURL(findCompiled(outDir, 'claudeRuntimePolicy.js')).href)
  const agentSession = readFileSync(path.join(repoRoot, 'src/main/agentSession.ts'), 'utf8')
  const providerAuth = readFileSync(path.join(repoRoot, 'src/main/providerRuntimeAuth.ts'), 'utf8')

  assertAgentSessionIntegration(agentSession)
  assertProviderCredentialIsolation(providerAuth)
  runRuntimePolicyChecks(runtime)
  console.log('providerRuntimeContainment smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function runRuntimePolicyChecks(runtime) {
  const secrets = {
    host: 'host-secret-canary',
    npm: 'npm-secret-canary',
    oauth: 'oauth-secret-canary',
    api: 'api-secret-canary',
    proxy: 'http://proxy-user:proxy-password@127.0.0.1:8118',
    ca: '/private/enterprise/secret-ca.pem',
    clientCert: '/private/enterprise/client-cert.pem',
    clientKey: '/private/enterprise/client-key.pem',
    clientKeyPassphrase: 'client-key-passphrase-canary',
    headers: 'X-Gateway-Route: route-secret-canary'
  }
  const source = {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp/caogen-home',
    HTTPS_PROXY: secrets.proxy,
    NO_PROXY: '127.0.0.1,localhost',
    NODE_EXTRA_CA_CERTS: secrets.ca,
    CLAUDE_CODE_CLIENT_CERT: secrets.clientCert,
    CLAUDE_CODE_CLIENT_KEY: secrets.clientKey,
    CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: secrets.clientKeyPassphrase,
    CLAUDE_CODE_OAUTH_TOKEN: secrets.oauth,
    ANTHROPIC_API_KEY: secrets.api,
    ANTHROPIC_CUSTOM_HEADERS: secrets.headers,
    CAOGEN_RUNTIME_SECRET_CANARY: secrets.host,
    NPM_TOKEN: secrets.npm,
    NODE_OPTIONS: '--require /tmp/untrusted-preload.cjs',
    SSH_AUTH_SOCK: '/tmp/untrusted-agent.sock'
  }

  const env = runtime.buildClaudeRuntimeEnvironment(source)
  equal(env.PATH, source.PATH, 'PATH must remain available')
  equal(env.HOME, source.HOME, 'HOME must remain available')
  equal(env.HTTPS_PROXY, secrets.proxy, 'explicit proxy must remain available')
  equal(env.NO_PROXY, source.NO_PROXY, 'proxy bypass list must remain available')
  equal(env.NODE_EXTRA_CA_CERTS, secrets.ca, 'explicit CA path must remain available')
  equal(env.CLAUDE_CODE_CLIENT_CERT, secrets.clientCert, 'explicit client certificate must remain available')
  equal(env.CLAUDE_CODE_CLIENT_KEY, secrets.clientKey, 'explicit client key path must remain available')
  equal(env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE, secrets.clientKeyPassphrase, 'explicit client key passphrase must remain available')
  equal(env.CLAUDE_CODE_OAUTH_TOKEN, secrets.oauth, 'explicit OAuth token must remain available')
  equal(env.ANTHROPIC_API_KEY, secrets.api, 'explicit Anthropic key must remain available')
  equal(env.ANTHROPIC_CUSTOM_HEADERS, secrets.headers, 'explicit Anthropic headers must remain available')
  equal(env.CAOGEN_RUNTIME_SECRET_CANARY, undefined, 'unknown host secrets must be removed')
  equal(env.NPM_TOKEN, undefined, 'package registry tokens must be removed')
  equal(env.NODE_OPTIONS, undefined, 'Node preload injection must be removed')
  equal(env.SSH_AUTH_SOCK, undefined, 'undeclared agent sockets must be removed')

  const windowsEnv = runtime.buildClaudeRuntimeEnvironment({
    Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\caogen',
    APPDATA: 'C:\\Users\\caogen\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\caogen\\AppData\\Local',
    TEMP: 'C:\\Temp',
    SystemRoot: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD'
  })
  equal(windowsEnv.Path, 'C:\\Windows\\System32', 'Windows Path must remain available')
  equal(windowsEnv.USERPROFILE, 'C:\\Users\\caogen', 'Windows home must remain available')
  equal(windowsEnv.TEMP, 'C:\\Temp', 'Windows temp must remain available')
  equal(windowsEnv.SystemRoot, 'C:\\Windows', 'Windows system root must remain available')

  const policy = runtime.createClaudeRuntimeLaunchPolicy(env)
  runtime.assertClaudeRuntimeLaunchPolicy(policy)
  equal(policy.settingSources.length, 0, 'filesystem settings must be disabled')
  equal(policy.strictMcpConfig, true, 'MCP discovery must be explicit-only')
  equal(policy.manifest.filesystemSettings, 'disabled', 'manifest must bind settings isolation')
  equal(policy.manifest.mcpDiscovery, 'explicit-only', 'manifest must bind MCP isolation')
  assert(Object.isFrozen(policy.env), 'sealed runtime environment must be immutable')
  assert(Object.isFrozen(policy.manifest), 'runtime manifest must be immutable')

  const manifestText = JSON.stringify(policy.manifest)
  for (const secret of Object.values(secrets)) {
    assert(!manifestText.includes(secret), 'manifest must not contain plaintext environment values')
  }

  const cleanEnv = runtime.buildClaudeRuntimeEnvironment({ ...source, CAOGEN_RUNTIME_SECRET_CANARY: undefined })
  const cleanPolicy = runtime.createClaudeRuntimeLaunchPolicy(cleanEnv)
  equal(policy.manifest.digest, cleanPolicy.manifest.digest, 'removed host secrets must not affect the manifest')

  assertThrows(
    () => runtime.createClaudeRuntimeLaunchPolicy({ ...env, NPM_TOKEN: secrets.npm }),
    'undeclared environment must fail closed',
    [secrets.npm, 'NPM_TOKEN']
  )
  assertThrows(
    () => runtime.assertClaudeRuntimeLaunchPolicy({
      ...policy,
      env: { ...policy.env, ANTHROPIC_API_KEY: 'tampered-api-key' }
    }),
    'environment changes must invalidate the manifest',
    ['tampered-api-key', secrets.api]
  )
  assertThrows(
    () => runtime.assertClaudeRuntimeLaunchPolicy({ ...policy, settingSources: ['user'] }),
    'filesystem settings changes must fail closed',
    []
  )
  assertThrows(
    () => runtime.assertClaudeRuntimeLaunchPolicy({ ...policy, strictMcpConfig: false }),
    'MCP discovery changes must fail closed',
    []
  )
}

function assertAgentSessionIntegration(source) {
  for (const expected of [
    'buildClaudeRuntimeEnvironment(process.env)',
    'createClaudeRuntimeLaunchPolicy(this.buildEnv())',
    'assertClaudeRuntimeLaunchPolicy(runtimePolicy)',
    'throw new Error(`Provider 不存在:${this.meta.providerId}`)',
    'env: runtimePolicy.env',
    'settingSources: runtimePolicy.settingSources',
    'strictMcpConfig: runtimePolicy.strictMcpConfig'
  ]) {
    assert(source.includes(expected), `AgentSession missing runtime containment: ${expected}`)
  }
  assert(!source.includes('const env = { ...process.env }'), 'AgentSession must not inherit the complete host environment')
}

function assertProviderCredentialIsolation(source) {
  for (const expected of [
    "'CLAUDE_CODE_OAUTH_TOKEN'",
    "'ANTHROPIC_BASE_URL'",
    "'ANTHROPIC_CUSTOM_HEADERS'",
    'clearClaudeHostCredentials(env)'
  ]) {
    assert(source.includes(expected), `Provider credential isolation missing: ${expected}`)
  }
}

function compile(outDirPath) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/provider/claudeRuntimePolicy.ts',
      '--outDir',
      outDirPath,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled ${fileName} not found`)
}

function findCompiledOptional(root, fileName) {
  try {
    return findCompiled(root, fileName)
  } catch {
    return null
  }
}

function assertThrows(fn, message, forbiddenFragments) {
  let errorText = ''
  try {
    fn()
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error)
  }
  assert(errorText, message)
  for (const fragment of forbiddenFragments) {
    assert(!errorText.includes(fragment), 'runtime errors must not expose secret values or undeclared names')
  }
}

function equal(actual, expected, message) {
  assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
