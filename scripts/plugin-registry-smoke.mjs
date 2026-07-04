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

  const badRoot = path.join(tempRoot, 'bad-json', '.claude')
  mkdirSync(badRoot, { recursive: true })
  writeFileSync(path.join(badRoot, '.mcp.json'), '{ bad json', 'utf8')
  const badView = pluginRegistry.scanPluginRegistry([badRoot])
  assert(
    badView.diagnostics.some((diag) => diag.code === 'json_parse_failed' && diag.path.endsWith('.mcp.json')),
    'bad MCP JSON should be reported as a diagnostic'
  )

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

  const limitedView = pluginRegistry.scanPluginRegistry([claudeRoot], { maxFiles: 1 })
  assert(limitedView.truncated, 'maxFiles should truncate the scan')
  assert(
    limitedView.diagnostics.some((diag) => diag.code === 'max_files_reached'),
    'maxFiles truncation should return a diagnostic'
  )

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

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) {
    throw new Error(message)
  }
}
