import assert from 'node:assert/strict'

export async function verifyAssistantOverrideProjection({
  page,
  session,
  clickMode,
  openCommandPalette,
  assertMode
}) {
  const persisted = await page.evaluate((id) => window.agentDesk.listSessions()
    .then((items) => items.find((item) => item.id === id)), session.id)
  assert(persisted?.projectId, `legacy project context missing: ${JSON.stringify(persisted)}`)
  assert.equal(persisted.experienceModeOverride, 'assistant', `Assistant override missing: ${JSON.stringify(persisted)}`)
  await clickMode(page, 'assistant')
  await page.waitForSelector(`[data-sidebar-assistant-sessions] [data-session-id="${session.id}"]`, {
    visible: true,
    timeout: 10_000
  })

  await page.click('.sidebar-new')
  await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 10_000 })
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(modifier)
  await page.keyboard.press('1')
  await page.keyboard.up(modifier)
  await page.waitForSelector('.composer-input', { visible: true, timeout: 10_000 })
  await assertMode(page, 'assistant')

  await openCommandPalette(page)
  await page.waitForSelector(`[data-command-id="session:${session.id}"]`, { visible: true, timeout: 5_000 })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.command-palette-backdrop', { hidden: true, timeout: 5_000 })
}
