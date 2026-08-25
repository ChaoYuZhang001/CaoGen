import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupDurableFileOrphansSync, writeDurableFile } from '../durable-file'
import { canonicalJson } from '../project-workspace/codec'
import type { SearchBrokerResult, SearchBrokerIdempotencyStore } from './search-broker'

const STORE_SCHEMA_VERSION = 1
const MAX_OPERATION_BYTES = 4 * 1024 * 1024

interface SearchOperationDocumentBody {
  schemaVersion: typeof STORE_SCHEMA_VERSION
  operationId: string
  result: SearchBrokerResult
}

interface SearchOperationDocument extends SearchOperationDocumentBody {
  payloadDigest: string
}

export class SearchBrokerStoreConflictError extends Error {
  readonly code = 'SEARCH_OPERATION_CONFLICT'

  constructor(operationId: string) {
    super(`Search operation ${operationId} already has a different durable result`)
    this.name = 'SearchBrokerStoreConflictError'
  }
}

export function createDurableSearchStore(rootDir: string, projectId: string): SearchBrokerIdempotencyStore {
  const storeRoot = join(rootDir, 'search-broker', sha256(projectId))
  const operationRoot = join(storeRoot, 'operations')
  const legacyPath = join(storeRoot, 'operations.json')
  return {
    get(operationId: string): SearchBrokerResult | undefined {
      const normalizedId = requiredOperationId(operationId)
      return readOperation(operationFile(operationRoot, normalizedId), normalizedId) ??
        readLegacyOperation(legacyPath, normalizedId)
    },
    async put(operationId: string, result: SearchBrokerResult): Promise<void> {
      const normalizedId = requiredOperationId(operationId)
      const normalizedResult = normalizeResult(normalizedId, result)
      const filePath = operationFile(operationRoot, normalizedId)
      const current = readOperation(filePath, normalizedId) ?? readLegacyOperation(legacyPath, normalizedId)
      if (current && !sameResult(current, normalizedResult)) throw new SearchBrokerStoreConflictError(normalizedId)
      if (existsSync(filePath)) return

      const body: SearchOperationDocumentBody = {
        schemaVersion: STORE_SCHEMA_VERSION,
        operationId: normalizedId,
        result: normalizedResult
      }
      const document: SearchOperationDocument = { ...body, payloadDigest: digest(body) }
      try {
        await writeDurableFile(filePath, `${canonicalJson(document)}\n`, { mode: 0o600, replace: false })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const winner = readOperation(filePath, normalizedId)
        if (!winner || !sameResult(winner, normalizedResult)) {
          throw new SearchBrokerStoreConflictError(normalizedId)
        }
      }
    }
  }
}

function readOperation(filePath: string, operationId: string): SearchBrokerResult | undefined {
  cleanupDurableFileOrphansSync(filePath)
  if (!existsSync(filePath)) return undefined
  const parsed = readBoundedJson(filePath)
  if (!plainObject(parsed) || parsed.schemaVersion !== STORE_SCHEMA_VERSION ||
      parsed.operationId !== operationId || !plainObject(parsed.result) ||
      typeof parsed.payloadDigest !== 'string') {
    throw new Error(`Search operation ${operationId} document is invalid`)
  }
  const body: SearchOperationDocumentBody = {
    schemaVersion: STORE_SCHEMA_VERSION,
    operationId,
    result: normalizeResult(operationId, parsed.result as unknown as SearchBrokerResult)
  }
  if (parsed.payloadDigest !== digest(body)) throw new Error(`Search operation ${operationId} digest mismatch`)
  return clone(body.result)
}

function readLegacyOperation(filePath: string, operationId: string): SearchBrokerResult | undefined {
  if (!existsSync(filePath)) return undefined
  const parsed = readBoundedJson(filePath)
  if (!plainObject(parsed)) throw new Error('Legacy Search Broker operation store is invalid')
  const value = parsed[operationId]
  return value === undefined ? undefined : normalizeResult(operationId, value as SearchBrokerResult)
}

function normalizeResult(operationId: string, value: SearchBrokerResult): SearchBrokerResult {
  if (!plainObject(value) || value.operationId !== operationId || typeof value.ok !== 'boolean' ||
      (value.mode !== 'model_native' && value.mode !== 'byok_search_adapter') ||
      !Array.isArray(value.results) || !Array.isArray(value.citations)) {
    throw new Error(`Search operation ${operationId} result is invalid`)
  }
  const status = String(value.status)
  if (value.ok ? status !== 'success' : status === 'success') {
    throw new Error(`Search operation ${operationId} result status is invalid`)
  }
  return clone({ ...value, idempotentReplay: false } as SearchBrokerResult)
}

function readBoundedJson(filePath: string): unknown {
  const bytes = readFileSync(filePath)
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_OPERATION_BYTES) {
    throw new Error(`Search operation document size is invalid: ${filePath}`)
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new Error(`Search operation document is not valid JSON: ${filePath}`)
  }
}

function operationFile(root: string, operationId: string): string {
  return join(root, `${sha256(operationId)}.json`)
}

function requiredOperationId(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 512) throw new Error('Search operationId is invalid')
  return normalized
}

function sameResult(left: SearchBrokerResult, right: SearchBrokerResult): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function digest(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
