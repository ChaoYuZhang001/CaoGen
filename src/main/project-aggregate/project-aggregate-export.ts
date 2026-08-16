import {
  PROJECT_AGGREGATE_EXPORT_FORMAT,
  PROJECT_AGGREGATE_SCHEMA_VERSION,
  type ProjectAggregateExportResult,
  type ProjectAggregateAutomation,
  type ProjectAggregateDependencies,
  type ProjectAggregatePortableRuntime,
  type ProjectAggregatePortfolio,
  type ProjectAggregateExportBundle,
  type ProjectAggregateSeal,
  type ProjectAggregateSnapshot,
  type ProjectAggregateVerification
} from '../../shared/project-aggregate-types'
import {
  assertNoCredentialMaterial,
  projectAggregateCanonicalJson,
  projectAggregateDigest,
  sanitizeProjectAggregateValue
} from './codec'

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
  seal: ProjectAggregateSeal,
  dependencies: ProjectAggregateDependencies,
  automation: ProjectAggregateAutomation,
  portfolio: ProjectAggregatePortfolio,
  runtime: ProjectAggregatePortableRuntime,
  media?: ProjectAggregateExportBundle['media']
): ProjectAggregateExportResult {
  const safeAggregate = sanitizeProjectAggregateValue(aggregate) as ProjectAggregateSnapshot
  const safeDependencies = sanitizeProjectAggregateValue(dependencies) as ProjectAggregateDependencies
  const safeAutomation = sanitizeProjectAggregateValue(automation) as ProjectAggregateAutomation
  const safePortfolio = sanitizeProjectAggregateValue(portfolio) as ProjectAggregatePortfolio
  const safeRuntime = sanitizeProjectAggregateValue(runtime) as ProjectAggregatePortableRuntime
  const safeMedia = media === undefined ? undefined : sanitizeMediaSlice(media)
  const verification = buildProjectAggregateVerification(safeAggregate, seal)
  const withoutDigest = {
    schemaVersion: PROJECT_AGGREGATE_SCHEMA_VERSION,
    format: PROJECT_AGGREGATE_EXPORT_FORMAT,
    projectId: safeAggregate.projectId,
    aggregateRevision: seal.aggregateRevision,
    aggregate: safeAggregate,
    dependencies: safeDependencies,
    automation: safeAutomation,
    portfolio: safePortfolio,
    runtime: safeRuntime,
    ...(safeMedia ? { media: safeMedia } : {}),
    verification
  }
  const exportDigest = projectAggregateDigest(withoutDigest)
  const bundle = { ...withoutDigest, exportDigest }
  assertNoCredentialMaterial(bundle)
  return {
    schemaVersion: PROJECT_AGGREGATE_SCHEMA_VERSION,
    format: PROJECT_AGGREGATE_EXPORT_FORMAT,
    json: projectAggregateCanonicalJson(bundle),
    exportDigest,
    bundle
  }
}

function sanitizeMediaSlice(
  media: NonNullable<ProjectAggregateExportBundle['media']>
): NonNullable<ProjectAggregateExportBundle['media']> {
  const sanitized = sanitizeProjectAggregateValue(media) as NonNullable<ProjectAggregateExportBundle['media']>
  const { mediaDigest: _mediaDigest, ...body } = sanitized
  return { ...body, mediaDigest: projectAggregateDigest(body) }
}
