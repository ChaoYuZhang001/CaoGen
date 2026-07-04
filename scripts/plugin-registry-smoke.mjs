import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-plugin-registry-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  execFileSync(
    'npx',
    [
      'tsc',
      'src/main/pluginRegistry.ts',
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const compiledModule = findCompiledModule(outDir)
  const pluginRegistry = await import(pathToFileURL(compiledModule).href)
  assertEqual(typeof pluginRegistry.scanPluginRegistry, 'function')

  const emptyRoot = path.join(tempRoot, 'empty', '.claude')
  mkdirSync(path.join(emptyRoot, 'plugins'), { recursive: true })
  const emptyView = pluginRegistry.scanPluginRegistry([emptyRoot])
  assertEqual(emptyView.roots.length, 1)
  assertEqual(emptyView.items.length, 0)
  assertEqual(emptyView.diagnostics.length, 0)
  assertEqual(emptyView.truncated, false)
  assert(Number.isFinite(Date.parse(emptyView.scannedAt)), 'scan should include an ISO scannedAt timestamp')

  const missingRoot = path.join(tempRoot, 'missing', '.claude')
  const missingView = pluginRegistry.scanPluginRegistry([missingRoot])
  assertEqual(missingView.items.length, 0)
  assertDiagnostic(missingView, 'root_missing', missingRoot)

  const claudeRoot = path.join(tempRoot, 'happy', '.claude')
  mkdirSync(path.join(claudeRoot, 'skills', 'foo'), { recursive: true })
  mkdirSync(path.join(claudeRoot, 'agents'), { recursive: true })
  writeFileSync(
    path.join(claudeRoot, 'skills', 'foo', 'SKILL.md'),
    ['---', 'name: Foo Skill', 'description: Helps with foo workflows.', '---', '', '# Foo'].join('\n')
  )
  writeFileSync(
    path.join(claudeRoot, 'agents', 'bar.md'),
    ['---', 'name: Bar Agent', 'description: Handles bar tasks.', '---', '', '# Bar'].join('\n')
  )
  writeFileSync(
    path.join(claudeRoot, '.mcp.json'),
    JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['server.js'] } } }, null, 2)
  )

  const view = pluginRegistry.scanPluginRegistry([claudeRoot])
  assertItem(view, 'skill', 'Foo Skill')
  assertItem(view, 'agent', 'Bar Agent')
  const mcp = assertItem(view, 'mcp', 'demo')
  assertEqual(mcp.summary, 'command: node')
  assertEqual(view.diagnostics.length, 0)

  const pluginRoot = path.join(tempRoot, 'with-plugins', '.claude', 'plugins', 'demo-plugin')
  mkdirSync(path.join(pluginRoot, 'skills', 'plugin-skill'), { recursive: true })
  writeFileSync(
    path.join(pluginRoot, 'plugin.json'),
    JSON.stringify({ name: 'Demo Plugin', version: '1.0.0' }, null, 2)
  )
  writeFileSync(
    path.join(pluginRoot, 'skills', 'plugin-skill', 'SKILL.md'),
    ['---', 'name: Plugin Skill', 'description: Skill shipped by a plugin package.', '---', '', '# Plugin'].join('\n')
  )
  writeFileSync(
    path.join(pluginRoot, '.mcp.json'),
    JSON.stringify({ mcpServers: { pluginMcp: { url: 'http://127.0.0.1:4321/mcp' } } }, null, 2)
  )

  const pluginView = pluginRegistry.scanPluginRegistry([pluginRoot])
  const pluginSkill = assertItem(pluginView, 'skill', 'Plugin Skill')
  assert(pluginSkill.path.includes(path.join('.claude', 'plugins', 'demo-plugin', 'skills', 'plugin-skill')))
  assertEqual(pluginSkill.summary, 'Skill shipped by a plugin package.')
  const pluginMcp = assertItem(pluginView, 'mcp', 'pluginMcp')
  assertEqual(pluginMcp.summary, 'url: http://127.0.0.1:4321/mcp')
  assertEqual(pluginView.diagnostics.length, 0)

  const siblingRoot = path.join(tempRoot, 'sibling-project', '.claude')
  mkdirSync(siblingRoot, { recursive: true })
  writeFileSync(
    path.join(path.dirname(siblingRoot), '.mcp.json'),
    JSON.stringify({ mcpServers: { sibling: { transport: 'stdio' } } }, null, 2)
  )
  const siblingView = pluginRegistry.scanPluginRegistry([siblingRoot])
  const siblingMcp = assertItem(siblingView, 'mcp', 'sibling')
  assertEqual(siblingMcp.summary, 'transport: stdio')
  const noSiblingView = pluginRegistry.scanPluginRegistry([siblingRoot], { includeSiblingProjectMcp: false })
  assertNoItem(noSiblingView, 'mcp', 'sibling')

  const badRoot = path.join(tempRoot, 'bad-json', '.claude')
  mkdirSync(badRoot, { recursive: true })
  writeFileSync(path.join(badRoot, '.mcp.json'), '{ bad json', 'utf8')
  const badView = pluginRegistry.scanPluginRegistry([badRoot])
  assertDiagnostic(badView, 'json_parse_failed', '.mcp.json')

  const badShapeRoot = path.join(tempRoot, 'bad-shape', '.claude')
  mkdirSync(badShapeRoot, { recursive: true })
  writeFileSync(path.join(badShapeRoot, 'settings.json'), JSON.stringify({ mcpServers: [] }, null, 2))
  const badShapeView = pluginRegistry.scanPluginRegistry([badShapeRoot])
  assertDiagnostic(badShapeView, 'json_shape_invalid', 'settings.json')

  const oversizedRoot = path.join(tempRoot, 'oversized', '.claude')
  mkdirSync(path.join(oversizedRoot, 'skills', 'big'), { recursive: true })
  writeFileSync(path.join(oversizedRoot, 'skills', 'big', 'SKILL.md'), '# Big\n\nThis file is intentionally over the read limit.')
  const oversizedView = pluginRegistry.scanPluginRegistry([oversizedRoot], { maxReadBytes: 8 })
  assertNoItem(oversizedView, 'skill', 'big')
  assertDiagnostic(oversizedView, 'read_failed', path.join('skills', 'big', 'SKILL.md'))

  const constrainedRoot = path.join(tempRoot, 'constrained', '.claude')
  mkdirSync(path.join(constrainedRoot, 'skills', 'shallow'), { recursive: true })
  mkdirSync(path.join(constrainedRoot, 'skills', 'deep', 'one', 'two'), { recursive: true })
  mkdirSync(path.join(constrainedRoot, 'skills', 'node_modules', 'ignored'), { recursive: true })
  mkdirSync(path.join(constrainedRoot, 'agents', '.git'), { recursive: true })
  writeFileSync(path.join(constrainedRoot, 'skills', 'shallow', 'SKILL.md'), '# Shallow\n\nVisible skill.')
  writeFileSync(path.join(constrainedRoot, 'skills', 'deep', 'one', 'two', 'SKILL.md'), '# Too Deep\n')
  writeFileSync(path.join(constrainedRoot, 'skills', 'node_modules', 'ignored', 'SKILL.md'), '# Ignored\n')
  writeFileSync(path.join(constrainedRoot, 'agents', '.git', 'ignored.md'), '# Ignored Agent\n')
  writeFileSync(path.join(constrainedRoot, 'agents', 'direct.md'), '# Direct Agent\n\nVisible agent.')

  const constrainedView = pluginRegistry.scanPluginRegistry([constrainedRoot], { maxDepth: 1 })
  assertItem(constrainedView, 'skill', 'shallow')
  assertItem(constrainedView, 'agent', 'direct')
  assertNoItem(constrainedView, 'skill', 'two')
  assertNoItem(constrainedView, 'skill', 'ignored')
  assertNoItem(constrainedView, 'agent', 'ignored')
  assertEqual(constrainedView.limits.maxDepth, 1)
  assertEqual(constrainedView.truncated, false)

  const limitedView = pluginRegistry.scanPluginRegistry([claudeRoot], { maxFiles: 1 })
  assert(limitedView.truncated, 'maxFiles should truncate the scan')
  assertEqual(limitedView.limits.maxFiles, 1)
  assertDiagnostic(limitedView, 'max_files_reached')

  const normalizedLimitView = pluginRegistry.scanPluginRegistry([emptyRoot], { maxFiles: 0, maxDepth: 0 })
  assertEqual(normalizedLimitView.limits.maxFiles, 1)
  assertEqual(normalizedLimitView.limits.maxDepth, 1)

  console.log('pluginRegistry smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function findCompiledModule(root) {
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath)
      if (found) return found
    } else if (entry.isFile() && entry.name === 'pluginRegistry.js') {
      return fullPath
    }
  }
  throw new Error(`compiled pluginRegistry.js not found under ${root}`)
}

function assertItem(view, kind, name) {
  const item = view.items.find((candidate) => candidate.kind === kind && candidate.name === name)
  assert(item, `${kind} ${name} should be discovered`)
  assertEqual(item.enabled, true)
  assert(item.id, `${kind} ${name} should have an id`)
  assert(item.sourceRoot, `${kind} ${name} should have a sourceRoot`)
  assert(item.path, `${kind} ${name} should have a path`)
  return item
}

function assertNoItem(view, kind, name) {
  assert(
    !view.items.some((candidate) => candidate.kind === kind && candidate.name === name),
    `${kind} ${name} should not be discovered`
  )
}

function assertDiagnostic(view, code, pathSuffix) {
  assert(
    view.diagnostics.some((diag) => diag.code === code && (!pathSuffix || diag.path.endsWith(pathSuffix))),
    `${code} diagnostic${pathSuffix ? ` for ${pathSuffix}` : ''} should be reported`
  )
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) {
    throw new Error(message)
  }
}
