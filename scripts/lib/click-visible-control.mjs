export async function clickVisibleControl(page, selector, timeoutMs = 8_000) {
  await page.waitForFunction((targetSelector) => {
    const candidates = [...document.querySelectorAll(targetSelector)]
    return candidates.some((element) => {
      if (!(element instanceof HTMLElement)) return false
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none' || rect.width === 0 || rect.height === 0) return false
      const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return center === element || element.contains(center)
    })
  }, { timeout: timeoutMs }, selector)
  const handles = await page.$$(selector)
  for (const handle of handles) {
    const clickable = await handle.evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none' || rect.width === 0 || rect.height === 0) return false
      const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return center === element || element.contains(center)
    })
    if (clickable) {
      await handle.click()
      return
    }
  }
  throw new Error(`no visible unobscured control matched ${selector}`)
}
