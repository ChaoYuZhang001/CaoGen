import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  OutboundContextItemView,
  OutboundDataClass,
  ProjectResource,
  ProjectResourceEgressPolicy,
  ProjectWorkspace
} from '../../shared/project-workspace-types'
import type { SessionMeta } from '../../shared/types'
import { openProjectWorkspaceStore } from './store'

const MAX_DISCOVERED_FILES = 24
const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_SOURCE_CHARS = 12_000
const MAX_PROMPT_CHARS = 48_000
const KNOWLEDGE_DIRECTORIES = ['docs', 'knowledge', 'notes', 'references', 'resources'] as const
const ROOT_SOURCE_NAMES = [
  'AGENTS.md',
  'CLAUDE.md',
  'caogen.md',
  '.caogen.md',
  'README.md',
  'README.en.md',
  'REQUIREMENTS.md',
  'ROADMAP.md',
  'STATUS.md'
] as const

interface LocalResourceRoot {
  resource: ProjectResource
  rootPath: string
  filePath?: string
}

export interface ProjectKnowledgeSource {
  resourceId: string
  resourceKind: ProjectResource['kind']
  path: string
  digest: string
  bytes: number
  modifiedAt: number
  truncated: boolean
  content: string
}

export interface ProjectResourceContext {
  projectId?: string
  projectRevision?: number
  projectPolicyDigest?: string
  prompt: string
  promptDigest?: string
  items: OutboundContextItemView[]
}

/**
 * Builds a bounded, source-labelled Project context for every engine. Resource
 * registration remains the authority boundary; discovery never scans outside
 * the local roots explicitly attached to the active Project.
 */
export async function buildProjectResourceContextPrompt(
  meta: Pick<SessionMeta, 'projectId' | 'workspaceId'>,
  rootDir: string
): Promise<string> {
  return (await buildProjectResourceContext(meta, rootDir)).prompt
}

/** Builds the Provider prompt and its content-free policy projection together. */
export async function buildProjectResourceContext(
  meta: Pick<SessionMeta, 'projectId' | 'workspaceId'>,
  rootDir: string
): Promise<ProjectResourceContext> {
  const canonicalProjectId = meta.workspaceId
  const projectId = canonicalProjectId ?? meta.projectId
  if (!projectId) return { prompt: '', items: [] }
  const store = await openProjectWorkspaceStore(rootDir)
  const workspace = await store.getWorkspace(projectId)
  if (!workspace || workspace.status !== 'active') {
    // A legacy path Project does not claim a canonical policy revision. An
    // explicit Workspace does, so keep its id and let preflight fail closed.
    return canonicalProjectId ? { projectId, prompt: '', items: [] } : { prompt: '', items: [] }
  }

  const roots = resolveLocalResourceRoots(workspace)
  const allowedRoots = roots.filter(({ resource }) => projectResourceEgressPolicy(resource) !== 'deny')
  const sources = discoverProjectKnowledgeSources(workspace, allowedRoots)
  const external = workspace.resources.filter((resource) =>
    (resource.kind === 'connector' || resource.kind === 'url') && projectResourceIsEnabled(resource))
  const sourceIds = new Set(sources.map((source) => source.resourceId))
  const items: OutboundContextItemView[] = []
  for (const resource of [...workspace.resources].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!projectResourceIsEnabled(resource)) continue
    const dataClass = projectResourceDataClass(resource)
    const egressPolicy = projectResourceEgressPolicy(resource)
    if (egressPolicy === 'deny') {
      items.push(resourceContextItem(resource, dataClass, egressPolicy, 'excluded',
        dataClass === 'S3' ? 'S3 resources never enter Provider context' : 'Resource is configured as no-egress'))
      continue
    }
    if (!sourceIds.has(resource.id) && resource.kind !== 'connector' && resource.kind !== 'url') {
      items.push(resourceContextItem(resource, dataClass, egressPolicy, 'excluded', 'No readable bounded context was discovered'))
    }
  }

  const retrievedAt = new Date().toISOString()
  const lines = [
    '# CaoGen Project Resources',
    `Project: ${workspace.name} (${workspace.id})`,
    `Retrieved at: ${retrievedAt}`,
    'Only the sources registered to this Project are listed here. Do not infer access to another Project or to an unlisted source.'
  ]

  for (const source of sources) {
    const resource = workspace.resources.find((candidate) => candidate.id === source.resourceId)
    if (!resource) continue
    items.push({
      id: `resource:${source.resourceId}:sha256:${source.digest}`,
      kind: 'project_resource',
      label: resource.label?.trim() || resource.kind,
      dataClass: projectResourceDataClass(resource),
      egressPolicy: projectResourceEgressPolicy(resource),
      decision: 'included',
      resourceId: source.resourceId,
      bytes: source.bytes,
      digest: `sha256:${source.digest}`,
      ...(source.truncated ? { reason: 'Content is bounded and truncated before dispatch' } : {})
    })
    lines.push(
      '',
      `## ${basename(source.path)}`,
      `source: ${source.path}`,
      `resourceId: ${source.resourceId}`,
      `resourceKind: ${source.resourceKind}`,
      `version: sha256:${source.digest}`,
      `modifiedAt: ${new Date(source.modifiedAt).toISOString()}`,
      `bytes: ${source.bytes}${source.truncated ? ' (content truncated)' : ''}`,
      '',
      source.content
    )
  }

  for (const resource of external) {
    const dataClass = projectResourceDataClass(resource)
    const egressPolicy = projectResourceEgressPolicy(resource)
    const included = egressPolicy !== 'deny'
    if (!included) continue
    items.push(resourceContextItem(
      resource,
      dataClass,
      egressPolicy,
      'included',
      'Registered metadata only; connector content is not injected here'
    ))
    lines.push(
      '',
      `## ${resource.label?.trim() || resource.kind}`,
      `resourceId: ${resource.id}`,
      `resourceKind: ${resource.kind}`,
      `source: ${sanitizedExternalLocation(resource)}`,
      'availability: registered metadata only; use the authorized connector runtime to retrieve content and preserve source/version/retrievedAt evidence.'
    )
  }

  const hasIncluded = items.some((item) => item.decision === 'included')
  const prompt = hasIncluded ? lines.join('\n').slice(0, MAX_PROMPT_CHARS) : ''
  return {
    projectId: workspace.id,
    projectRevision: workspace.revision,
    projectPolicyDigest: projectResourcePolicyDigest(workspace),
    prompt,
    promptDigest: prompt ? `sha256:${createHash('sha256').update(prompt).digest('hex')}` : undefined,
    items
  }
}

export function discoverProjectKnowledgeSources(
  workspace: ProjectWorkspace,
  roots = resolveLocalResourceRoots(workspace)
): ProjectKnowledgeSource[] {
  const candidates = new Map<string, LocalResourceRoot>()
  for (const root of roots) {
    if (root.filePath) addCandidate(candidates, root.filePath, root)
    for (const name of ROOT_SOURCE_NAMES) addCandidate(candidates, join(root.rootPath, name), root)
    for (const directoryName of KNOWLEDGE_DIRECTORIES) {
      discoverDirectoryFiles(join(root.rootPath, directoryName), root, candidates)
    }
  }
  addRulesReference(workspace, roots, candidates)

  return [...candidates.entries()]
    .sort(([left], [right]) => sourcePriority(left) - sourcePriority(right) || left.localeCompare(right))
    .slice(0, MAX_DISCOVERED_FILES)
    .flatMap(([path, root]) => {
      const source = readKnowledgeSource(path, root)
      return source ? [source] : []
    })
}

function resolveLocalResourceRoots(workspace: ProjectWorkspace): LocalResourceRoot[] {
  const roots: LocalResourceRoot[] = []
  for (const resource of workspace.resources) {
    if (!projectResourceIsEnabled(resource) || !resource.path?.trim()) continue
    if (!['directory', 'repository', 'file_set', 'knowledge_base'].includes(resource.kind)) continue
    try {
      const requested = resolve(resource.path)
      const info = lstatSync(requested)
      if (info.isSymbolicLink()) continue
      const canonical = realpathSync(requested)
      if (info.isDirectory()) roots.push({ resource, rootPath: canonical })
      else if (info.isFile()) roots.push({ resource, rootPath: dirname(canonical), filePath: canonical })
    } catch {
      // Optional and stale Resources stay visible in Studio but are not injected.
    }
  }
  return roots
}

function discoverDirectoryFiles(
  directoryPath: string,
  root: LocalResourceRoot,
  candidates: Map<string, LocalResourceRoot>
): void {
  try {
    const canonicalDirectory = realpathSync(directoryPath)
    if (!pathWithinRoot(canonicalDirectory, root.rootPath) || lstatSync(directoryPath).isSymbolicLink()) return
    for (const entry of readdirSync(canonicalDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !isKnowledgeFileName(entry.name)) continue
      addCandidate(candidates, join(canonicalDirectory, entry.name), root)
      if (candidates.size >= MAX_DISCOVERED_FILES * 3) return
    }
  } catch {
    // A missing or unreadable conventional knowledge directory is expected.
  }
}

function addRulesReference(
  workspace: ProjectWorkspace,
  roots: LocalResourceRoot[],
  candidates: Map<string, LocalResourceRoot>
): void {
  const rulesRef = workspace.rulesRef?.trim()
  if (!rulesRef) return
  for (const root of roots) {
    const candidate = isAbsolute(rulesRef) ? resolve(rulesRef) : resolve(root.rootPath, rulesRef)
    if (!pathWithinRoot(candidate, root.rootPath)) continue
    addCandidate(candidates, candidate, root)
    return
  }
}

function addCandidate(
  candidates: Map<string, LocalResourceRoot>,
  requestedPath: string,
  root: LocalResourceRoot
): void {
  try {
    if (!isKnowledgeFileName(basename(requestedPath))) return
    const info = lstatSync(requestedPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SOURCE_BYTES) return
    const canonical = realpathSync(requestedPath)
    if (!pathWithinRoot(canonical, root.rootPath)) return
    candidates.set(canonical, root)
  } catch {
    // Discovery is best effort; authorization stays fail-closed.
  }
}

function readKnowledgeSource(path: string, root: LocalResourceRoot): ProjectKnowledgeSource | undefined {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SOURCE_BYTES) return undefined
    const canonical = realpathSync(path)
    if (!pathWithinRoot(canonical, root.rootPath)) return undefined
    const bytes = readFileSync(canonical)
    const content = bytes.toString('utf8').slice(0, MAX_SOURCE_CHARS)
    if (!content.trim()) return undefined
    return {
      resourceId: root.resource.id,
      resourceKind: root.resource.kind,
      path: canonical,
      digest: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      modifiedAt: info.mtimeMs,
      truncated: content.length < bytes.toString('utf8').length,
      content
    }
  } catch {
    return undefined
  }
}

function pathWithinRoot(candidate: string, root: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function isKnowledgeFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return extname(lower) === '.md' || extname(lower) === '.txt' || extname(lower) === '.rst'
}

export function projectResourceIsEnabled(resource: ProjectResource): boolean {
  return resource.metadata?.disabled !== true && resource.metadata?.revokedAt === undefined
}

export function projectResourceDataClass(resource: ProjectResource): OutboundDataClass {
  const value = resource.dataClass
  if (value === 'S0' || value === 'S1' || value === 'S2' || value === 'S3' || value === 'S4') return value
  return resource.kind === 'connector' || resource.kind === 'url' ? 'S1' : 'S2'
}

export function projectResourceEgressPolicy(resource: ProjectResource): ProjectResourceEgressPolicy {
  if (projectResourceDataClass(resource) === 'S3') return 'deny'
  const value = resource.egressPolicy
  return value === 'local_only' || value === 'deny' ? value : 'allow'
}

export function projectResourcePolicyDigest(workspace: ProjectWorkspace): string {
  const projection = [...workspace.resources]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((resource) => ({
      id: resource.id,
      enabled: projectResourceIsEnabled(resource),
      dataClass: projectResourceDataClass(resource),
      egressPolicy: projectResourceEgressPolicy(resource)
    }))
  return `sha256:${createHash('sha256').update(JSON.stringify({
    projectId: workspace.id,
    projectRevision: workspace.revision,
    projectStatus: workspace.status,
    resources: projection
  })).digest('hex')}`
}

function resourceContextItem(
  resource: ProjectResource,
  dataClass: OutboundDataClass,
  egressPolicy: ProjectResourceEgressPolicy,
  decision: OutboundContextItemView['decision'],
  reason: string
): OutboundContextItemView {
  return {
    id: `resource:${resource.id}`,
    kind: resource.kind === 'connector' || resource.kind === 'url'
      ? 'project_resource_metadata'
      : 'project_resource',
    label: resource.label?.trim() || resource.kind,
    dataClass,
    egressPolicy,
    decision,
    resourceId: resource.id,
    reason
  }
}

function sourcePriority(path: string): number {
  const name = basename(path).toLowerCase()
  const ruleIndex = ROOT_SOURCE_NAMES.findIndex((candidate) => candidate.toLowerCase() === name)
  return ruleIndex >= 0 ? ruleIndex : ROOT_SOURCE_NAMES.length
}

function sanitizedExternalLocation(resource: ProjectResource): string {
  if (!resource.uri) return resource.label?.trim() || resource.id
  try {
    const url = new URL(resource.uri)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return resource.label?.trim() || resource.id
  }
}
