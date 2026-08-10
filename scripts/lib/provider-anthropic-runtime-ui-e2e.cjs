const fs = require('node:fs')
const path = require('node:path')

async function runProviderAnthropicRuntimeUiE2E(input) {
  const provider = await createProvider(input)
  input.check('isolated Anthropic Provider is ready with an ephemeral test credential',
    provider.hasToken === true && provider.ready === true)
  fs.mkdirSync(input.screenshotDir, { recursive: true })
  const win = await input.openProviderProfileSettings(false)
  input.check('Anthropic runtime E2E opens the Provider editor',
    await input.openProviderEditor(win, provider.name))
  await input.waitForRenderer(win, `Boolean(document.querySelector('[data-provider-anthropic-runtime]'))`)
  await configureRuntime(input, win)
  await verifyRuntimeLayout(input, win)
  await verifyRuntimePersistence(input, win, provider)
  writeReport(input)
}

function createProvider(input) {
  return input.invoke('providers:create', {
    name: 'Anthropic Runtime Provider',
    baseUrl: 'http://127.0.0.1:21436/v1',
    models: ['claude-sonnet-4-20250514'],
    engine: 'anthropic',
    authMode: 'api-key',
    token: ['anthropic', 'runtime', 'e2e', 'canary'].join('-')
  })
}

async function configureRuntime(input, win) {
  await setSelect(input, win, 0, 'enabled')
  await input.waitForRenderer(win, `document.querySelectorAll('[data-provider-anthropic-runtime] input').length === 2`)
  await setNumber(input, win, '[data-provider-runtime-config]', 2, '12000')
  await setNumber(input, win, '[data-provider-anthropic-runtime]', 0, '4096')
  await setSelect(input, win, 1, 'omitted')
  await setSelect(input, win, 2, 'true')
  await input.waitForRenderer(win, `document.querySelectorAll('[data-provider-anthropic-runtime] select').length === 5`)
  await setSelect(input, win, 3, '1h')
  await setSelect(input, win, 4, 'last-user')
  await setNumber(input, win, '[data-provider-anthropic-runtime]', 1, '24')

  const configured = await readRuntimeUi(input, win)
  input.check('Anthropic controls accept Thinking, cache, output, and top K values',
    configured.maxOutput === '12000'
      && configured.selects.join(',') === 'enabled,omitted,true,1h,last-user'
      && configured.inputs.join(',') === '4096,24',
    JSON.stringify(configured))
}

async function verifyRuntimeLayout(input, win) {
  await input.rendererValue(win,
    `document.querySelector('[data-provider-anthropic-runtime]')?.scrollIntoView({ block: 'start' })`)
  await input.captureUiScreenshot(win, 'provider-anthropic-runtime.png')

  win.setSize(760, 700)
  await input.settleRenderer(win)
  const compact = await compactRuntimeUi(input, win)
  input.check('Anthropic runtime controls remain contained at 760x700',
    !compact.overflow && compact.contained && compact.controlsFit && compact.textFits,
    JSON.stringify(compact))
  await input.captureUiScreenshot(win, 'provider-anthropic-runtime-compact.png')
  win.setSize(1200, 800)
}

async function verifyRuntimePersistence(input, win, provider) {
  await input.clickProviderEditorSave(win)
  await input.waitForRenderer(win, `!document.querySelector('.provider-editor')`)
  const persisted = (await input.invoke('providers:list'))
    .find((candidate) => candidate.id === provider.id)?.advancedConfig?.runtime
  input.check('Anthropic runtime persists through the production Provider save path',
    persisted?.maxOutputTokens === 12_000
      && persisted?.anthropic?.thinking?.mode === 'enabled'
      && persisted?.anthropic?.thinking?.budgetTokens === 4096
      && persisted?.anthropic?.thinking?.display === 'omitted'
      && persisted?.anthropic?.promptCaching?.enabled === true
      && persisted?.anthropic?.promptCaching?.ttl === '1h'
      && persisted?.anthropic?.promptCaching?.strategy === 'last-user'
      && persisted?.anthropic?.topK === 24,
    JSON.stringify(persisted))

  input.check('saved Anthropic runtime can be reopened',
    await input.openProviderEditor(win, provider.name))
  await input.waitForRenderer(win, `Boolean(document.querySelector('[data-provider-anthropic-runtime]'))`)
  const reopened = await readRuntimeUi(input, win)
  input.check('saved Anthropic controls round-trip without losing values',
    reopened.maxOutput === '12000'
      && reopened.selects.join(',') === 'enabled,omitted,true,1h,last-user'
      && reopened.inputs.join(',') === '4096,24',
    JSON.stringify(reopened))
  await input.clickProviderEditorCancel(win)
  await input.waitForRenderer(win, `!document.querySelector('.provider-editor')`)
}

function writeReport(input) {
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: input.checks.length,
    total: input.checks.length,
    screenshots: [
      path.join(input.screenshotDir, 'provider-anthropic-runtime.png'),
      path.join(input.screenshotDir, 'provider-anthropic-runtime-compact.png')
    ],
    checks: input.checks
  }
  fs.writeFileSync(input.statePath, `${JSON.stringify(report, null, 2)}\n`)
}

async function setSelect(input, win, index, value) {
  const changed = await input.rendererValue(win, `(() => {
    const select = document.querySelectorAll('[data-provider-anthropic-runtime] select')[${index}];
    if (!select) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value === ${JSON.stringify(value)};
  })()`)
  if (!changed) throw new Error(`Anthropic runtime select ${index} did not accept ${value}`)
  await input.settleRenderer(win)
}

async function setNumber(input, win, root, index, value) {
  const changed = await input.rendererValue(win, `(() => {
    const field = document.querySelectorAll(${JSON.stringify(`${root} input[type="number"]`)})[${index}];
    if (!field) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return field.value === ${JSON.stringify(value)};
  })()`)
  if (!changed) throw new Error(`Anthropic runtime number ${index} did not accept ${value}`)
  await input.settleRenderer(win)
}

function readRuntimeUi(input, win) {
  return input.rendererValue(win, `(() => ({
    maxOutput: document.querySelectorAll('[data-provider-runtime-config] input[type="number"]')[2]?.value || '',
    selects: [...document.querySelectorAll('[data-provider-anthropic-runtime] select')].map((field) => field.value),
    inputs: [...document.querySelectorAll('[data-provider-anthropic-runtime] input[type="number"]')].map((field) => field.value)
  }))()`)
}

function compactRuntimeUi(input, win) {
  return input.rendererValue(win, `(() => {
    const root = document.querySelector('[data-provider-anthropic-runtime]');
    const rect = root?.getBoundingClientRect();
    const controls = [...(root?.querySelectorAll('select, input, button') || [])];
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      contained: Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth + 1),
      controlsFit: controls.every((control) => {
        const bounds = control.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth + 1;
      }),
      textFits: controls.every((control) => control.scrollWidth <= control.clientWidth + 1)
    };
  })()`)
}

module.exports = { runProviderAnthropicRuntimeUiE2E }
