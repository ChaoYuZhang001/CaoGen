import {
  PROJECT_AGGREGATE_EXPORT_FORMAT,
  PROJECT_AGGREGATE_SCHEMA_VERSION,
  type ProjectAggregateExportResult,
  type ProjectAggregateSeal,
  type ProjectAggregateSnapshot,
  type ProjectAggregateVerification
} from '../../shared/project-aggregate-types'
import { projectAggregateCanonicalJson, projectAggregateDigest } from './codec'

export function buildProjectAggregateVerification(
  aggregate: ProjectAggregateSnapshot,
  seal: ProjectAggregateSeal
): ProjectAggregateVerification {
  return {
    valid: true,
    schemaVersion: PROJECT_AGGREGATE_SCHEMA_VERSION,
    projectId: aggregate.projectId,
    aggregateRevision: seal.aggregateRevision,
    identityDigest: aggregate.identityDigest,
    aggregateDigest: aggregate.aggregateDigest,
    objectCounts: aggregate.objectCounts,
    sanitized: true,
    sealed: true
  }
}

export function buildProjectAggregateExport(
  aggregate: ProjectAggregateSnapshot,
  seal: ProjectAggregateSeal
): ProjectAggregateExportResult {
  const verification = buildProjectAggregateVerification(aggregate, seal)
  const withoutDigest = {
    schemaVersion: PROJECT_AGGREGATE_SCHEMA_VERSION,
    format: PROJECT_AGGREGATE_EXPORT_FORMAT,
    projectId: aggregate.projectId,
    aggregateRevision: seal.aggregateRevision,
    aggregate,
    verification
  }
  const exportDigest = projectAggregateDigest(withoutDigest)
  const bundle = { ...withoutDigest, exportDigest }
  return {
    schemaVersion: PROJECT_AGGREGATE_SCHEMA_VERSION,
    format: PROJECT_AGGREGATE_EXPORT_FORMAT,
    json: projectAggregateCanonicalJson(bundle),
    exportDigest,
    bundle
  }
}
