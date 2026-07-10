const SAFE_LOCAL_GIT_CONFIG = ['-c', 'core.fsmonitor=false'] as const

const SAFE_REMOTE_GIT_CONFIG = [
  ...SAFE_LOCAL_GIT_CONFIG,
  '-c',
  'credential.helper=',
  '-c',
  'credential.interactive=never',
  '-c',
  'core.askPass=',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.file.allow=always',
  '-c',
  'protocol.http.allow=always',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'protocol.ssh.allow=always',
  '-c',
  'protocol.git.allow=always'
] as const

const REMOTE_COMMAND_ENV_KEYS = new Set([
  'GIT_ASKPASS',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_EXEC_PATH',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PROXY_COMMAND',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_WORK_TREE',
  'SSH_ASKPASS',
  'SSH_ASKPASS_REQUIRE'
])

// Repository-local fsmonitor commands are executable code. CaoGen's structured
// Git reads must never run them implicitly, especially for permission-free tools.
export function withSafeLocalGitConfig(args: readonly string[]): string[] {
  return [...SAFE_LOCAL_GIT_CONFIG, ...args]
}

// Remote reconciliation is a read-only probe, so it must not inherit command
// hooks from repository/global Git config or the parent process environment.
export function withSafeRemoteGitConfig(args: readonly string[]): string[] {
  return [...SAFE_REMOTE_GIT_CONFIG, ...args]
}

export function isolatedRemoteGitEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv }
  for (const key of Object.keys(env)) {
    if (
      REMOTE_COMMAND_ENV_KEYS.has(key) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) {
      delete env[key]
    }
  }
  env.GCM_INTERACTIVE = 'Never'
  env.GIT_CONFIG_COUNT = '0'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_PROTOCOL_FROM_USER = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}
