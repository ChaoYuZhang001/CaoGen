import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')

export async function focusElectronPage(page, focusSession) {
  await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.bringToFront()
}

export async function waitForOfficeRenderLoop(page, timeout = 8_000) {
  let lastState = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    lastState = await page.evaluate(() => {
      const wrap = document.querySelector('.office-canvas-wrap')
      return {
        hidden: document.hidden,
        focused: document.hasFocus(),
        renderActive: wrap?.getAttribute('data-office-render-active') ?? '',
        frameLoop: wrap?.getAttribute('data-office-frame-loop') ?? ''
      }
    })
    if (!lastState.hidden && lastState.focused && lastState.renderActive === '1' && lastState.frameLoop === 'manual') {
      return lastState
    }
    await delay(100)
  }
  throw new Error(`focused office render loop did not become active: ${JSON.stringify(lastState)}`)
}

export async function waitForOfficeScenePixels(page, timeout = 15_000) {
  let lastStats = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const canvas = await readCanvasState(page)
    if (canvas.gl && canvas.width >= 100 && canvas.height >= 100 && canvas.rectWidth >= 300 && canvas.rectHeight >= 200) {
      const png = PNG.sync.read(await page.screenshot({ fullPage: false }))
      const scene = analyzeRobotWorkArea(png)
      lastStats = { ...canvas, screenshotWidth: png.width, screenshotHeight: png.height, ...scene }
      if (scene.uniqueColorBuckets >= 20 && scene.luminanceRange >= 24) return lastStats
    } else {
      lastStats = canvas
    }
    await delay(300)
  }
  throw new Error(`3D office canvas did not become visibly nonblank: ${JSON.stringify(lastStats)}`)
}

async function readCanvasState(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.office canvas')
    if (!canvas) return { canvas: false, gl: false, width: 0, height: 0, rectWidth: 0, rectHeight: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      canvas: true,
      gl: Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl')),
      width: canvas.width,
      height: canvas.height,
      rectWidth: rect.width,
      rectHeight: rect.height
    }
  })
}

function analyzeRobotWorkArea(png) {
  const x0 = Math.floor(png.width * 0.25)
  const x1 = Math.floor(png.width * 0.73)
  const y0 = Math.floor(png.height * 0.32)
  const y1 = Math.floor(png.height * 0.82)
  const buckets = new Set()
  let minimumLuminance = 255
  let maximumLuminance = 0
  let samples = 0
  for (let y = y0; y < y1; y += 4) {
    for (let x = x0; x < x1; x += 4) {
      const offset = (y * png.width + x) * 4
      const r = png.data[offset]
      const g = png.data[offset + 1]
      const b = png.data[offset + 2]
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722
      minimumLuminance = Math.min(minimumLuminance, luminance)
      maximumLuminance = Math.max(maximumLuminance, luminance)
      buckets.add(`${r >> 4},${g >> 4},${b >> 4}`)
      samples += 1
    }
  }
  return {
    samples,
    uniqueColorBuckets: buckets.size,
    luminanceRange: maximumLuminance - minimumLuminance
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
