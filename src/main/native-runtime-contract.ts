import type { EngineKind } from '../shared/types'
import {
  NATIVE_RUNTIME_CONTRACT_ID,
  NATIVE_RUNTIME_SCHEMA_VERSION,
  type NativeRuntimeAdapterDeclaration,
  type NativeRuntimeCapabilityDomain,
  type NativeRuntimeCapabilityMatrix,
  type NativeRuntimeContract
} from '../shared/native-runtime-types'

const CAPABILITY_DOMAINS = Object.freeze([
  'session',
  'run',
  'context',
  'tool',
  'permission',
  'usage',
  'error',
  'checkpoint',
  'hook',
  'recovery'
] satisfies NativeRuntimeCapabilityDomain[])

const capabilities: NativeRuntimeCapabilityMatrix = Object.freeze({
  session: Object.freeze(['start', 'send', 'interrupt', 'rename', 'dispose']),
  run: Object.freeze(['bind', 'execute', 'settle']),
  context: Object.freeze(['message', 'history', 'pressure']),
  tool: Object.freeze(['request', 'result', 'effect']),
  permission: Object.freeze(['request', 'resolve', 'mode']),
  usage: Object.freeze(['input', 'output', 'cache-read', 'cache-write', 'cost']),
  error: Object.freeze(['classify', 'redact', 'terminal']),
  checkpoint: Object.freeze(['capture', 'restore', 'resume']),
  hook: Object.freeze(['emit', 'order']),
  recovery: Object.freeze(['serialize', 'rehydrate', 'reconcile'])
})

export const NATIVE_RUNTIME_CONTRACT: NativeRuntimeContract = Object.freeze({
  schemaVersion: NATIVE_RUNTIME_SCHEMA_VERSION,
  id: NATIVE_RUNTIME_CONTRACT_ID,
  capabilities
})

export const CLAUDE_NATIVE_RUNTIME_ADAPTER = defineNativeRuntimeAdapter(
  'claude',
  'claude.agent-sdk'
)

export const ANTHROPIC_NATIVE_RUNTIME_ADAPTER = defineNativeRuntimeAdapter(
  'anthropic',
  'anthropic.messages'
)

export const OPENAI_NATIVE_RUNTIME_ADAPTER = defineNativeRuntimeAdapter(
  'openai',
  'openai.compatible'
)

export class NativeRuntimeContractError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'NativeRuntimeContractError'
    this.code = code
  }
}

export function defineNativeRuntimeAdapter(
  engineKind: EngineKind,
  protocol: string
): NativeRuntimeAdapterDeclaration {
  const declaration: NativeRuntimeAdapterDeclaration = Object.freeze({
    schemaVersion: NATIVE_RUNTIME_SCHEMA_VERSION,
    contractId: NATIVE_RUNTIME_CONTRACT_ID,
    engineKind,
    protocol,
    capabilities
  })
  assertNativeRuntimeAdapterDeclaration(declaration, engineKind)
  return declaration
}

export function assertNativeRuntimeAdapterDeclaration(
  value: unknown,
  expectedKind?: string
): asserts value is NativeRuntimeAdapterDeclaration {
  const record = requireRecord(value, 'adapter declaration')
  if (record.schemaVersion !== NATIVE_RUNTIME_SCHEMA_VERSION) {
    fail('adapter_schema', 'native runtime adapter schemaVersion must be 1')
  }
  if (record.contractId !== NATIVE_RUNTIME_CONTRACT_ID) {
    fail('adapter_contract', `native runtime adapter must target ${NATIVE_RUNTIME_CONTRACT_ID}`)
  }
  if (!isEngineKind(record.engineKind)) {
    fail('adapter_engine', 'native runtime adapter engineKind is invalid')
  }
  if (expectedKind !== undefined && record.engineKind !== expectedKind) {
    fail(
      'adapter_identity',
      `native runtime adapter identity ${String(record.engineKind)} does not match ${expectedKind}`
    )
  }
  if (typeof record.protocol !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(record.protocol)) {
    fail('adapter_protocol', 'native runtime adapter protocol identity is invalid')
  }
  assertCapabilities(record.capabilities)
}

export function nativeRuntimeAdapterFingerprint(
  declaration: NativeRuntimeAdapterDeclaration
): string {
  assertNativeRuntimeAdapterDeclaration(declaration)
  return JSON.stringify({
    schemaVersion: declaration.schemaVersion,
    contractId: declaration.contractId,
    engineKind: declaration.engineKind,
    protocol: declaration.protocol,
    capabilities: CAPABILITY_DOMAINS.map((domain) => [domain, declaration.capabilities[domain]])
  })
}

export function isNativeRuntimeFrozen(): boolean {
  if (!Object.isFrozen(NATIVE_RUNTIME_CONTRACT) || !Object.isFrozen(capabilities)) return false
  return CAPABILITY_DOMAINS.every((domain) => Object.isFrozen(capabilities[domain]))
}

function assertCapabilities(value: unknown): asserts value is NativeRuntimeCapabilityMatrix {
  const record = requireRecord(value, 'adapter capabilities')
  const actualDomains = Object.keys(record).sort()
  const expectedDomains = [...CAPABILITY_DOMAINS].sort()
  if (!sameStrings(actualDomains, expectedDomains)) {
    fail('adapter_capabilities', 'native runtime adapter capability domains are incomplete')
  }
  for (const domain of CAPABILITY_DOMAINS) {
    const actual = record[domain]
    const expected = capabilities[domain]
    if (!Array.isArray(actual) || !sameStrings(actual, expected)) {
      fail('adapter_capabilities', `native runtime adapter capability mismatch: ${domain}`)
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_record', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function sameStrings(left: readonly unknown[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isEngineKind(value: unknown): value is EngineKind {
  return value === 'claude' || value === 'anthropic' || value === 'openai'
}

function fail(code: string, message: string): never {
  throw new NativeRuntimeContractError(code, message)
}
