#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const dependencyRoot = findDependencyRoot(repoRoot)
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'caogen-search-registration-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  mkdirSync(outDir, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(dependencyRoot, 'typescript', 'bin', 'tsc'),
      'src/main/openaiTools.ts',
      'src/main/anthropicEngine.ts',
      '--outDir', outDir,
      '--rootDir', 'src',
      '--target', 'ES2022',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--types', 'node',
      '--typeRoots', path.join(dependencyRoot, '@types'),
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
  process.env.NODE_PATH = dependencyRoot
  Module._initPaths()
  const outputRequire = createRequire(path.join(outDir, 'main', 'openaiTools.js'))
  const tools = outputRequire(path.join(outDir, 'main', 'openaiTools.js'))
  const anthropicTools = outputRequire(path.join(outDir, 'main', 'anthropicEngine.js'))
  const names = tools.OPENAI_CODING_TOOLS.map((tool) => tool.function.name)
  const searchCount = names.filter((name) => name === 'web_search').length
  assert.equal(searchCount, 1, 'OpenAI registry must contain exactly one web_search schema')

  const searchTool = tools.OPENAI_CODING_TOOLS.find((tool) => tool.function.name === 'web_search')
  assert(searchTool, 'web_search must be present in the OpenAI registry')
  assert.deepEqual(searchTool.function.parameters.properties.mode.enum, ['model_native', 'byok_search_adapter'])
  assert.deepEqual(searchTool.function.parameters.required, ['query'])

  const responses = tools.RESPONSES_CODING_TOOLS.filter((tool) => tool.name === 'web_search')
  assert.equal(responses.length, 1, 'Responses registry must contain exactly one web_search schema')
  assert.deepEqual(responses[0].parameters, searchTool.function.parameters)

  const anthropic = anthropicTools.ANTHROPIC_CODING_TOOLS.filter((tool) => tool.name === 'web_search')
  assert.equal(anthropic.length, 1, 'Anthropic registry must contain exactly one web_search schema')
  assert.deepEqual(anthropic[0].input_schema, searchTool.function.parameters)

  const anthropicSource = readFileSync(path.join(repoRoot, 'src/main/anthropicEngine.ts'), 'utf8')
  assert.match(anthropicSource, /ANTHROPIC_CODING_TOOLS[\s\S]*OPENAI_CODING_TOOLS\.map/)
  assert.doesNotMatch(anthropicSource, /name:\s*['"]web_search['"]/, 'Anthropic must not maintain a second web_search schema')
  const p2Source = readFileSync(path.join(repoRoot, 'src/main/agent/tools/p2-tools.ts'), 'utf8')
  assert.equal(count(p2Source, "name: 'web_search'"), 1, 'P2_TOOLS must own the only web_search schema')
  assert.equal(count(p2Source, "if (name === 'web_search') return executeWebSearch(args, context)"), 1, 'P2 dispatch must have one web_search route')
  const openaiSource = readFileSync(path.join(repoRoot, 'src/main/openaiTools.ts'), 'utf8')
  assert.equal(count(openaiSource, 'if (isP2ToolName(name))'), 1, 'OpenAI dispatch must have one P2 delegation path')
  assert.equal(count(openaiSource, "case 'web_search'"), 0, 'OpenAI direct switch must not duplicate web_search')

  const permissions = readFileSync(path.join(repoRoot, 'src/main/task/tool-idempotency.ts'), 'utf8')
  assert.match(permissions, /'web_search'/, 'web_search must be classified in the permission/idempotency policy')
  const effects = readFileSync(path.join(repoRoot, 'src/main/task/effect-entry-inventory.ts'), 'utf8')
  assert.match(effects, /'web_search'/, 'web_search must be classified in the Effect inventory')
  const prompt = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
  assert.match(prompt, /web_search/, 'OpenAI system prompt must disclose web_search')

  console.log(JSON.stringify({
    status: 'passed',
    dependencyRoot,
    registrations: { openai: searchTool.function.name, responses: responses[0].name, anthropic: anthropic[0].name },
    dispatch: 'P2_TOOLS -> executeP2Tool -> executeWebSearch'
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function count(text, needle) {
  return text.split(needle).length - 1
}

function findDependencyRoot(root) {
  const candidates = [path.join(root, 'node_modules'), '/Users/apple/agent-desk/node_modules']
  const usable = candidates.find((candidate) =>
    existsSync(path.join(candidate, 'typescript', 'bin', 'tsc')) &&
    existsSync(path.join(candidate, '@types', 'node')) &&
    existsSync(path.join(candidate, 'electron', 'dist'))
  )
  if (usable) return usable
  const fallback = candidates.find((candidate) => existsSync(path.join(candidate, 'typescript', 'bin', 'tsc')))
  if (fallback) return fallback
  throw new Error('No usable TypeScript dependency root found')
}
