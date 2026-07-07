import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-plugin-slash-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/renderer/src/pluginSlashCommands.ts',
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const compiledModule = findCompiledModule(outDir)
  const slash = await import(pathToFileURL(compiledModule).href)
  assertEqual(typeof slash.buildPluginSlashCommands, 'function')
  assertEqual(typeof slash.pluginSlashCommandMatches, 'function')
  assertEqual(typeof slash.shouldLoadPluginSlashRegistry, 'function')

  const items = [
    item({ id: 'project-agent', name: 'Review Agent', kind: 'agent', sourceKind: 'project', summary: 'Reviews diffs.' }),
    item({ id: 'codex-skill', name: 'openai-docs', kind: 'skill', sourceKind: 'codex', summary: 'Official OpenAI docs.' }),
    item({ id: 'codex-plugin', name: 'browser', kind: 'plugin', sourceKind: 'codex', summary: 'Browser tools.' }),
    item({ id: 'disabled-mcp', name: 'linear', kind: 'mcp', sourceKind: 'user', summary: 'Issue tracker.', enabled: false })
  ]

  const commands = slash.buildPluginSlashCommands(items)
  assertEqual(commands.length, 3)
  assertEqual(commands[0].title, '/plugin browser')
  assertEqual(commands[1].title, '/skill openai-docs')
  assertEqual(commands[2].title, '/agent Review Agent')
  assertEqual(commands[1].action, 'use')
  assertEqual(commands[2].action, 'dispatch-agent')
  assert(commands.every((command) => command.hint.includes('·')), 'commands should include compact metadata hints')
  assert(!commands.some((command) => command.title.includes('linear')), 'disabled items should be hidden by default')
  assert(slash.pluginSlashCommandMatches(commands[1], 'openai'), 'search should match item names')
  assert(slash.pluginSlashCommandMatches(commands[1], 'official'), 'search should match summaries')
  assert(slash.pluginSlashCommandMatches(commands[0], 'codex'), 'search should match sources')
  assert(!slash.pluginSlashCommandMatches(commands[0], 'linear'), 'search should reject unrelated terms')

  const withDisabled = slash.buildPluginSlashCommands(items, { includeDisabled: true })
  assert(withDisabled.some((command) => command.title === '/mcp linear'), 'includeDisabled should expose disabled entries')
  assertEqual(slash.buildPluginSlashCommands(items, { maxItems: 1 }).length, 1)
  assertEqual(slash.shouldLoadPluginSlashRegistry(null), false)
  assertEqual(slash.shouldLoadPluginSlashRegistry(''), false)
  assertEqual(slash.shouldLoadPluginSlashRegistry('p'), false)
  assertEqual(slash.shouldLoadPluginSlashRegistry('pl'), true)

  console.log('pluginSlash smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function item(overrides) {
  return {
    id: overrides.id,
    name: overrides.name,
    kind: overrides.kind,
    sourceKind: overrides.sourceKind,
    sourceRoot: `/tmp/${overrides.sourceKind}`,
    path: `/tmp/${overrides.sourceKind}/${overrides.name}`,
    enabled: overrides.enabled ?? true,
    summary: overrides.summary
  }
}

function findCompiledModule(root) {
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath)
      if (found) return found
    } else if (entry.isFile() && entry.name === 'pluginSlashCommands.js') {
      return fullPath
    }
  }
  throw new Error(`compiled pluginSlashCommands.js not found under ${root}`)
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
