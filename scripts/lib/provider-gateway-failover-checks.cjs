const FAILOVER_RELIABILITY = {
  failoverEnabled: true,
  maxRetries: 1,
  circuitBreaker: {
    failureThreshold: 20,
    successThreshold: 1,
    timeoutSeconds: 60,
    errorRateThreshold: 1,
    minRequests: 20
  }
}

async function runOpenAiGatewayFailoverChecks(context) {
  await configureOpenAiProviders(context)
  await verifySuccessfulOpenAiFailover(context)
  await verifyFailoverPolicyControls(context)
  await verifyFailoverCommitBoundary(context)
}

async function configureOpenAiProviders(context) {
  const { invoke, providerA, providerB, openAiProviderTokenA, openAiProviderTokenB } = context
  await invoke('providers:update', providerA.id, {
    authMode: 'api-key',
    token: openAiProviderTokenA,
    tokenLabel: 'gateway-openai-primary',
    advancedConfig: pricedPrimaryAdvancedConfig(FAILOVER_RELIABILITY)
  })
  await invoke('providers:update', providerB.id, {
    authMode: 'api-key',
    token: openAiProviderTokenB,
    tokenLabel: 'gateway-openai-secondary',
    advancedConfig: { schemaVersion: 1, reliability: FAILOVER_RELIABILITY }
  })
}

async function verifySuccessfulOpenAiFailover(context) {
  const {
    check, requestJson, firstPort, gatewayToken, providerA, upstreamRequests,
    openAiProviderTokenA, openAiProviderTokenB, readGatewayUsage
  } = context
  const before = upstreamRequests.length
  const result = await requestJson(firstPort, '/v1/chat/completions', {
    token: gatewayToken,
    body: {
      model: `${providerA.id}/shared-model`,
      messages: [{ role: 'user', content: 'gateway-failover-429' }]
    }
  })
  const attempts = upstreamRequests.slice(before)
  check('OpenAI 429 fails over once to a same-protocol Provider', result.status === 200
    && result.body.choices[0].message.content === 'gateway-failover-ok' && attempts.length === 2)
  check('each OpenAI failover attempt uses only its selected Provider credential',
    attempts[0].authorization === `Bearer ${openAiProviderTokenA}`
    && attempts[1].authorization === `Bearer ${openAiProviderTokenB}`
    && attempts.every((item) => !item.raw.includes(gatewayToken)))
  const ledger = readGatewayUsage().slice(-2)
  check('failover ledger preserves request identity, order, predecessor and both usage records',
    validFailoverLedger(ledger))
}

function validFailoverLedger(ledger) {
  if (ledger.length !== 2) return false
  const [failed, succeeded] = ledger
  const identityValid = failed.requestId === succeeded.requestId
    && failed.ordinal === 0 && succeeded.ordinal === 1
    && succeeded.failoverFromAttemptId === failed.id
  const failedValid = failed.status === 'failed' && failed.upstreamStatus === 429
    && failed.usage.inputTokens === 3 && failed.usage.outputTokens === 1
  const succeededValid = succeeded.status === 'succeeded'
    && succeeded.usage.inputTokens === 5 && succeeded.usage.outputTokens === 2
  return identityValid && failedValid && succeededValid
}

async function verifyFailoverPolicyControls(context) {
  const { invoke, requestJson, check, firstPort, gatewayToken, providerA, upstreamRequests } = context
  await updatePrimaryConfig(invoke, providerA.id, { ...FAILOVER_RELIABILITY, maxRetries: 0 })
  await expectSingle429(context, 'Provider maxRetries zero prevents a second upstream attempt')
  const inheritedReliability = { ...FAILOVER_RELIABILITY }
  delete inheritedReliability.failoverEnabled
  await invoke('settings:update', { failoverEnabled: false })
  await updatePrimaryConfig(invoke, providerA.id, inheritedReliability, false)
  await expectSingle429(context, 'global failover disable is inherited when Provider has no override')
  await invoke('settings:update', { failoverEnabled: true })
  await updatePrimaryConfig(invoke, providerA.id, { ...FAILOVER_RELIABILITY, failoverEnabled: false }, false)
  const before = upstreamRequests.length
  const result = await requestJson(firstPort, '/v1/chat/completions', retryLimitRequest(gatewayToken, providerA.id))
  check('Provider failover disable overrides the enabled global default', result.status === 429
    && upstreamRequests.length === before + 1)
  await updatePrimaryConfig(invoke, providerA.id, FAILOVER_RELIABILITY)
}

async function verifyFailoverCommitBoundary(context) {
  const { requestJson, requestText, check, firstPort, gatewayToken, providerA, upstreamRequests } = context
  const singleRequestCases = [
    ['gateway-no-failover-400', 400, 'non-switchable HTTP 400 never replays on another Provider'],
    ['gateway-no-failover-redirect', 502, 'upstream redirect is rejected without failover']
  ]
  for (const [message, status, label] of singleRequestCases) {
    const before = upstreamRequests.length
    const result = await requestJson(firstPort, '/v1/chat/completions', chatRequest(gatewayToken, providerA.id, message))
    check(label, result.status === status && upstreamRequests.length === before + 1)
  }
  const beforePreOutput = upstreamRequests.length
  const preOutput = await requestText(
    firstPort, '/v1/chat/completions', chatRequest(gatewayToken, providerA.id, 'gateway-stream-fail-before-byte', true)
  )
  check('stream failure before the first body byte safely fails over', preOutput.status === 200
    && preOutput.text.includes('gateway-failover-stream-ok') && upstreamRequests.length === beforePreOutput + 2)
  const beforeCommitted = upstreamRequests.length
  const committed = await requestText(
    firstPort, '/v1/chat/completions', chatRequest(gatewayToken, providerA.id, 'gateway-stream-fail-after-byte', true)
  )
  check('stream failure after output is committed never replays', committed.status === 200
    && committed.text.includes('gateway-committed-byte') && committed.aborted === true
    && upstreamRequests.length === beforeCommitted + 1)
}

async function runGeminiGatewayFailoverChecks(context) {
  const {
    invoke, requestJson, check, firstPort, gatewayToken, googleProviderA, googleProviderB,
    googleProviderToken, googleProviderTokenB, upstreamRequests
  } = context
  await invoke('providers:update', googleProviderA.id, {
    advancedConfig: {
      schemaVersion: 1,
      reliability: FAILOVER_RELIABILITY,
      modelProfiles: [{
        model: 'gemini-gateway',
        pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, source: 'user' }
      }, { model: 'shared-gemini' }]
    }
  })
  await invoke('providers:update', googleProviderB.id, {
    advancedConfig: { schemaVersion: 1, reliability: FAILOVER_RELIABILITY }
  })
  const before = upstreamRequests.length
  const model = encodeURIComponent(`${googleProviderA.id}/shared-gemini`)
  const result = await requestJson(firstPort, `/v1beta/models/${model}:generateContent`, {
    googleApiKey: gatewayToken,
    body: { contents: [{ role: 'user', parts: [{ text: 'google-failover-503' }] }] }
  })
  const attempts = upstreamRequests.slice(before)
  check('Gemini 503 fails over once with native Google protocol intact', result.status === 200
    && result.body.candidates[0].content.parts[0].text === 'google-failover-ok' && attempts.length === 2)
  check('each Gemini failover attempt uses only its selected Provider credential',
    attempts[0].googleApiKey === googleProviderToken && attempts[1].googleApiKey === googleProviderTokenB
    && attempts.every((item) => item.googleApiKey !== gatewayToken && !item.raw.includes(gatewayToken)))
}

async function expectSingle429(context, label) {
  const { requestJson, check, firstPort, gatewayToken, providerA, upstreamRequests } = context
  const before = upstreamRequests.length
  const result = await requestJson(firstPort, '/v1/chat/completions', retryLimitRequest(gatewayToken, providerA.id))
  check(label, result.status === 429 && upstreamRequests.length === before + 1)
}

function updatePrimaryConfig(invoke, providerId, reliability, priced = true) {
  return invoke('providers:update', providerId, {
    advancedConfig: pricedPrimaryAdvancedConfig(reliability, priced)
  })
}

function pricedPrimaryAdvancedConfig(reliability, priced = true) {
  return {
    schemaVersion: 1,
    reliability,
    modelProfiles: [{
      model: 'shared-model',
      ...(priced ? { pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, source: 'user' } } : {})
    }]
  }
}

function retryLimitRequest(token, providerId) {
  return chatRequest(token, providerId, 'gateway-failover-max-retries')
}

function chatRequest(token, providerId, message, stream = false) {
  return {
    token,
    body: {
      model: `${providerId}/shared-model`,
      ...(stream ? { stream: true } : {}),
      messages: [{ role: 'user', content: message }]
    }
  }
}

module.exports = { runGeminiGatewayFailoverChecks, runOpenAiGatewayFailoverChecks }
