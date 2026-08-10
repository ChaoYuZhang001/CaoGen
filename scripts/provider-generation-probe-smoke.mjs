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
    equal(result.reasonCode, 'none', `${engine}/${protocol} has no failure reason`)
    equal(result.suggestedActions.length, 0, `${engine}/${protocol} has no recovery actions`)
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
  equal(missing.reasonCode, 'credentials_missing', 'missing credentials have a specific diagnosis')
  equal(missing.suggestedActions.join(','), 'enter_credentials', 'missing credentials direct the user to the key field')
  equal(missingCredentialFetches, 0, 'missing credentials do not send a generation request')

  const auth = await executeProviderGenerationProbe({
    baseUrl: 'https://example.invalid', engine: 'openai', openaiProtocol: 'chat', model: 'probe-model'
  }, {
    headers: { Authorization: 'Bearer redacted' }, headerNames: ['Authorization'], source: 'explicit', available: true
  }, async () => new Response('secret provider response', { status: 401 }))
  equal(auth.outcome, 'auth', '401 is classified as an authorization failure')
  equal(auth.status, 401, 'safe HTTP status is retained')
  equal(auth.reasonCode, 'base_url_or_credentials_mismatch', '401 does not overclaim that the key itself is invalid')
  equal(auth.suggestedActions.join(','), 'review_credentials,review_base_url_and_credentials,review_protocol', '401 offers key, URL, and protocol recovery')
  assert(!JSON.stringify(auth).includes('secret provider response'), '401 response body must not enter diagnostics')

  const statusCases = [
    [403, 'auth', 'base_url_or_credentials_mismatch'],
    [404, 'not_found', 'base_url_invalid'],
    [429, 'rate_limit', 'rate_limited'],
    [503, 'server', 'provider_unavailable'],
    [400, 'invalid_request', 'unknown']
  ]
  for (const [status, outcome, reasonCode] of statusCases) {
    const result = await executeProviderGenerationProbe({
      baseUrl: 'https://example.invalid/gateway/v1', engine: 'openai', openaiProtocol: 'chat', model: 'private-model'
    }, {
      headers: { Authorization: 'Bearer redacted' }, headerNames: ['Authorization'], source: 'explicit', available: true
    }, async () => new Response(null, { status }))
    equal(result.outcome, outcome, `${status} has a bounded outcome`)
    equal(result.reasonCode, reasonCode, `${status} has a bounded diagnosis`)
    equal(result.endpointPath, '/gateway/v1/chat/completions', `${status} shows the actual safe task path`)
    assert(!JSON.stringify(result).includes('private-model'), `${status} must not expose model identity`)
  }

  const network = await executeProviderGenerationProbe({
    baseUrl: 'https://example.invalid', engine: 'openai', openaiProtocol: 'responses', model: 'private-model'
  }, {
    headers: { Authorization: 'Bearer redacted' }, headerNames: ['Authorization'], source: 'explicit', available: true
  }, async () => { throw new Error('network detail must stay private') })
  equal(network.outcome, 'network', 'network failures have a bounded outcome')
  equal(network.reasonCode, 'network_unavailable', 'network failures have a bounded diagnosis')
  assert(!JSON.stringify(network).includes('network detail'), 'network error detail must not enter diagnostics')

  console.log(`provider generation probe smoke ok: ${cases.length + statusCases.length + 3} scenarios passed`)
} finally {
  rmSync(outputDir, { recursive: true, force: true })
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
