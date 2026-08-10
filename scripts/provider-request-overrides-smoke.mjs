#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-request-overrides-'))
const outDir = path.join(tempRoot, 'compiled')
const checks = []

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    'src/main/provider/providerRequestOverrides.ts'
  ], { cwd: repoRoot, stdio: 'inherit' })
  const api = await import(pathToFileURL(findCompiled(outDir, 'providerRequestOverrides.js')).href)
  const applied = api.applyProviderRequestOverrides({
    baseUrl: 'https://api.example.test/v1',
    advancedConfig: {
      schemaVersion: 1,
      request: {
        headers: { 'x-route': 'cn' },
        query: { region: 'us' },
        body: { temperature: 0.2, provider_options: { reasoning: { effort: 'low' } }, model: 'evil' }
      }
    }
  }, 'https://api.example.test/v1/chat/completions', {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    provider_options: { cache: true }
  }, { 'content-type': 'application/json' })
  equal(applied.url, 'https://api.example.test/v1/chat/completions?region=us', 'request query is appended same-origin')
  equal(applied.headers['x-route'], 'cn', 'request metadata header is applied')
  equal(applied.body.temperature, 0.2, 'request body scalar override is applied')
  equal(applied.body.provider_options.reasoning.effort, 'low', 'nested request body override is merged')
  equal(applied.body.model, 'gpt-test', 'protected model field cannot be replaced')
  equal(applied.body.messages[0].content, 'hello', 'protected messages field cannot be replaced')

  const responsesRuntime = api.applyProviderRequestOverrides({
    baseUrl: 'https://api.example.test/v1',
    advancedConfig: {
      schemaVersion: 1,
      runtime: {
        reasoningEffort: 'high', verbosity: 'low', maxOutputTokens: 2048,
        parallelToolCalls: true, storeResponses: false, serviceTier: 'priority'
      },
      request: { body: { temperature: 0.2, reasoning: { effort: 'low' } } }
    }
  }, 'https://api.example.test/v1/responses', {
    model: 'gpt-test', input: 'hello', reasoning: { summary: 'auto' }
  })
  equal(responsesRuntime.body.reasoning.effort, 'high', 'typed Responses reasoning wins over raw body overrides')
  equal(responsesRuntime.body.reasoning.summary, 'auto', 'typed Responses reasoning preserves engine fields')
  equal(responsesRuntime.body.text.verbosity, 'low', 'typed Responses verbosity uses the text envelope')
  equal(responsesRuntime.body.max_output_tokens, 2048, 'typed Responses output limit uses max_output_tokens')
  equal(responsesRuntime.body.parallel_tool_calls, true, 'typed parallel tool control is applied')
  equal(responsesRuntime.body.store, false, 'typed response storage control is applied')
  equal(responsesRuntime.body.service_tier, 'priority', 'typed service tier is applied')

  const chatRuntime = api.applyProviderRuntimeConfig({ model: 'gpt-test', messages: [] }, {
    reasoningEffort: 'medium', verbosity: 'high', maxOutputTokens: 512
  })
  equal(chatRuntime.reasoning_effort, 'medium', 'typed chat reasoning uses reasoning_effort')
  equal(chatRuntime.verbosity, 'high', 'typed chat verbosity uses the chat field')
  equal(chatRuntime.max_tokens, 512, 'typed chat output limit uses max_tokens')

  const foreign = api.appendProviderRequestQuery(
    'https://other.example.test/complete',
    'https://api.example.test/v1',
    { region: 'us' }
  )
  equal(foreign, 'https://other.example.test/complete', 'foreign-origin query target is left unchanged')
  console.log(`provider request overrides smoke ok: ${checks.length}/${checks.length} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, fileName) } catch { /* keep searching */ }
    } else if (entry.isFile() && entry.name === fileName) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}

function equal(actual, expected, message) {
  const pass = actual === expected
  checks.push({ name: message, status: pass ? 'pass' : 'fail' })
  if (!pass) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
