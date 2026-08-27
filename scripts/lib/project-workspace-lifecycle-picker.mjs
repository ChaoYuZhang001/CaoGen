const TRIGGER = '[data-project-workspace-select-trigger]'
const MENU = '[data-project-workspace-select-menu]'
const STATIC_PROJECT = '[data-project-workspace-select-static]'
const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 960, height: 640 }]

export async function verifyBoundedProjectPicker(page, screenshot) {
  await page.waitForSelector(STATIC_PROJECT, { visible: true, timeout: 5_000 })
  assert(await page.$(TRIGGER) === null, 'single Project exposed a meaningless picker trigger')
  const singleProjectState = await page.$eval('[data-project-workspace-select]', (select) => ({
    disabled: select.disabled,
    optionCount: select.options.length
  }))
  assert(singleProjectState.disabled && singleProjectState.optionCount === 1,
    `single Project automation bridge is not static: ${JSON.stringify(singleProjectState)}`)

  const longProjectName = 'Project picker long name '.repeat(8) + '终点'
  const alternative = await page.evaluate((name) => window.agentDesk.createProjectWorkspace({
    id: 'project-picker-alternative',
    name,
    kind: 'research'
  }), longProjectName)
  await page.click('[data-studio-action="refresh"]')
  await page.waitForSelector(TRIGGER, { visible: true, timeout: 5_000 })
  await page.waitForFunction(
    (selector) => document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector(selector)?.disabled === false,
    { timeout: 10_000 },
    TRIGGER
  )

  for (const viewport of VIEWPORTS) {
    await verifyPickerViewport(page, screenshot, viewport)
  }

  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  await page.evaluate(async (projectId) => {
    await window.agentDesk.deleteProjectWorkspace(projectId)
    await window.agentDesk.purgeProjectWorkspace(projectId)
  }, alternative.id)
  await page.click('[data-studio-action="refresh"]')
  await page.waitForSelector(STATIC_PROJECT, { visible: true, timeout: 5_000 })
  assert(await page.$(TRIGGER) === null, 'single Project picker trigger returned after cleanup')
}

async function verifyPickerViewport(page, screenshot, viewport) {
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
  await page.click(TRIGGER)
  await page.waitForSelector(MENU, { visible: true, timeout: 5_000 })
  const bounds = await page.$eval(MENU, (element) => {
    const rect = element.getBoundingClientRect()
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }
  })
  assert(bounds.left >= 0 && bounds.right <= bounds.viewportWidth,
    `Project picker overflowed horizontally at ${viewport.width}: ${JSON.stringify(bounds)}`)
  assert(bounds.top >= 0 && bounds.bottom <= bounds.viewportHeight,
    `Project picker overflowed vertically at ${viewport.width}: ${JSON.stringify(bounds)}`)

  const optionLayout = await page.$eval(`${MENU} [role="option"]`, (element) => {
    const option = element.getBoundingClientRect()
    const label = element.querySelector('span')?.getBoundingClientRect()
    return {
      optionRight: option.right,
      menuRight: element.parentElement?.getBoundingClientRect().right ?? 0,
      labelRight: label?.right ?? 0,
      optionScrollWidth: element.scrollWidth,
      optionClientWidth: element.clientWidth
    }
  })
  assert(optionLayout.optionRight <= optionLayout.menuRight + 1 &&
    optionLayout.labelRight <= optionLayout.optionRight + 1 &&
    optionLayout.optionScrollWidth <= optionLayout.optionClientWidth + 1,
  `Long project name escaped the bounded picker at ${viewport.width}: ${JSON.stringify(optionLayout)}`)
  await screenshot(page, `project-picker-${viewport.width}`)

  await page.keyboard.press('End')
  await page.keyboard.press('Home')
  const activeOption = await page.evaluate(() => document.activeElement?.getAttribute('data-project-workspace-option'))
  assert(activeOption, `Project picker did not move focus to an option at ${viewport.width}`)
  await page.keyboard.press('Escape')
  await page.waitForSelector(MENU, { hidden: true, timeout: 5_000 })
  const triggerFocused = await page.evaluate(() => document.activeElement?.hasAttribute('data-project-workspace-select-trigger'))
  assert(triggerFocused, `Project picker did not restore trigger focus at ${viewport.width}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
