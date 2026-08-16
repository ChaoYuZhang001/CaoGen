async function verifyProviderPricingCatalogUi(runtime, win, providerId) {
  const context = { ...runtime, win, providerId, editorSaved: false }
  const provider = (await runtime.invoke('providers:list')).find((candidate) => candidate.id === providerId)
  runtime.check('pricing catalog UI target Provider exists', Boolean(provider))
  const opened = await runtime.openProviderEditor(win, provider.name)
  runtime.check('pricing catalog UI opens the Provider editor', opened)
  await runtime.waitForRenderer(win, `Boolean(document.querySelector('[data-provider-model-catalog]'))`)
  await syncDiscoveredModels(context)

  const originalFetch = global.fetch
  const catalogCalls = []
  global.fetch = createCatalogFetch(originalFetch, catalogCalls)
  try {
    await verifyCatalogImport(context, catalogCalls)
    await verifyManualPriceProtection(context)
    await verifyCompactCatalog(context)
    await configureReliability(context)
    await configureCircuitBreaker(context)
    await configureEndpoint(context)
    await saveAdvancedConfiguration(context)
    await verifyReliabilityRoundTrip(context, provider.name)
  } finally {
    global.fetch = originalFetch
    await closePricingEditor(context)
  }
}

async function syncDiscoveredModels(context) {
  const { win, setProviderEditorField, check, clickRendererText, waitForRenderer, rendererValue } = context
  const modelsSet = await setProviderEditorField(win, '[data-provider-field="models"]', 'gpt-4o\nspecial-model')
  check('pricing catalog UI accepts the discovered model list', modelsSet)
  await clickRendererText(win, '同步模型')
  await waitForRenderer(win, `document.querySelectorAll('.provider-advanced-model').length === 2`)
  const syncedUi = await rendererValue(win, `({
    profiles: document.querySelectorAll('.provider-advanced-model').length,
    privacy: document.querySelector('.provider-model-catalog-note')?.textContent || '',
    modelIds: [...document.querySelectorAll('.provider-advanced-model input[aria-label="模型 ID"]')].map((input) => input.value)
  })`)
  const valid = [
    syncedUi.profiles === 2,
    syncedUi.modelIds.join(',') === 'gpt-4o,special-model',
    syncedUi.privacy.includes('不发送 Provider 凭据')
  ]
  check('sync turns discovered models into editable profiles', valid.every(Boolean), JSON.stringify(syncedUi))
}

function createCatalogFetch(originalFetch, catalogCalls) {
  return async (url, init = {}) => {
    if (String(url) !== 'https://models.dev/api.json') return originalFetch(url, init)
    catalogCalls.push({ url: String(url), init })
    return new Response(JSON.stringify({
      openai: {
        name: 'OpenAI',
        models: {
          'gpt-4o': {
            name: 'GPT-4o',
            modalities: { output: ['text'] },
            cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 2.5 }
          }
        }
      },
      vendor: {
        name: 'Vendor',
        models: {
          'special-model': {
            name: 'Special Model',
            modalities: { output: ['text'] },
            cost: { input: 0.2, output: 0.8, cache_read: 0.1, cache_write: 0.2 }
          }
        }
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

async function verifyCatalogImport(context, catalogCalls) {
  const { win, clickRendererText, waitForRenderer, rendererValue, check } = context
  await clickRendererText(win, '导入定价')
  await waitForRenderer(win, `document.body.innerText.includes('已导入 2 个定价')`)
  const importedUi = await rendererValue(win, `(() => {
    const cards = [...document.querySelectorAll('.provider-advanced-model')];
    return {
      sources: cards.map((card) => card.querySelector('.provider-pricing-source')?.textContent.trim()),
      values: cards.map((card) => [...card.querySelectorAll('.provider-advanced-pricing input')].map((input) => input.value)),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`)
  const imported = [
    importedUi.sources.join(',') === '目录,目录',
    importedUi.values[0].join(',') === '2.5,10,1.25,2.5',
    importedUi.values[1].join(',') === '0.2,0.8,0.1,0.2',
    !importedUi.overflow
  ]
  check('catalog import fills four prices and exposes catalog provenance', imported.every(Boolean), JSON.stringify(importedUi))
  const requestIsPrivate = [
    catalogCalls.length === 1,
    Object.keys(catalogCalls[0].init).sort().join(',') === 'method,redirect,signal',
    catalogCalls[0].init.method === 'GET'
  ]
  check('catalog IPC sends no Provider credentials or endpoint configuration', requestIsPrivate.every(Boolean))
}

async function verifyManualPriceProtection(context) {
  const { win, rendererValue, check, waitForRenderer, clickRendererText } = context
  const edited = await rendererValue(win, `(() => {
    const input = document.querySelector('.provider-advanced-model .provider-advanced-pricing input');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '99');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value === '99';
  })()`)
  check('pricing catalog UI accepts a manual price edit', edited)
  await waitForRenderer(win, `document.querySelector('.provider-pricing-source')?.textContent.trim() === '手工'`)
  await clickRendererText(win, '导入定价')
  await waitForRenderer(win, `document.body.innerText.includes('保护 1 个手工定价')`)
  const protectedUi = await rendererValue(win, `({
    value: document.querySelector('.provider-advanced-model .provider-advanced-pricing input')?.value,
    source: document.querySelector('.provider-pricing-source')?.textContent.trim()
  })`)
  check('reimport never overwrites a manual price', protectedUi.value === '99' && protectedUi.source === '手工')
}

async function verifyCompactCatalog(context) {
  const { win, rendererValue, captureUiScreenshot, settleRenderer, check } = context
  await rendererValue(win, `document.querySelector('[data-provider-model-catalog]')?.scrollIntoView({ block: 'start' })`)
  await captureUiScreenshot(win, 'provider-pricing-catalog.png')
  win.setSize(760, 700)
  await rendererValue(win, `document.querySelector('[data-provider-model-catalog]')?.scrollIntoView({ block: 'start' })`)
  await settleRenderer(win)
  const compactUi = await rendererValue(win, `({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    actionsFit: [...document.querySelectorAll('.provider-model-actions button')]
      .every((button) => button.scrollWidth <= button.clientWidth + 1),
    pricingInputsFit: [...document.querySelectorAll('.provider-advanced-model')].every((card) => {
      const inputs = [...card.querySelectorAll('.provider-advanced-pricing input')].map((input) => input.getBoundingClientRect());
      return inputs.every((rect) => rect.left >= 0 && rect.right <= window.innerWidth)
        && inputs.every((left, index) => inputs.slice(index + 1).every((right) =>
          left.right <= right.left || right.right <= left.left || left.bottom <= right.top || right.bottom <= left.top));
    })
  })`)
  const usable = [!compactUi.overflow, compactUi.actionsFit, compactUi.pricingInputsFit]
  check('pricing catalog remains usable at 760x700', usable.every(Boolean), JSON.stringify(compactUi))
  await captureUiScreenshot(win, 'provider-pricing-catalog-compact.png')
  win.setSize(1200, 800)
}

async function configureReliability(context) {
  const { win, rendererValue, check, waitForRenderer } = context
  const configured = await rendererValue(win, `(() => {
    const root = document.querySelector('[data-provider-reliability-config]');
    if (!root) return false;
    const select = root.querySelector('select');
    const inputs = [...root.querySelectorAll('.provider-reliability-grid:not(.provider-circuit-grid) input')];
    if (!select || inputs.length !== 4) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'false');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    ['3', '45', '90', '300'].forEach((value, index) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[index], value);
      inputs[index].dispatchEvent(new Event('input', { bubbles: true }));
    });
    root.querySelector('.provider-reliability-toggle input')?.click();
    return true;
  })()`)
  check('visual reliability controls accept failover, retry, and timeout overrides', configured)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-circuit-config]'))`)
}

async function configureCircuitBreaker(context) {
  const { win, rendererValue, check } = context
  const configured = await rendererValue(win, `(() => {
    const inputs = [...document.querySelectorAll('[data-provider-circuit-config] input')];
    if (inputs.length !== 5) return false;
    ['5', '2', '75', '65', '12'].forEach((value, index) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[index], value);
      inputs[index].dispatchEvent(new Event('input', { bubbles: true }));
    });
    return true;
  })()`)
  check('visual circuit-breaker controls accept bounded thresholds', configured)
}

async function configureEndpoint(context) {
  const { win, rendererValue, check, waitForRenderer, setProviderEditorField } = context
  const configured = await rendererValue(win, `(() => {
    const root = document.querySelector('[data-provider-endpoint-config]');
    const add = root?.querySelector('.provider-advanced-section-title button');
    add?.click();
    return Boolean(add);
  })()`)
  check('visual endpoint editor can add a prioritized endpoint', configured)
  await waitForRenderer(win, `document.querySelectorAll('[data-provider-endpoint-config] .provider-advanced-row').length === 1`)
  const values = [
    await setProviderEditorField(win, '[data-provider-endpoint-config] .provider-advanced-row > input:nth-of-type(1)', 'primary'),
    await setProviderEditorField(win, '[data-provider-endpoint-config] .provider-advanced-row > input:nth-of-type(2)', 'https://primary.example.test/v1'),
    await setProviderEditorField(win, '[data-provider-endpoint-config] .provider-advanced-row > input:nth-of-type(3)', '2')
  ]
  check('endpoint ID, URL, and priority are editable', values.every(Boolean))
}

async function saveAdvancedConfiguration(context) {
  const { win, providerId, clickProviderEditorSave, waitForRenderer, invoke, check } = context
  await clickProviderEditorSave(win)
  await waitForRenderer(win, `!document.querySelector('.provider-editor')`)
  context.editorSaved = true
  const persisted = (await invoke('providers:list')).find((candidate) => candidate.id === providerId)?.advancedConfig
  const valuesPersisted = [
    persisted?.reliability?.failoverEnabled === false,
    persisted?.reliability?.maxRetries === 3,
    persisted?.reliability?.streamingFirstByteTimeoutSeconds === 45,
    persisted?.reliability?.streamingIdleTimeoutSeconds === 90,
    persisted?.reliability?.requestTimeoutSeconds === 300,
    persisted?.reliability?.circuitBreaker?.failureThreshold === 5,
    persisted?.reliability?.circuitBreaker?.errorRateThreshold === 0.65,
    persisted?.endpoints?.[0]?.id === 'primary',
    persisted?.endpoints?.[0]?.priority === 2
  ]
  check('reliability and endpoint overrides persist through the production Provider save path',
    valuesPersisted.every(Boolean),
    JSON.stringify({ reliability: persisted?.reliability, endpoint: persisted?.endpoints?.[0] }))
}

async function verifyReliabilityRoundTrip(context, providerName) {
  const { win, openProviderEditor, check, waitForRenderer, rendererValue, settleRenderer, captureUiScreenshot } = context
  const reopened = await openProviderEditor(win, providerName)
  check('saved reliability configuration can be reopened', reopened)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-circuit-config]'))`)
  win.setSize(760, 700)
  await rendererValue(win, `document.querySelector('[data-provider-reliability-config]')?.scrollIntoView({ block: 'start' })`)
  await settleRenderer(win)
  const reliabilityUi = await rendererValue(win, `(() => {
    const root = document.querySelector('[data-provider-reliability-config]');
    const base = [...root.querySelectorAll('.provider-reliability-grid:not(.provider-circuit-grid) input')].map((input) => input.value);
    const circuit = [...root.querySelectorAll('[data-provider-circuit-config] input')].map((input) => input.value);
    const rect = root.getBoundingClientRect();
    return {
      base,
      circuit,
      contained: rect.left >= 0 && rect.right <= window.innerWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`)
  const roundTrips = [
    reliabilityUi.base.join(',') === '3,45,90,300',
    reliabilityUi.circuit.join(',') === '5,2,75,65,12',
    reliabilityUi.contained,
    !reliabilityUi.overflow
  ]
  check('saved reliability controls round-trip and fit at 760x700', roundTrips.every(Boolean), JSON.stringify(reliabilityUi))
  await captureUiScreenshot(win, 'provider-reliability-compact.png')
  win.setSize(1200, 800)
}

async function closePricingEditor(context) {
  const { win, rendererValue, clickProviderEditorCancel, waitForRenderer } = context
  if (await rendererValue(win, `Boolean(document.querySelector('.provider-editor'))`)) {
    await clickProviderEditorCancel(win)
    await waitForRenderer(win, `!document.querySelector('.provider-editor')`)
  } else if (!context.editorSaved) {
    throw new Error('Provider editor closed before the reliability configuration was saved')
  }
}

module.exports = { verifyProviderPricingCatalogUi }
