import { createHash } from 'node:crypto'

export function assertProjectResource(project, kind, location) {
  const resource = project.resources.find((candidate) => candidate.kind === kind)
  if (!resource) throw new Error(`missing ${kind} resource`)
  if ((resource.path ?? resource.uri) !== location) {
    throw new Error(`${kind} location mismatch: ${resource.path ?? resource.uri}`)
  }
}

export function verifyProjectExportDigest(bundle) {
  const { exportDigest, ...body } = bundle
  return digestStableValue(body) === exportDigest
}

export function verifyDeletionProofDigest(proof) {
  const { proofDigest, ...body } = proof
  return digestStableValue(body) === proofDigest
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function digestStableValue(value) {
  return sha256Hex(JSON.stringify(stableValue(value)))
}

function stableValue(value) {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) output[key] = stableValue(value[key])
  }
  return output
}
