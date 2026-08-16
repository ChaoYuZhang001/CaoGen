export interface ArtifactLineageReference {
  id: string
  supersedesId?: string
}

/** Return the current leaves within one already ownership-scoped Artifact set. */
export function currentArtifactLineageLeafIds(
  artifacts: readonly ArtifactLineageReference[]
): ReadonlySet<string> {
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  const supersededIds = new Set(artifacts.flatMap((artifact) =>
    artifact.supersedesId && artifactIds.has(artifact.supersedesId)
      ? [artifact.supersedesId]
      : []))
  return new Set(artifacts.flatMap((artifact) =>
    supersededIds.has(artifact.id) ? [] : [artifact.id]))
}

/**
 * Resolve the current leaf Artifact IDs for every retained version. A caller
 * can keep historical versions visible while pointing users to the exact
 * deliverable version(s) that replaced them.
 */
export function currentArtifactLineageLeafIdsByArtifact(
  artifacts: readonly ArtifactLineageReference[]
): ReadonlyMap<string, readonly string[]> {
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  const leaves = currentArtifactLineageLeafIds(artifacts)
  const successors = new Map<string, string[]>()
  for (const artifact of artifacts) {
    if (!artifact.supersedesId || !artifactIds.has(artifact.supersedesId)) continue
    const values = successors.get(artifact.supersedesId) ?? []
    values.push(artifact.id)
    successors.set(artifact.supersedesId, values)
  }
  for (const values of successors.values()) values.sort()

  const resolved = new Map<string, readonly string[]>()
  const resolve = (artifactId: string, visiting: ReadonlySet<string>): readonly string[] => {
    const cached = resolved.get(artifactId)
    if (cached) return cached
    if (leaves.has(artifactId)) {
      const leaf = [artifactId]
      resolved.set(artifactId, leaf)
      return leaf
    }
    // A cyclic supersession chain is invalid upstream. Returning no current
    // version keeps the UI fail-closed instead of inventing a deliverable.
    if (visiting.has(artifactId)) return []
    const nextVisiting = new Set(visiting)
    nextVisiting.add(artifactId)
    const current = [...new Set((successors.get(artifactId) ?? [])
      .flatMap((successorId) => resolve(successorId, nextVisiting)))].sort()
    resolved.set(artifactId, current)
    return current
  }

  for (const artifact of artifacts) resolve(artifact.id, new Set())
  return resolved
}

export function artifactAcceptanceDeliveryScope(
  linkedArtifactIds: ReadonlySet<string>,
  artifacts: readonly ArtifactLineageReference[]
): 'blocking' | 'historical' {
  if (linkedArtifactIds.size === 0) return 'blocking'
  const leafIds = currentArtifactLineageLeafIds(artifacts)
  return [...linkedArtifactIds].every((artifactId) => !leafIds.has(artifactId))
    ? 'historical'
    : 'blocking'
}
