#!/usr/bin/env node
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const outputDir = mkdtempSync(path.join(tmpdir(), 'caogen-generation-probe-'))
const bundle = path.join(outputDir, 'generation-probe.cjs')

try {
  esbuild.buildSync({
    entryPoints: ['src/main/provider/generationProbe.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22'
  })
  const { executeProviderGenerationProbe } = require(bundle)
  const cases = [
    ['openai', 'responses', '/v1/responses', 'https://example.invalid/v1/responses', 'max_output_tokens'],
    ['openai', 'chat', '/v1/chat/completions', 'https://example.invalid/v1/chat/completions', 'max_tokens'],
    ['anthropic', 'responses', '/v1/messages', 'https://example.invalid/v1/messages', 'max_tokens'],
    ['gemini', 'responses', '/v1beta/models/{model}:generateContent', 'https://example.invalid/v1beta/models/probe-model:generateContent', 'generationConfig']
  ]

  for (const [engine, protocol, publicPath, expectedUrl, limitField] of cases) {
    let request
    let cancelled = false
    const fetchImpl = async (url, options) => {
      request = { url, options }
      return new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 200 })
    }
    const result = await executeProviderGenerationProbe({
      baseUrl: engine === 'gemini' ? 'https://example.invalid/v1beta' : 'https://example.invalid',
      engine,
      openaiProtocol: protocol,
      model: 'probe-model'
    }, {
      headers: { Authorization: 'Bearer secret-value' },
      headerNames: ['Authorization'],
      source: 'explicit',
      available: true
    }, fetchImpl)
    const body = JSON.parse(request.options.body)
    equal(request.url, expectedUrl, `${engine}/${protocol} uses the task endpoint`)
    equal(result.endpointPath, publicPath, `${engine}/${protocol} returns only a redacted path`)
    equal(result.outcome, 'success', `${engine}/${protocol} classifies 2xx as success`)
    equal(cancelled, true, `${engine}/${protocol} cancels without reading the response body`)
    assert(body[limitField] === 1 || body[limitField]?.maxOutputTokens === 1, `${engine}/${protocol} caps output to one token`)
    const serialized = JSON.stringify(result)
    assert(!serialized.includes('example.invalid'), 'result must not expose Provider origin')
    assert(!serialized.includes('secret-value'), 'result must not expose credentials')
    assert(!serialized.includes('probe-model'), 'result must redact the model from endpoint paths')
  }

  let missingCredentialFetches = 0
  const missing = await executeProviderGenerationProbe({
    baseUrl: 'https://example.invalid', engine: 'openai', openaiProtocol: 'chat', model: 'probe-model'
  }, {
    headers: {}, headerNames: ['Authorization'], source: 'none', available: false
  }, async () => {
    missingCredentialFetches += 1
    return new Response(null, { status: 200 })
  })
  equal(missing.outcome, 'auth', 'missing credentials are classified before network access')
  equal(missingCredentialFetches, 0, 'missing credentials do not send a generation request')

  const auth = await executeProviderGenerationProbe({
    baseUrl: 'https://example.invalid', engine: 'openai', openaiProtocol: 'chat', model: 'probe-model'
  }, {
    headers: { Authorization: 'Bearer redacted' }, headerNames: ['Authorization'], source: 'explicit', available: true
  }, async () => new Response(null, { status: 401 }))
  equal(auth.outcome, 'auth', '401 is classified as an authorization failure')
  equal(auth.status, 401, 'safe HTTP status is retained')

  console.log(`provider generation probe smoke ok: ${cases.length + 2} scenarios passed`)
} finally {
  rmSync(outputDir, { recursive: true, force: true })
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
