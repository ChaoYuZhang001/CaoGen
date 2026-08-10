const fs = require('node:fs')
const crypto = require('node:crypto')
const http = require('node:http')
const path = require('node:path')
const { app, BrowserWindow, clipboard, ipcMain } = require('electron')
const {
  runGeminiGatewayFailoverChecks,
  runOpenAiGatewayFailoverChecks
} = require('./lib/provider-gateway-failover-checks.cjs')

const repoRoot = path.resolve(__dirname, '..')
const userDataDir = requiredEnv('CAOGEN_PROVIDER_GATEWAY_USER_DATA')
const statePath = requiredEnv('CAOGEN_PROVIDER_GATEWAY_STATE')
const screenshotPath = requiredEnv('CAOGEN_PROVIDER_GATEWAY_SCREENSHOT')
process.env.CAOGEN_USER_DATA_DIR = userDataDir

const checks = []
const upstreamRequests = []
const secretCanary = ['gateway', 'client', 'secret', 'canary'].join('-')
const openAiProviderTokenA = `openai_a_${crypto.randomBytes(24).toString('base64url')}`
const openAiProviderTokenB = `openai_b_${crypto.randomBytes(24).toString('base64url')}`
const googleProviderToken = `google_${crypto.randomBytes(24).toString('base64url')}`
const googleProviderTokenB = `google_b_${crypto.randomBytes(24).toString('base64url')}`

async function run() {
  const upstream = await startUpstream()
  require(path.join(repoRoot, 'out', 'main', 'index.js'))
  await waitFor(() => ipcMain._invokeHandlers?.has('providers:gateway:update'), 12_000)
  const upstreamPort = upstream.address().port
  const providerA = await invoke('providers:create', {
    name: 'Gateway Alpha',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    models: ['gateway-chat', 'shared-model'],
    engine: 'openai',
    authMode: 'none',
    openaiProtocol: 'chat'
  })
  check('isolated Provider is ready', providerA.ready === true)
  const googleProviderA = await invoke('providers:create', {
    name: 'Gateway Gemini Alpha',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1beta`,
    models: ['gemini-gateway', 'shared-gemini'],
    engine: 'gemini',
    authMode: 'api-key',
    token: googleProviderToken,
    tokenLabel: 'gateway-gemini-test',
    advancedConfig: {
      schemaVersion: 1,
      modelProfiles: [{
        model: 'gemini-gateway',
        pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, source: 'user' }
      }]
    }
  })
  check('isolated Gemini Provider is ready', googleProviderA.ready === true
    && googleProviderA.credentialHeaderNames?.includes('x-goog-api-key'))

  const firstPort = await freePort()
  const running = await invoke('providers:gateway:update', { enabled: true, port: firstPort })
  check('gateway starts on the exact loopback port', running.state === 'running'
    && running.host === '127.0.0.1' && running.port === firstPort
    && running.baseUrl.endsWith(`:${firstPort}/v1`)
    && running.googleBaseUrl.endsWith(`:${firstPort}/v1beta`))
  check('gateway token is available without entering renderer state', running.tokenConfigured === true)
  await invoke('providers:gateway:copy-token')
  let gatewayToken = await waitFor(() => {
    const value = clipboard.readText()
    return /^cg_[A-Za-z0-9_-]{40,}$/.test(value) ? value : undefined
  }, 2_000)
  check('gateway token copy returns a bounded credential', /^cg_[A-Za-z0-9_-]{40,}$/.test(gatewayToken))

  const health = await requestJson(firstPort, '/health')
  check('health endpoint is loopback-readable', health.status === 200 && health.body.status === 'ok')
  const deniedModels = await requestJson(firstPort, '/v1/models')
  check('model catalog rejects missing gateway auth', deniedModels.status === 401)
  const models = await requestJson(firstPort, '/v1/models', { token: gatewayToken })
  check('authenticated model catalog exposes ready Provider models', models.status === 200
    && models.body.data.some((model) => model.id === 'gateway-chat')
    && !models.body.data.some((model) => model.id === 'gemini-gateway'))

  const chat = await requestJson(firstPort, '/v1/chat/completions', {
    token: gatewayToken,
    body: { model: 'gateway-chat', messages: [{ role: 'user', content: 'hello' }] }
  })
  check('chat completion is proxied without response translation', chat.status === 200
    && chat.body.choices[0].message.content === 'gateway-ok')
  check('client gateway credential is never forwarded upstream', upstreamRequests.length === 1
    && upstreamRequests[0].authorization === '' && !upstreamRequests[0].raw.includes(secretCanary))

  const streamed = await requestText(firstPort, '/v1/chat/completions', {
    token: gatewayToken,
    body: { model: 'gateway-chat', stream: true, messages: [{ role: 'user', content: 'stream' }] }
  })
  check('SSE response streams through with terminal marker', streamed.status === 200
    && streamed.text.includes('gateway-stream') && streamed.text.includes('[DONE]'))

  const responses = await requestJson(firstPort, '/v1/responses', {
    token: gatewayToken,
    body: { model: 'gateway-chat', input: 'response request' }
  })
  check('Responses endpoint routes independently', responses.status === 200
    && responses.body.output[0].content[0].text === 'gateway-response')

  const deniedAnthropic = await requestJson(firstPort, '/v1/messages', {
    body: { model: 'gateway-chat', max_tokens: 16, messages: [{ role: 'user', content: 'denied' }] }
  })
  check('Anthropic endpoint returns a native authentication error envelope', deniedAnthropic.status === 401
    && deniedAnthropic.body.type === 'error'
    && deniedAnthropic.body.error.type === 'authentication_error'
    && upstreamRequests.length === 3)

  const anthropicBasic = await requestJson(firstPort, '/v1/messages', {
    apiKey: gatewayToken,
    body: {
      model: 'gateway-chat',
      max_tokens: 128,
      system: [{ type: 'text', text: 'Gateway system' }],
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'anthropic-basic' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
      ] }],
      stop_sequences: ['STOP'],
      tools: [{ name: 'read_file', description: 'Read one file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      tool_choice: { type: 'auto' }
    }
  })
  const anthropicBasicUpstream = upstreamRequests.at(-1)
  check('Anthropic Messages request converts system, tools and limits to OpenAI Chat', anthropicBasic.status === 200
    && anthropicBasic.body.type === 'message'
    && anthropicBasic.body.content[0].text === 'gateway-ok'
    && anthropicBasic.body.usage.input_tokens === 4
    && anthropicBasicUpstream.body.max_tokens === 128
    && anthropicBasicUpstream.body.messages[0].role === 'system'
    && anthropicBasicUpstream.body.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,')
    && anthropicBasicUpstream.body.tools[0].type === 'function'
    && anthropicBasicUpstream.body.stop[0] === 'STOP')
  check('Anthropic x-api-key authenticates without forwarding the gateway credential', anthropicBasicUpstream.authorization === ''
    && anthropicBasicUpstream.apiKey === '' && !anthropicBasicUpstream.raw.includes(gatewayToken))

  const anthropicTool = await requestJson(firstPort, '/v1/messages', {
    token: gatewayToken,
    body: {
      model: 'gateway-chat',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'anthropic-tool-request' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]
    }
  })
  check('OpenAI function call converts to Anthropic tool_use', anthropicTool.status === 200
    && anthropicTool.body.stop_reason === 'tool_use'
    && anthropicTool.body.content.some((block) => block.type === 'tool_use'
      && block.id === 'call_gateway' && block.name === 'read_file' && block.input.path === 'README.md'))

  const anthropicToolResult = await requestJson(firstPort, '/v1/messages', {
    token: gatewayToken,
    body: {
      model: 'gateway-chat',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'start-tool-result' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_gateway', name: 'read_file', input: { path: 'README.md' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_gateway', content: [{ type: 'text', text: 'tool-result-ok' }] }] }
      ]
    }
  })
  const anthropicToolResultUpstream = upstreamRequests.at(-1)
  check('Anthropic tool_use and tool_result convert back to OpenAI tool messages', anthropicToolResult.status === 200
    && anthropicToolResultUpstream.body.messages.some((message) => message.role === 'assistant'
      && message.tool_calls?.[0]?.function?.name === 'read_file')
    && anthropicToolResultUpstream.body.messages.some((message) => message.role === 'tool'
      && message.tool_call_id === 'call_gateway' && message.content === 'tool-result-ok'))

  const anthropicStream = await requestText(firstPort, '/v1/messages', {
    token: gatewayToken,
    body: {
      model: 'gateway-chat',
      max_tokens: 96,
      stream: true,
      messages: [{ role: 'user', content: 'anthropic-stream' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }]
    }
  })
  check('OpenAI SSE converts to ordered Anthropic text and tool events', anthropicStream.status === 200
    && anthropicStream.text.indexOf('event: message_start') < anthropicStream.text.indexOf('event: content_block_start')
    && anthropicStream.text.includes('"type":"text_delta","text":"gateway-stream"')
    && anthropicStream.text.includes('"type":"tool_use","id":"call_stream","name":"read_file"')
    && anthropicStream.text.includes('"partial_json":"{\\"path\\":\\"README.md\\"}"')
    && anthropicStream.text.includes('"stop_reason":"tool_use"')
    && anthropicStream.text.trim().endsWith('{"type":"message_stop"}'))

  const anthropicUpstreamError = await requestJson(firstPort, '/v1/messages', {
    token: gatewayToken,
    body: { model: 'gateway-chat', max_tokens: 64, messages: [{ role: 'user', content: 'anthropic-upstream-error' }] }
  })
  check('upstream errors use a bounded Anthropic envelope without Provider response leakage', anthropicUpstreamError.status === 429
    && anthropicUpstreamError.body.type === 'error'
    && anthropicUpstreamError.body.error.type === 'rate_limit_error'
    && !JSON.stringify(anthropicUpstreamError.body).includes(secretCanary))

  const beforeUnsupported = upstreamRequests.length
  const unsupportedAnthropic = await requestJson(firstPort, '/v1/messages', {
    token: gatewayToken,
    body: {
      model: 'gateway-chat',
      max_tokens: 64,
      thinking: { type: 'enabled', budget_tokens: 32 },
      messages: [{ role: 'user', content: 'must-fail-closed' }]
    }
  })
  check('unsupported Anthropic semantics fail before Provider egress', unsupportedAnthropic.status === 400
    && unsupportedAnthropic.body.type === 'error'
    && unsupportedAnthropic.body.error.type === 'invalid_request_error'
    && upstreamRequests.length === beforeUnsupported)

  await waitFor(async () => {
    const usage = await invoke('providers:usage', { source: 'gateway.openai.chat-completions' })
    return usage.requests >= 2 && usage.inputTokens >= 15 && usage.outputTokens >= 7
      && usage.cacheReadTokens >= 3
  }, 5_000)
  const usage = await invoke('providers:usage', { providerId: providerA.id })
  const anthropicUsage = await invoke('providers:usage', { source: 'gateway.anthropic.messages' })
  check('gateway requests enter Provider usage and pricing pipeline', usage.nativeRequests >= 8
    && usage.sources.includes('gateway.openai.chat-completions')
    && usage.sources.includes('gateway.openai.responses')
    && usage.sources.includes('gateway.anthropic.messages')
    && anthropicUsage.requests >= 5 && anthropicUsage.inputTokens >= 20 && anthropicUsage.outputTokens >= 10)

  const oversized = await requestJson(firstPort, '/v1/chat/completions', {
    token: gatewayToken,
    bodyText: JSON.stringify({ model: 'gateway-chat', input: 'x'.repeat(2 * 1024 * 1024) })
  })
  check('oversized requests fail before Provider egress', oversized.status === 413 && upstreamRequests.length === 8)

  const providerB = await invoke('providers:create', {
    name: 'Gateway Beta',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    models: ['shared-model'],
    engine: 'openai',
    authMode: 'none',
    openaiProtocol: 'chat'
  })
  const ambiguous = await requestJson(firstPort, '/v1/chat/completions', {
    token: gatewayToken,
    body: { model: 'shared-model', messages: [] }
  })
  check('ambiguous plain model fails closed', ambiguous.status === 409 && upstreamRequests.length === 8)
  const explicit = await requestJson(firstPort, '/v1/chat/completions', {
    token: gatewayToken,
    body: { model: `${providerB.id}/shared-model`, messages: [] }
  })
  check('provider-id/model selects one exact Provider', explicit.status === 200 && upstreamRequests.length === 9)
  const duplicateModels = await requestJson(firstPort, '/v1/models', { token: gatewayToken })
  const sharedIds = duplicateModels.body.data.filter((model) => model.id.endsWith('/shared-model')).map((model) => model.id)
  check('ambiguous catalog IDs are namespaced', sharedIds.length === 2
    && sharedIds.some((id) => id.startsWith(providerA.id)) && sharedIds.some((id) => id.startsWith(providerB.id)))

  await runOpenAiGatewayFailoverChecks({
    invoke, requestJson, requestText, check, firstPort, gatewayToken, providerA, providerB,
    upstreamRequests, openAiProviderTokenA, openAiProviderTokenB, readGatewayUsage
  })

  const deniedGoogleModels = await requestJson(firstPort, '/v1beta/models')
  check('Google model catalog returns a native authentication error', deniedGoogleModels.status === 401
    && deniedGoogleModels.body.error.code === 401
    && deniedGoogleModels.body.error.status === 'UNAUTHENTICATED')
  const googleModels = await requestJson(firstPort, '/v1beta/models', { googleApiKey: gatewayToken })
  check('Google model catalog exposes only ready Gemini models', googleModels.status === 200
    && googleModels.body.models.some((model) => model.name === 'models/gemini-gateway')
    && !googleModels.body.models.some((model) => model.name === 'models/gateway-chat'))

  const googleBody = {
    systemInstruction: { parts: [{ text: 'Gateway system' }] },
    contents: [
      { role: 'user', parts: [{ text: 'google-native' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'README.md' } }, thoughtSignature: 'signed-call' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { result: 'ok' } }, thoughtSignature: 'signed-call' }] }
    ],
    tools: [{ functionDeclarations: [{ name: 'read_file', parameters: { type: 'OBJECT' } }] }]
  }
  const googleJson = await requestJson(firstPort, '/v1beta/models/gemini-gateway:generateContent', {
    googleApiKey: gatewayToken,
    body: googleBody
  })
  const googleJsonUpstream = upstreamRequests.at(-1)
  check('native Google JSON preserves multimodal and signed tool bodies', googleJson.status === 200
    && googleJson.body.candidates[0].content.parts[0].functionCall.name === 'read_file'
    && googleJson.body.candidates[0].content.parts[0].thoughtSignature === 'gateway-thought-signature'
    && googleJsonUpstream.body.contents[0].parts[1].inlineData.mimeType === 'image/png'
    && googleJsonUpstream.body.contents[1].parts[0].thoughtSignature === 'signed-call'
    && googleJsonUpstream.body.contents[2].parts[0].functionResponse.response.result === 'ok')
  check('Google ingress credential is replaced by the Gemini Provider credential', googleJsonUpstream.authorization === ''
    && googleJsonUpstream.apiKey === ''
    && googleJsonUpstream.googleApiKey === googleProviderToken
    && googleJsonUpstream.googleApiKey !== gatewayToken
    && !googleJsonUpstream.raw.includes(gatewayToken))

  const googleStream = await requestText(firstPort, '/v1beta/models/gemini-gateway:streamGenerateContent?alt=sse', {
    googleApiKey: gatewayToken,
    body: { contents: [{ role: 'user', parts: [{ text: 'google-stream' }] }] }
  })
  check('native Google SSE streams through without protocol translation', googleStream.status === 200
    && googleStream.text.includes('google-stream-part')
    && googleStream.text.includes('usageMetadata'))

  const googleError = await requestJson(firstPort, '/v1beta/models/gemini-gateway:generateContent', {
    googleApiKey: gatewayToken,
    body: { contents: [{ role: 'user', parts: [{ text: 'google-upstream-error' }] }] }
  })
  check('Google upstream failures use a bounded native envelope', googleError.status === 429
    && googleError.body.error.code === 429
    && googleError.body.error.status === 'RESOURCE_EXHAUSTED'
    && !JSON.stringify(googleError.body).includes(secretCanary))

  const googleProviderB = await invoke('providers:create', {
    name: 'Gateway Gemini Beta',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1beta`,
    models: ['shared-gemini'],
    engine: 'gemini',
    authMode: 'api-key',
    token: googleProviderTokenB,
    tokenLabel: 'gateway-gemini-test-secondary'
  })
  const ambiguousGoogle = await requestJson(firstPort, '/v1beta/models/shared-gemini:generateContent', {
    googleApiKey: gatewayToken,
    body: { contents: [{ role: 'user', parts: [{ text: 'ambiguous' }] }] }
  })
  check('ambiguous Google model fails closed before Provider egress', ambiguousGoogle.status === 409)
  const explicitGoogleModel = encodeURIComponent(`${googleProviderB.id}/shared-gemini`)
  const explicitGoogle = await requestJson(firstPort, `/v1beta/models/${explicitGoogleModel}:generateContent`, {
    googleApiKey: gatewayToken,
    body: { contents: [{ role: 'user', parts: [{ text: 'explicit-google' }] }] }
  })
  check('namespaced Google model selects one exact Gemini Provider', explicitGoogle.status === 200
    && upstreamRequests.at(-1).path.startsWith('/v1beta/models/shared-gemini:generateContent'))
  const duplicateGoogleModels = await requestJson(firstPort, '/v1beta/models', { googleApiKey: gatewayToken })
  const sharedGoogleNames = duplicateGoogleModels.body.models
    .filter((model) => model.name.endsWith('/shared-gemini'))
    .map((model) => model.name)
  check('ambiguous Google catalog names are namespaced', sharedGoogleNames.length === 2
    && sharedGoogleNames.some((name) => name.startsWith(`models/${googleProviderA.id}/`))
    && sharedGoogleNames.some((name) => name.startsWith(`models/${googleProviderB.id}/`)))

  await runGeminiGatewayFailoverChecks({
    invoke, requestJson, check, firstPort, gatewayToken, googleProviderA, googleProviderB,
    googleProviderToken, googleProviderTokenB, upstreamRequests
  })

  await waitFor(async () => {
    const googleUsage = await invoke('providers:usage', { source: 'gateway.google.generative-language' })
    return googleUsage.requests >= 4 && googleUsage.inputTokens >= 17
      && googleUsage.outputTokens >= 12 && googleUsage.cacheReadTokens >= 2
  }, 5_000)
  const googleUsage = await invoke('providers:usage', {
    providerId: googleProviderA.id,
    source: 'gateway.google.generative-language'
  })
  check('Google usage, thinking tokens, cache tokens and configured pricing are aggregated', googleUsage.requests >= 3
    && googleUsage.inputTokens >= 17 && googleUsage.outputTokens >= 12
    && googleUsage.cacheReadTokens >= 2 && googleUsage.pricedRequests >= 2 && googleUsage.costUsd > 0)

  const blocker = http.createServer((_request, response) => response.end('occupied'))
  const blockedPort = await listen(blocker)
  const blocked = await invoke('providers:gateway:update', { port: blockedPort })
  check('port conflict stays blocked on the requested port', blocked.state === 'blocked'
    && blocked.port === blockedPort && blocked.lastErrorCode === 'port_in_use')
  const replacementPort = await freePort()
  const restarted = await invoke('providers:gateway:update', { port: replacementPort })
  check('gateway restarts only after an explicit port change', restarted.state === 'running' && restarted.port === replacementPort)
  await close(blocker)

  const rotated = await invoke('providers:gateway:update', { regenerateToken: true })
  await invoke('providers:gateway:copy-token')
  const rotatedToken = await waitFor(() => {
    const value = clipboard.readText()
    return /^cg_[A-Za-z0-9_-]{40,}$/.test(value) && value !== gatewayToken ? value : undefined
  }, 2_000)
  check('token rotation keeps gateway running and changes the credential', rotated.state === 'running'
    && rotatedToken !== gatewayToken && /^cg_/.test(rotatedToken))
  const oldDenied = await requestJson(replacementPort, '/v1/models', { token: gatewayToken })
  const newAllowed = await requestJson(replacementPort, '/v1/models', { token: rotatedToken })
  check('rotated token invalidates the old credential immediately', oldDenied.status === 401 && newAllowed.status === 200)
  gatewayToken = rotatedToken

  const win = await openGatewaySettings()
  const ui = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-provider-gateway]');
    return {
      present: Boolean(panel),
      models: panel?.querySelectorAll('tbody tr').length || 0,
      googleBaseUrl: panel?.innerText.includes('/v1beta') || false,
      protocols: [...(panel?.querySelectorAll('tbody tr td:nth-child(2)') || [])].map((cell) => cell.textContent),
      leaks: document.body.innerText.includes(${JSON.stringify(secretCanary)})
        || document.body.innerText.includes(${JSON.stringify(gatewayToken)})
    };
  })()`)
  check('gateway settings shows both protocol URLs and model engines without token plaintext', ui.present
    && ui.models === 6 && ui.googleBaseUrl && ui.protocols.includes('OpenAI') && ui.protocols.includes('Google') && !ui.leaks)
  win.setSize(760, 720)
  await settleRenderer(win)
  const compact = await rendererValue(win, `(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    panelOverflow: document.querySelector('[data-provider-gateway]')?.scrollWidth
      > document.querySelector('[data-provider-gateway]')?.clientWidth + 1
  }))()`)
  check('gateway settings remains contained at 760px', !compact.overflow && !compact.panelOverflow)
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
  fs.writeFileSync(screenshotPath, (await win.capturePage()).toPNG())

  await close(upstream)

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    tokenDigest: crypto.createHash('sha256').update(gatewayToken).digest('hex'),
    checks
  }
  const raw = `${JSON.stringify(report, null, 2)}\n`
  if ([secretCanary, gatewayToken, openAiProviderTokenA, openAiProviderTokenB, googleProviderToken, googleProviderTokenB]
    .some((secret) => raw.includes(secret))) throw new Error('gateway report contains credential material')
  fs.writeFileSync(statePath, raw)
  finish(0)
}

function startUpstream() {
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = JSON.parse(raw)
    upstreamRequests.push({
      path: request.url,
      authorization: request.headers.authorization || '',
      apiKey: request.headers['x-api-key'] || '',
      googleApiKey: request.headers['x-goog-api-key'] || '',
      raw,
      model: body.model,
      body
    })
    if (/^\/v1beta\/models\/[^:]+:(?:generateContent|streamGenerateContent)/.test(request.url || '')) {
      const bodyText = JSON.stringify(body)
      if (bodyText.includes('google-failover-503')) {
        if (request.headers['x-goog-api-key'] === googleProviderToken) {
          json(response, 503, {
            error: { message: `do-not-leak-${secretCanary}` },
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 }
          })
          return
        }
        json(response, 200, {
          candidates: [{ content: { role: 'model', parts: [{ text: 'google-failover-ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }
        })
        return
      }
      if (bodyText.includes('google-upstream-error')) {
        json(response, 429, { error: { message: `do-not-leak-${secretCanary}` } })
        return
      }
      if (request.url.includes(':streamGenerateContent') && request.url.includes('alt=sse')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ responseId: 'google-stream-1', candidates: [{ content: { role: 'model', parts: [{ text: 'google-stream-part' }] } }] })}\n\n`)
        response.end(`data: ${JSON.stringify({ responseId: 'google-stream-1', candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 1 } })}\n\n`)
        return
      }
      json(response, 200, {
        responseId: 'google-gateway-1',
        candidates: [{
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'read_file', args: { path: 'README.md' } }, thoughtSignature: 'gateway-thought-signature' }]
          },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 2 }
      })
      return
    }
    const messagesText = JSON.stringify(body.messages || [])
    if (messagesText.includes('gateway-failover-429')) {
      if (request.headers.authorization === `Bearer ${openAiProviderTokenA}`) {
        json(response, 429, {
          error: { message: `do-not-leak-${secretCanary}` },
          usage: { prompt_tokens: 3, completion_tokens: 1 }
        })
        return
      }
      json(response, 200, {
        choices: [{ message: { role: 'assistant', content: 'gateway-failover-ok' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      })
      return
    }
    if (messagesText.includes('gateway-failover-max-retries')) {
      json(response, 429, { error: { message: `do-not-leak-${secretCanary}` } })
      return
    }
    if (messagesText.includes('gateway-no-failover-400')) {
      json(response, 400, { error: { message: `do-not-leak-${secretCanary}` } })
      return
    }
    if (messagesText.includes('gateway-no-failover-redirect')) {
      response.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/redirect-secret` })
      response.end()
      return
    }
    if (messagesText.includes('gateway-stream-fail-before-byte')) {
      if (request.headers.authorization === `Bearer ${openAiProviderTokenA}`) {
        request.socket.destroy()
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'gateway-failover-stream-ok' } }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    if (messagesText.includes('gateway-stream-fail-after-byte')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'gateway-committed-byte' } }] })}\n\n`)
      setImmediate(() => response.destroy())
      return
    }
    if (request.url === '/v1/chat/completions' && body.stream && !messagesText.includes('anthropic-stream')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'gateway-stream' } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    if (request.url === '/v1/responses') {
      json(response, 200, { id: 'resp_gateway', output: [{ content: [{ type: 'output_text', text: 'gateway-response' }] }], usage: { input_tokens: 7, output_tokens: 3 } })
      return
    }
    if (body.stream && messagesText.includes('anthropic-stream')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'chat_stream_gateway', choices: [{ index: 0, delta: { role: 'assistant', content: 'gateway-stream' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chat_stream_gateway', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_stream', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chat_stream_gateway', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chat_stream_gateway', choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    if (messagesText.includes('anthropic-upstream-error')) {
      json(response, 429, { error: { message: `do-not-leak-${secretCanary}` } })
      return
    }
    if (messagesText.includes('anthropic-tool-request')) {
      json(response, 200, {
        id: 'chat_tool_gateway',
        choices: [{ message: { role: 'assistant', content: 'planning', tool_calls: [{ id: 'call_gateway', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 6, completion_tokens: 3 }
      })
      return
    }
    json(response, 200, { id: 'chat_gateway', choices: [{ message: { role: 'assistant', content: 'gateway-ok' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } })
  })
  return listen(server).then(() => server)
}

function requestJson(port, route, options = {}) {
  return request(port, route, options).then(({ status, text }) => {
    let body = {}
    try { body = JSON.parse(text) } catch { body = { raw: text } }
    return { status, body }
  })
}

function requestText(port, route, options = {}) { return request(port, route, options) }

function request(port, route, options) {
  return new Promise((resolve, reject) => {
    const bodyText = options.bodyText ?? (options.body === undefined ? '' : JSON.stringify(options.body))
    const headers = { ...(bodyText ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyText) } : {}) }
    if (options.token) headers.authorization = `Bearer ${options.token}`
    if (options.apiKey) headers['x-api-key'] = options.apiKey
    if (options.googleApiKey) headers['x-goog-api-key'] = options.googleApiKey
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = http.request({ host: '127.0.0.1', port, path: route, method: bodyText ? 'POST' : 'GET', headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => finish({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), aborted: false }))
      response.on('aborted', () => finish({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), aborted: true }))
    })
    req.on('error', (error) => { if (!settled) reject(error) })
    if (bodyText) req.write(bodyText)
    req.end()
  })
}

function readGatewayUsage() {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'private', 'provider-gateway-usage.json'), 'utf8')).records
}

async function openGatewaySettings() {
  const win = await waitForWindow()
  win.setSize(1200, 800)
  await waitForRenderer(win, `document.readyState === 'complete'`)
  win.webContents.send('menu:settings')
  await waitForRenderer(win, `Boolean(document.querySelector('.settings-page'))`)
  await rendererValue(win, `document.querySelector('[data-settings-tab="providers"]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-surface="gateway"]'))`)
  await rendererValue(win, `document.querySelector('[data-provider-surface="gateway"]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-gateway]'))`)
  await waitForRenderer(win, `document.querySelectorAll('[data-provider-gateway] tbody tr').length === 6`)
  await settleRenderer(win)
  return win
}

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow()
  return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args)
}

function waitForWindow() { return waitFor(() => BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()), 10_000) }
function rendererValue(win, expression) { return win.webContents.executeJavaScript(expression, true) }
function waitForRenderer(win, expression, timeout = 10_000) {
  return waitFor(async () => { try { return await rendererValue(win, expression) } catch { return false } }, timeout)
}
async function settleRenderer(win) {
  await rendererValue(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  win.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 250))
}

function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)) }) }
function close(server) { return new Promise((resolve) => server.close(() => resolve())) }
async function freePort() { const server = http.createServer(); const port = await listen(server); await close(server); return port }
function json(response, status, body) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
function waitFor(predicate, timeout) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try { const value = await predicate(); if (value) return resolve(value) } catch { /* startup race */ }
      if (Date.now() - started > timeout) return reject(new Error('provider gateway wait timed out'))
      setTimeout(() => void poll(), 50)
    }
    void poll()
  })
}
function check(name, condition) { checks.push({ name, status: condition ? 'pass' : 'fail' }); console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}`); if (!condition) throw new Error(name) }
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`missing ${name}`); return value }
function finish(code) { app.exit(code) }

app.whenReady().then(() => run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  finish(1)
}))
