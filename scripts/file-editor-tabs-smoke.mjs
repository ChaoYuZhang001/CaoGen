import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-file-editor-tabs-'))
const outDir = path.join(tempRoot, 'compiled')
const checks = []

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/renderer/src/store/file-editor-tabs.ts',
    'src/renderer/src/components/workbench/project-file-tree.ts',
    'src/renderer/src/components/workbench/editor-language-actions.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
  const tabs = await import(pathToFileURL(findCompiled(outDir, 'file-editor-tabs.js')).href)
  const tree = await import(pathToFileURL(findCompiled(outDir, 'project-file-tree.js')).href)
  const language = await import(pathToFileURL(findCompiled(outDir, 'editor-language-actions.js')).href)
  let state = { fileTabs: [], activeFileTabBySession: {} }

  state = tabs.upsertFileTab(state, file('session-a', 'src/a.ts', 'const a = 1\n'))
  state = tabs.upsertFileTab(state, file('session-a', 'src/b.ts', 'const b = 1\n'))
  state = tabs.upsertFileTab(state, file('session-b', 'src/a.ts', 'const other = 1\n'))
  equal(tabs.tabsForSession(state, 'session-a').length, 2, 'tabs are grouped by Session')
  equal(tabs.tabsForSession(state, 'session-b').length, 1, 'same path in another Session is isolated')
  equal(tabs.activeFileTab(state, 'session-a').path, 'src/b.ts', 'newly opened tab becomes active')

  state = tabs.updateFileTabDraft(state, 'session-a', 'src/a.ts', 'const a = 2\n')
  state = tabs.selectFileTab(state, 'session-a', 'src/a.ts')
  equal(tabs.activeFileTab(state, 'session-a').content, 'const a = 2\n', 'switching tabs preserves unsaved content')
  equal(tabs.activeFileTab(state, 'session-a').savedContent, 'const a = 1\n', 'draft does not mutate saved baseline')

  state = tabs.markFileTabSaved(state, 'session-a', 'src/a.ts', 'const a = 2\n', 12, 42)
  equal(tabs.activeFileTab(state, 'session-a').savedContent, 'const a = 2\n', 'save advances only the saved baseline')
  equal(tabs.activeFileTab(state, 'session-a').mtimeMs, 42, 'save records the returned file identity')

  state = tabs.updateFileTabDraft(state, 'session-a', 'src/a.ts', 'const a = 3\n')
  state = tabs.markFileTabSaved(state, 'session-a', 'src/a.ts', 'const a = 2\n', 12, 43)
  equal(tabs.activeFileTab(state, 'session-a').content, 'const a = 3\n', 'save completion does not erase newer typing')
  equal(tabs.activeFileTab(state, 'session-a').savedContent, 'const a = 2\n', 'in-flight save keeps its exact snapshot')

  state = tabs.cycleFileTabState(state, 'session-a', 1)
  equal(tabs.activeFileTab(state, 'session-a').path, 'src/b.ts', 'tab cycling moves forward')
  state = tabs.cycleFileTabState(state, 'session-a', 1)
  equal(tabs.activeFileTab(state, 'session-a').path, 'src/a.ts', 'tab cycling wraps')

  state = tabs.closeFileTabState(state, 'session-a', 'src/a.ts')
  equal(tabs.activeFileTab(state, 'session-a').path, 'src/b.ts', 'closing the active tab selects its neighbor')
  equal(tabs.activeFileTab(state, 'session-b').content, 'const other = 1\n', 'closing one Session leaves another untouched')
  state = tabs.closeFileTabState(state, 'session-a', 'src/b.ts')
  equal(tabs.activeFileTab(state, 'session-a'), undefined, 'closing the last tab clears active selection')

  const projectTree = tree.buildProjectFileTree([
    entry('README.md', 'file'),
    entry('src', 'directory'),
    entry('src/components', 'directory'),
    entry('src/components/App.tsx', 'file'),
    entry('src/index.ts', 'file'),
    entry('tests', 'directory'),
    entry('tests/app.test.ts', 'file')
  ])
  equal(projectTree.map((node) => node.path).join(','), 'src,tests,README.md', 'tree sorts directories before files')
  equal(projectTree[0].children[0].path, 'src/components', 'tree nests child directories')
  equal(projectTree[0].children[0].children[0].path, 'src/components/App.tsx', 'tree nests files at the correct depth')
  equal(tree.visibleProjectFileNodes(projectTree, new Set()).length, 3, 'collapsed tree only shows roots')
  const expandedPaths = new Set(['src', 'src/components'])
  const expandedTree = tree.visibleProjectFileNodes(projectTree, expandedPaths)
  equal(expandedTree.length, 6, 'expanded tree shows descendants')
  equal(tree.nextProjectFileTreePath(expandedTree, 'src', 'ArrowRight', expandedPaths), 'src/components', 'ArrowRight enters the first expanded child')
  equal(tree.nextProjectFileTreePath(expandedTree, 'src/components/App.tsx', 'ArrowLeft', expandedPaths), 'src/components', 'ArrowLeft returns from a file to its parent')
  equal(tree.nextProjectFileTreePath(expandedTree, 'src/components', 'ArrowLeft', expandedPaths), null, 'ArrowLeft leaves an expanded directory for the caller to collapse')
  equal(tree.nextProjectFileTreePath(expandedTree, 'src', 'End', expandedPaths), 'README.md', 'End focuses the final visible tree item')
  equal(tree.nextProjectFileTreePath(expandedTree, 'README.md', 'Home', expandedPaths), 'src', 'Home focuses the first visible tree item')
  const filteredTree = tree.filterProjectFileTree(projectTree, 'app.tsx')
  equal(filteredTree.length, 1, 'filter keeps only matching ancestry')
  equal(tree.visibleProjectFileNodes(filteredTree, new Set(), true).map((item) => item.node.path).join(','), 'src,src/components,src/components/App.tsx', 'filtered tree reveals matching ancestry')

  const symbolText = 'const selected = searchTar\n'
  const word = language.editorWordRange(symbolText, symbolText.indexOf('searchTar') + 'searchTar'.length)
  equal(word.word, 'searchTar', 'language action identifies the symbol at the caret')
  const completed = language.replaceEditorWord(symbolText, word, 'searchTarget')
  equal(completed.content, 'const selected = searchTarget\n', 'completion replaces only the current symbol')
  equal(completed.caret, completed.content.indexOf('searchTarget') + 'searchTarget'.length, 'completion advances the caret')
  equal(language.editorOffsetForLocation('first\nsecond\n', 2, 3), 8, 'definition location maps to an editor offset')
  equal(JSON.stringify(language.editorLocationForOffset('first\nsecond\n', 8)), JSON.stringify({ line: 2, column: 3 }), 'editor offset maps to a one-based LSP location')

  const storeSource = readFileSync(path.join(repoRoot, 'src/renderer/src/store.ts'), 'utf8')
  const panelSource = readFileSync(
    path.join(repoRoot, 'src/renderer/src/components/workbench/FilePanel.tsx'),
    'utf8'
  )
  const treePanelSource = readFileSync(
    path.join(repoRoot, 'src/renderer/src/components/workbench/file-panel-tree.tsx'),
    'utf8'
  )
  check('file reads reject stale Session or request results',
    storeSource.includes('requestId !== fileRequestSeq || s.activeId !== id'))
  check('file tabs expose keyboard save, close, and cycling',
    panelSource.includes("event.key === 'Tab'") && panelSource.includes("event.key.toLowerCase() === 's'") &&
      panelSource.includes("event.key.toLowerCase() === 'w'"))
  check('file tree exposes roving treeitem focus and directional navigation',
    treePanelSource.includes('role="treeitem"') && treePanelSource.includes('data-file-tree-path') &&
      treePanelSource.includes('nextProjectFileTreePath') && treePanelSource.includes("event.key === 'Enter'") &&
      panelSource.includes('handleFileTreeKeyDown') && panelSource.includes('focusedTreePath'))
  check('dirty tab close is guarded by an explicit confirmation',
    panelSource.includes("window.confirm(t('closeDirtyFileConfirm'"))
  check('TypeScript actions prefer semantic IPC with project-index fallback',
    panelSource.includes('getTypeScriptCompletions') && panelSource.includes('getTypeScriptDefinitions') &&
      panelSource.includes('searchProjectSymbols') && panelSource.includes('resolveProjectDefinition'))
  check('Problems merge semantic diagnostics without replacing the syntax fallback',
    panelSource.includes('getTypeScriptDiagnostics') && panelSource.includes('mergedDiagnostics(fileDiagnostics, semanticDiagnostics)'))

  console.log(`file editor tabs smoke ok: ${checks.length}/${checks.length}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function file(sessionId, filePath, content) {
  return { sessionId, path: filePath, content, savedContent: content, bytes: content.length, mtimeMs: 1 }
}

function entry(filePath, kind) {
  return { path: filePath, name: path.basename(filePath), kind, size: kind === 'file' ? 10 : undefined, mtimeMs: 1 }
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, fileName) } catch { /* continue */ }
    } else if (entry.name === fileName && existsSync(full)) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  checks.push(message)
}

function check(message, condition) {
  assert.equal(Boolean(condition), true, message)
  checks.push(message)
}
