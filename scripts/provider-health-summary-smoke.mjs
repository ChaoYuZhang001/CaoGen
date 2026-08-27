#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const providerList = read('src/renderer/src/components/settings/ProviderList.tsx')
const i18n = read('src/renderer/src/i18n.ts')
const translations = read('src/renderer/src/i18n/providerHealthTranslations.ts')
const styles = read('src/renderer/src/styles.css')

assert(providerList.includes('function ProviderHealthSummary'), 'ProviderList must render a visible health summary')
assert(providerList.includes('data-provider-health-summary'), 'health summary must expose a stable DOM hook')
assert(
  providerList.includes('health.recentFailures?.[0]?.message') && providerList.includes('health.lastProbeError'),
  'summary must surface generation and probe failure reasons'
)
assert(
  providerList.includes('aria-label={accessibleLabel}') && providerList.includes('role="status"'),
  'health summary must be accessible without relying on title'
)
assert(
  providerList.includes('safeProviderHealthMessage') && providerList.includes('[redacted]') && providerList.includes('[URL]'),
  'visible failure details must be redacted and bounded'
)
for (const key of [
  'providerHealthNotChecked',
  'providerHealthHealthy',
  'providerHealthDegraded',
  'providerHealthProbeFailed',
  'providerHealthUnhealthy',
  'providerHealthCircuitOpen',
  'providerHealthCircuitHalfOpen'
]) {
  assert(translations.includes(`${key}:`), `missing localized Provider health key: ${key}`)
}
assert(
  i18n.includes("import { PROVIDER_HEALTH_TRANSLATIONS } from './i18n/providerHealthTranslations'") &&
    i18n.includes('...PROVIDER_HEALTH_TRANSLATIONS'),
  'Provider health translations must be merged into the runtime dictionary'
)
for (const selector of ['.provider-health-summary', '.provider-health-detail', '.health-unknown', '.health-warn']) {
  assert(styles.includes(selector), `missing Provider health style: ${selector}`)
}
console.log('provider health summary smoke ok: 17/17')

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
