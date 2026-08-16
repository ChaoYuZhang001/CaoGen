#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const electronBin = require('electron')
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/gu, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'i18n-layout')
const reportDir = path.join(reportRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-i18n-layout-'))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const combinations = [
  { language: 'zh', theme: 'light' },
  { language: 'zh', theme: 'dark' },
  { language: 'en', theme: 'light' },
  { language: 'en', theme: 'dark' }
]
const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 }
]
const report = {
  schemaVersion: 1,
  status: 'failed',
  gate: 'test:i18n-layout:required',
  runId,
  startedAt,
  combinations: [],
  screenshots: [],
  errors: []
}
let electron
let browser
let page

mkdirSync(reportDir, { recursive: true })

try {
  const port = await findFreePort(10_110)
  electron = launchElectron(port)
  await waitForDebugPort(port, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
  page = await waitForPage(browser, 20_000)
  await waitForApp(page)
  await createLongestStringFixture(page)

  for (const viewport of viewports) {
    for (const combination of combinations) {
      const result = { ...viewport, ...combination, surfaces: [] }
      await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 })
      await applyPresentation(page, combination)
      await assertExperienceSwitcher(page, combination)

      await selectExperience(page, 'assistant')
      result.surfaces.push(await auditSurface(page, result, 'assistant', '.app'))

      await selectExperience(page, 'studio')
      await page.waitForSelector('[data-project-workspace-studio]', { visible: true, timeout: 15_000 })
      await page.waitForFunction(
        () => document.querySelector('[data-project-workspace-studio]')?.textContent?.includes('LONG-TITLE-END'),
        { timeout: 15_000 }
      )
      result.surfaces.push(await auditSurface(page, result, 'studio', '[data-project-workspace-studio]'))

      await selectExperience(page, 'video')
      result.surfaces.push(await auditSurface(page, result, 'video', '[data-video-studio-view]'))

      await openSettings(page)
      result.surfaces.push(await auditSurface(page, result, 'settings', '.settings-page'))
      await closeSettings(page)
      report.combinations.push(result)
    }
  }

  assert.equal(report.combinations.length, combinations.length * viewports.length)
  assert.ok(report.combinations.every((entry) => entry.surfaces.length === 4))
  report.status = 'passed'
} catch (error) {
  report.errors.push(serializeError(error))
  if (page) await capture(page, 'failure').catch(() => undefined)
  console.error(error)
  process.exitCode = 1
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  if (electron) await terminate(electron)
  report.finishedAt = new Date().toISOString()
  report.git = gitIdentity()
  writeReport()
  rmSync(tempRoot, { recursive: true, force: true })
  console.log(`i18n layout required gate: ${report.status} (${report.combinations.length}/8 combinations)`)
}

async function createLongestStringFixture(targetPage) {
  await targetPage.evaluate(async () => {
    const projectId = 'i18n-layout-project'
    const projectName = '全球多语言智能工作流交付与恢复验证项目 Worldwide multilingual workflow delivery and recovery verification project LONG-PROJECT-END'
    const title = '跨语言超长工作项标题 Worldwide multilingual work item title covering approval recovery delivery and evidence LONG-TITLE-END'
    await window.agentDesk.createProjectWorkspace({ id: projectId, name: projectName, kind: 'software' })
    const goal = await window.agentDesk.createProjectGoal({
      id: 'i18n-layout-goal',
      projectId,
      title: '跨语言端到端目标 Worldwide end-to-end goal LONG-GOAL-END',
      objective: '在不裁切关键操作的情况下完成超长中英文内容展示，并保持桌面与移动端所有控制可用。',
      background: 'Verify Chinese and English content across desktop and mobile layouts without overlap or viewport overflow.',
      constraints: ['Preserve canonical identity', 'No clipped primary controls'],
      successCriteria: ['All eight presentation combinations remain operable'],
      acceptance: [
        { id: 'layout-overlap', criterion: 'Zero incoherent overlap', required: true },
        { id: 'layout-overflow', criterion: 'Zero document horizontal overflow', required: true }
      ]
    })
    await window.agentDesk.createProjectWorkItem({
      id: 'i18n-layout-work-item',
      projectId,
      goalId: goal.id,
      type: 'review',
      title,
      description: '这是用于验证最长字符串布局的说明。 This description deliberately combines long Chinese and English copy to exercise wrapping.',
      status: 'waiting_approval',
      owner: {
        type: 'human',
        id: 'i18n-layout-owner',
        displayName: '超长负责人名称 Long multilingual owner display name'
      }
    })
  })
}

async function applyPresentation(targetPage, combination) {
  await targetPage.evaluate((patch) => window.agentDesk.updateSettings(patch), combination)
  await targetPage.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await waitForApp(targetPage)
  await targetPage.waitForFunction(
    ({ language, theme }) => {
      const actualTheme = document.documentElement.getAttribute('data-theme')
      const settingsLabel = [...document.querySelectorAll('.sidebar-footer button span')]
        .map((node) => node.textContent?.trim())
      const expectedLabel = language === 'zh' ? '设置' : 'Settings'
      return actualTheme === theme && settingsLabel.includes(expectedLabel)
    },
    { timeout: 15_000 },
    combination
  )
  await dismissTransientOverlays(targetPage)
  await waitForSidebarSettled(targetPage)
}

async function assertExperienceSwitcher(targetPage, combination) {
  const options = await targetPage.$$eval(
    '[data-experience-mode-switcher] [data-experience-mode-option]',
    (buttons) => buttons.map((button) => ({
      mode: button.getAttribute('data-experience-mode-option'),
      label: button.textContent?.trim() ?? ''
    }))
  )
  const expectedLabels = combination.language === 'zh'
    ? ['助手', '项目工作台', '视频工作室']
    : ['Assistant', 'Projects', 'Video']
  assert.deepEqual(options.map((option) => option.mode), ['assistant', 'studio', 'video'],
    `${combination.language}/${combination.theme} experience switcher lost an entry`)
  assert.deepEqual(options.map((option) => option.label), expectedLabels,
    `${combination.language}/${combination.theme} experience switcher labels drifted`)
}

async function selectExperience(targetPage, mode) {
  const selector = `[data-experience-mode-option="${mode}"]`
  const current = await targetPage.$eval(selector, (button) => button.getAttribute('aria-pressed') === 'true')
  if (!current) {
    const clickable = await targetPage.$eval(selector, (button) => {
      const rect = button.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth
    })
    if (!clickable) {
      await targetPage.click('.mobile-sidebar-toggle')
      await targetPage.waitForSelector('.sidebar-mobile-open', { visible: true, timeout: 5_000 })
    }
    await targetPage.$eval(selector, (button) => button.click())
  }
  await targetPage.waitForFunction(
    (targetMode) => document.querySelector(`[data-experience-mode-option="${targetMode}"]`)?.getAttribute('aria-pressed') === 'true',
    { timeout: 10_000 },
    mode
  )
  const backdrop = await targetPage.$('.mobile-sidebar-backdrop')
  if (backdrop) {
    await targetPage.$eval('.mobile-sidebar-backdrop', (button) => button.click())
    await targetPage.waitForFunction(
      () => !document.querySelector('.sidebar')?.classList.contains('sidebar-mobile-open'),
      { timeout: 5_000 }
    )
    await waitForSidebarSettled(targetPage)
  }
}

async function waitForSidebarSettled(targetPage) {
  await targetPage.waitForFunction(() => {
    const sidebar = document.querySelector('.sidebar')
    if (!(sidebar instanceof HTMLElement) || window.innerWidth > 680) return true
    const rect = sidebar.getBoundingClientRect()
    return sidebar.classList.contains('sidebar-mobile-open') ? rect.left >= -1 : rect.right <= 1
  }, { timeout: 5_000 })
}

async function openSettings(targetPage) {
  const selector = '.sidebar-footer .sidebar-nav-item'
  const visible = await targetPage.$eval(selector, (node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth
  })
  if (visible) await targetPage.click(selector)
  else {
    await targetPage.click('.mobile-sidebar-toggle')
    await targetPage.waitForSelector('.sidebar-mobile-open', { visible: true, timeout: 5_000 })
    await targetPage.$eval(selector, (button) => button.click())
  }
  await targetPage.waitForSelector('.settings-page', { visible: true, timeout: 10_000 })
}

async function closeSettings(targetPage) {
  await targetPage.click('.settings-page-back')
  await targetPage.waitForSelector('.settings-page', { hidden: true, timeout: 10_000 })
}

async function dismissTransientOverlays(targetPage) {
  const drawer = await targetPage.waitForSelector('.task-recovery-drawer', {
    visible: true,
    timeout: 5_000
  }).catch(() => null)
  if (!drawer) return
  await targetPage.click('.task-recovery-drawer-close')
  await targetPage.waitForSelector('.task-recovery-drawer', { hidden: true, timeout: 5_000 })
}

async function auditSurface(targetPage, combination, name, selector) {
  await targetPage.waitForSelector(selector, { visible: true, timeout: 10_000 })
  const base = await targetPage.evaluate(measureSurfaceRoot, selector)
  const controls = await targetPage.evaluate(measureSurfaceControls, selector)
  const clippedText = await targetPage.evaluate(measureSurfaceText, selector)
  const layout = buildLayoutAudit(base, controls, clippedText)

  assert.ok(layout.controlCount > 0, `${combination.language}/${combination.theme}/${combination.name}/${name} has no controls`)
  assert.ok(layout.documentOverflowX <= 1, `${combination.language}/${combination.theme}/${combination.name}/${name} document overflow ${layout.documentOverflowX}px`)
  assert.ok(layout.rootRect.left >= -1 && layout.rootRect.right <= layout.viewport.width + 1,
    `${combination.language}/${combination.theme}/${combination.name}/${name} root escapes viewport`)
  assert.deepEqual(layout.clippedControls, [], `${combination.language}/${combination.theme}/${combination.name}/${name} controls escape viewport`)
  assert.deepEqual(layout.overlaps, [], `${combination.language}/${combination.theme}/${combination.name}/${name} controls overlap`)
  assert.deepEqual(layout.clippedText, [], `${combination.language}/${combination.theme}/${combination.name}/${name} key text is clipped`)
  const screenshot = await capture(targetPage, `${combination.name}-${combination.language}-${combination.theme}-${name}`)
  return { name, ...layout, screenshot }
}

function measureSurfaceRoot(rootSelector) {
  const root = document.querySelector(rootSelector)
  if (!root) throw new Error(`layout root is missing: ${rootSelector}`)
  const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
  const rect = root.getBoundingClientRect()
  return {
    viewport,
    rootRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
    documentOverflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - viewport.width
  }
}

function measureSurfaceControls(rootSelector) {
  const root = document.querySelector(rootSelector)
  if (!root) throw new Error(`layout root is missing: ${rootSelector}`)
  const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
  const controls = [...root.querySelectorAll('button,input,select,textarea,a[href],[role="button"],[role="tab"]')]
    .filter(isRendered)
    .filter((node) => intersectsViewport(node.getBoundingClientRect()))
  return controls.map((node) => ({
    ...nodeRecord(node),
    ancestorIndexes: controls.flatMap((candidate, index) => candidate !== node && candidate.contains(node) ? [index] : []),
    scrollableClip: hasScrollableClip(node)
  }))

  function isRendered(node) {
    let visibleRect = node.getBoundingClientRect()
    if (!hasArea(visibleRect)) return false
    for (let current = node; current; current = current.parentElement) {
      const style = window.getComputedStyle(current)
      if (styleHides(style)) return false
      if (current === node) continue
      const axes = clipAxes(style)
      if (!axes.x && !axes.y) continue
      const parentRect = current.getBoundingClientRect()
      const intersection = intersect(visibleRect, parentRect)
      if (clipEliminates(intersection, axes)) return false
      visibleRect = clippedRect(visibleRect, parentRect, intersection, axes)
    }
    return true
  }
  function styleHides(style) {
    return [style.display === 'none', style.visibility === 'hidden', Number(style.opacity) === 0,
      style.clip !== 'auto', style.clipPath !== 'none'].some(Boolean)
  }
  function hasArea(rect) {
    return rect.width > 0 && rect.height > 0
  }
  function clipAxes(style) {
    return { x: style.overflowX !== 'visible', y: style.overflowY !== 'visible' }
  }
  function clipEliminates(rect, axes) {
    return [axes.x && rect.width <= 0, axes.y && rect.height <= 0].some(Boolean)
  }
  function clippedRect(rect, parent, intersection, axes) {
    return {
      left: axes.x ? Math.max(rect.left, parent.left) : rect.left,
      right: axes.x ? Math.min(rect.right, parent.right) : rect.right,
      top: axes.y ? Math.max(rect.top, parent.top) : rect.top,
      bottom: axes.y ? Math.min(rect.bottom, parent.bottom) : rect.bottom,
      width: axes.x ? intersection.width : rect.width,
      height: axes.y ? intersection.height : rect.height
    }
  }
  function intersectsViewport(rect) {
    return [rect.right > 0, rect.bottom > 0, rect.left < viewport.width, rect.top < viewport.height].every(Boolean)
  }
  function hasScrollableClip(node) {
    for (let current = node.parentElement; current && current !== root; current = current.parentElement) {
      const style = window.getComputedStyle(current)
      const scrollsX = ['auto', 'scroll'].includes(style.overflowX) && current.scrollWidth > current.clientWidth
      const scrollsY = ['auto', 'scroll'].includes(style.overflowY) && current.scrollHeight > current.clientHeight
      if (scrollsX || scrollsY) return true
    }
    return false
  }
  function intersect(left, right) {
    const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
    return { width, height }
  }
  function nodeRecord(node) {
    const rect = node.getBoundingClientRect()
    return {
      tag: node.tagName.toLowerCase(),
      className: typeof node.className === 'string' ? node.className : '',
      text: String(node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 160),
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
  }
}

function measureSurfaceText(rootSelector) {
  const root = document.querySelector(rootSelector)
  if (!root) throw new Error(`layout root is missing: ${rootSelector}`)
  const selectors = [
    'button', '.sidebar-nav-item span', '.settings-page-title', '.settings-nav-item span',
    '.pws-heading h1', '.pws-row-title strong', '.pws-board-item-head strong',
    '.pws-project-controls', '.pws-section-actions', 'label'
  ]
  const nodes = [...new Set(selectors.flatMap((candidate) => [...root.querySelectorAll(candidate)]))]
  return nodes.filter(isRendered).filter(hasText).filter(isClipped).map(nodeRecord)

  function isRendered(node) {
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    for (let current = node; current; current = current.parentElement) {
      const style = window.getComputedStyle(current)
      if ([style.display === 'none', style.visibility === 'hidden', Number(style.opacity) === 0,
        style.clip !== 'auto', style.clipPath !== 'none'].some(Boolean)) return false
    }
    return true
  }
  function hasText(node) {
    return String(node.textContent ?? '').trim().length > 0
  }
  function isClipped(node) {
    const style = window.getComputedStyle(node)
    const horizontal = node.scrollWidth > node.clientWidth + 1.5 &&
      ['hidden', 'ellipsis'].includes(style.overflowX === 'hidden' ? 'hidden' : style.textOverflow)
    const vertical = node.scrollHeight > node.clientHeight + 1.5 && style.overflowY === 'hidden'
    return horizontal || vertical
  }
  function nodeRecord(node) {
    const rect = node.getBoundingClientRect()
    return {
      tag: node.tagName.toLowerCase(),
      className: typeof node.className === 'string' ? node.className : '',
      text: String(node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 160),
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
  }
}

function buildLayoutAudit(base, controls, clippedText) {
  const clippedControls = controls
    .filter((control) => !insideViewportHorizontally(control.rect, base.viewport, 1.5) && !control.scrollableClip)
    .map(publicControlRecord)
  const overlaps = []
  for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
      const left = controls[leftIndex]
      const right = controls[rightIndex]
      if (left.ancestorIndexes.includes(rightIndex) || right.ancestorIndexes.includes(leftIndex)) continue
      const intersection = intersect(left.rect, right.rect)
      if (intersection.width > 2 && intersection.height > 2 && intersection.area > 16) {
        overlaps.push({ left: publicControlRecord(left), right: publicControlRecord(right), intersection })
      }
    }
  }
  return { ...base, controlCount: controls.length, clippedControls, overlaps, clippedText }
}

function publicControlRecord({ ancestorIndexes: _ancestorIndexes, scrollableClip: _scrollableClip, ...control }) {
  return control
}

function insideViewportHorizontally(rect, viewport, tolerance) {
  return rect.left >= -tolerance && rect.right <= viewport.width + tolerance
}

function intersect(left, right) {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
  return { width, height, area: width * height }
}

function launchElectron(port) {
  const child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: path.join(tempRoot, 'user-data'),
      CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim()
    if (message && !message.includes('DevTools listening')) report.errors.push({ name: 'ElectronStderr', message })
  })
  return child
}

async function capture(targetPage, name) {
  const file = path.join(reportDir, `${name}.png`)
  await targetPage.screenshot({ path: file })
  report.screenshots.push(file)
  return file
}

async function waitForApp(targetPage) {
  await targetPage.waitForFunction(
    () => document.readyState === 'complete' && document.querySelector('#root')?.childElementCount > 0 &&
      Boolean(document.querySelector('.app')),
    { timeout: 20_000 }
  )
}

async function waitForPage(targetBrowser, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pages = await targetBrowser.pages()
    const candidate = pages.find((entry) => entry.url().startsWith('file:') || entry.url().includes('localhost'))
    if (candidate) return candidate
    await delay(100)
  }
  throw new Error('renderer page did not appear')
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await canListen(port)) return port
  }
  throw new Error('no free remote debugging port')
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function waitForDebugPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canConnect(port)) return
    await delay(100)
  }
  throw new Error(`remote debugging port ${port} did not open`)
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

async function terminate(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function gitIdentity() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  return { commit, worktreeClean: status.length === 0 }
}

function writeReport() {
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
}

function serializeError(error) {
  return { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.stack || error.message : String(error) }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
