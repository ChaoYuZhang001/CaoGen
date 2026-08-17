import type { ProjectFileEntry } from '../../../../shared/types'

export interface ProjectFileTreeNode extends ProjectFileEntry {
  children: ProjectFileTreeNode[]
}

export interface VisibleProjectFileNode {
  node: ProjectFileTreeNode
  depth: number
}

export type ProjectFileTreeNavigationKey = 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'End' | 'Home'

export function buildProjectFileTree(entries: ProjectFileEntry[]): ProjectFileTreeNode[] {
  const roots: ProjectFileTreeNode[] = []
  const byPath = new Map<string, ProjectFileTreeNode>()

  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean)
    let parentChildren = roots
    let currentPath = ''

    segments.forEach((segment, index) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      let node = byPath.get(currentPath)
      const isLeaf = index === segments.length - 1
      if (!node) {
        node = {
          path: currentPath,
          name: segment,
          kind: isLeaf ? entry.kind : 'directory',
          size: isLeaf ? entry.size : undefined,
          mtimeMs: isLeaf ? entry.mtimeMs : 0,
          children: []
        }
        byPath.set(currentPath, node)
        parentChildren.push(node)
      } else if (isLeaf) {
        node.name = entry.name
        node.kind = entry.kind
        node.size = entry.size
        node.mtimeMs = entry.mtimeMs
      }
      parentChildren = node.children
    })
  }

  sortTree(roots)
  return roots
}

export function filterProjectFileTree(
  nodes: ProjectFileTreeNode[],
  queryValue: string
): ProjectFileTreeNode[] {
  const query = queryValue.trim().toLocaleLowerCase()
  if (!query) return nodes
  return nodes.flatMap((node) => {
    const children = filterProjectFileTree(node.children, query)
    if (!node.path.toLocaleLowerCase().includes(query) && children.length === 0) return []
    return [{ ...node, children }]
  })
}

export function visibleProjectFileNodes(
  nodes: ProjectFileTreeNode[],
  expanded: ReadonlySet<string>,
  forceExpanded = false
): VisibleProjectFileNode[] {
  const visible: VisibleProjectFileNode[] = []
  const visit = (items: ProjectFileTreeNode[], depth: number): void => {
    for (const node of items) {
      visible.push({ node, depth })
      if (node.kind === 'directory' && (forceExpanded || expanded.has(node.path))) {
        visit(node.children, depth + 1)
      }
    }
  }
  visit(nodes, 0)
  return visible
}

export function nextProjectFileTreePath(
  items: VisibleProjectFileNode[],
  currentPath: string,
  key: ProjectFileTreeNavigationKey,
  expanded: ReadonlySet<string>
): string | null {
  if (items.length === 0) return null
  const currentIndex = items.findIndex((item) => item.node.path === currentPath)
  if (currentIndex < 0) return null
  const linearPath = linearTreePath(items, currentIndex, key)
  if (linearPath !== undefined) return linearPath
  const current = items[currentIndex]
  return key === 'ArrowRight'
    ? expandedChildPath(items, currentIndex, current, expanded)
    : parentTreePath(items, currentIndex, current, expanded)
}

function linearTreePath(
  items: VisibleProjectFileNode[],
  currentIndex: number,
  key: ProjectFileTreeNavigationKey
): string | null | undefined {
  if (key === 'Home') return items[0]?.node.path ?? null
  if (key === 'End') return items.at(-1)?.node.path ?? null
  if (key === 'ArrowDown') return items[Math.min(items.length - 1, currentIndex + 1)]?.node.path ?? null
  if (key === 'ArrowUp') return items[Math.max(0, currentIndex - 1)]?.node.path ?? null
  return undefined
}

function expandedChildPath(
  items: VisibleProjectFileNode[],
  currentIndex: number,
  current: VisibleProjectFileNode,
  expanded: ReadonlySet<string>
): string | null {
  if (current.node.kind !== 'directory' || !expanded.has(current.node.path)) return null
  const child = items[currentIndex + 1]
  return child && child.depth === current.depth + 1 ? child.node.path : null
}

function parentTreePath(
  items: VisibleProjectFileNode[],
  currentIndex: number,
  current: VisibleProjectFileNode,
  expanded: ReadonlySet<string>
): string | null {
  if (current.node.kind === 'directory' && expanded.has(current.node.path)) return null
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (items[index].depth < current.depth) return items[index].node.path
  }
  return null
}

function sortTree(nodes: ProjectFileTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  for (const node of nodes) sortTree(node.children)
}
