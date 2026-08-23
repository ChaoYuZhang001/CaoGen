declare const __CAOGEN_APP_VERSION__: string

const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/

export function resolveAppVersion(readRuntimeVersion?: () => string): string {
  const fallback = typeof __CAOGEN_APP_VERSION__ === 'string'
    ? __CAOGEN_APP_VERSION__
    : process.env.CAOGEN_APP_VERSION || process.env.npm_package_version || '0.0.0'
  try {
    const runtimeVersion = readRuntimeVersion?.().trim() ?? ''
    return VERSION_PATTERN.test(runtimeVersion) ? runtimeVersion : fallback
  } catch {
    return fallback
  }
}
