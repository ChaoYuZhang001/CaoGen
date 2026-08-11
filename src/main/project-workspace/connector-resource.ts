import { createHash } from 'node:crypto'
import type {
  ConnectorReadResult,
  ConnectorResourceContract,
  ProjectResource
} from '../../shared/project-workspace-types'

export interface ConnectorWriteExecutionContext {
  projectId: string
  effectId: string
  reconciliation: ConnectorResourceContract['writePolicy']['reconciliation']
}

export function connectorResourceAvailability(resource: ProjectResource): { available: boolean; reason?: string } {
  if (resource.kind !== 'connector') return { available: false, reason: 'Resource is not a connector' }
  const contract = resource.connector
  if (!contract || contract.schemaVersion !== 1) return { available: false, reason: 'Connector contract is missing' }
  if (contract.authorization.status !== 'active') return { available: false, reason: 'Connector authorization is revoked' }
  if (resource.metadata?.disabled === true || resource.metadata?.revokedAt !== undefined) {
    return { available: false, reason: 'Connector resource is disabled or revoked' }
  }
  return { available: true }
}

export function connectorSupportsRead(resource: ProjectResource): boolean {
  const direction = resource.connector?.dataDirection
  return connectorResourceAvailability(resource).available && (direction === 'read' || direction === 'bidirectional')
}

export function connectorSupportsWrite(resource: ProjectResource): boolean {
  const direction = resource.connector?.dataDirection
  return connectorResourceAvailability(resource).available && (direction === 'write' || direction === 'bidirectional')
}

export function createConnectorReadResult<T>(
  resource: ProjectResource,
  projectId: string,
  input: {
    data: T
    source: string
    version: string
    retrievedAt?: number
    contentDigest?: string
  }
): ConnectorReadResult<T> {
  if (!connectorSupportsRead(resource)) throw new Error('Connector is not authorized for read operations')
  const source = requiredText(input.source, 'connector source')
  const version = requiredText(input.version, 'connector source version')
  const retrievedAt = input.retrievedAt ?? Date.now()
  if (!Number.isFinite(retrievedAt) || retrievedAt < 0) throw new Error('connector retrievedAt is invalid')
  const contentDigest = input.contentDigest ?? digestData(input.data)
  if (!/^sha256:[a-f0-9]{64}$/.test(contentDigest)) throw new Error('connector contentDigest is invalid')
  return {
    data: input.data,
    citation: {
      projectId: requiredText(projectId, 'projectId'),
      resourceId: resource.id,
      source,
      version,
      retrievedAt,
      contentDigest
    }
  }
}

export function assertConnectorWriteExecution(
  resource: ProjectResource,
  context: ConnectorWriteExecutionContext
): void {
  if (!connectorSupportsWrite(resource)) throw new Error('Connector is not authorized for write operations')
  const contract = resource.connector!
  if (contract.writePolicy.effect !== 'required') throw new Error('Connector writes require an Effect record')
  if (!requiredText(context.effectId, 'effectId')) throw new Error('Connector writes require an Effect record')
  if (context.reconciliation !== contract.writePolicy.reconciliation) {
    throw new Error('Connector reconciliation policy does not match the approved resource contract')
  }
}

function digestData(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}
