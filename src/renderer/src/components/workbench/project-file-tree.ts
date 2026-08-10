import type { ProjectFileEntry } from '../../../../shared/types'

export interface ProjectFileTreeNode extends ProjectFileEntry {
  children: ProjectFileTreeNode[]
}

export interface VisibleProjectFileNode {
  node: ProjectFileTreeNode
  depth: number
}

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

function sortTree(nodes: ProjectFileTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  for (const node of nodes) sortTree(node.children)
}
