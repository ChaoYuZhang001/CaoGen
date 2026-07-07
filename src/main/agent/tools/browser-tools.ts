import type { ToolDefinition, ToolExecResult } from './tool-types'

export const BROWSER_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: '在当前会话的内置浏览器中打开 URL。需要浏览器面板已经为该会话创建。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '目标 URL' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '点击当前页面中的 CSS selector。',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: '向当前页面中的输入元素填写文本。',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' }, text: { type: 'string' } },
        required: ['selector', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '截取当前内置浏览器页面，可选 CSS selector 裁剪。',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait_for',
      description: '等待当前页面出现 CSS selector。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          timeoutMs: { type: 'number', description: '超时时间，默认 5000ms' }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: '在当前页面执行 JavaScript 表达式并返回 JSON 化结果。',
      parameters: {
        type: 'object',
        properties: { script: { type: 'string' } },
        required: ['script']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_automation_status',
      description: '返回内置浏览器自动化驱动状态，包括 puppeteer-core 是否可加载。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  }
]

const NAMES = new Set(BROWSER_TOOLS.map((tool) => tool.function.name))

export function isBrowserToolName(name: string): boolean {
  return NAMES.has(name)
}

export async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>,
  sessionId?: string
): Promise<ToolExecResult> {
  if (name === 'browser_automation_status') return browserAutomationStatus()
  if (!sessionId) return { ok: false, output: '浏览器工具需要 sessionId。' }
  const { browserViewManager } = await import('../../browser/browser-manager.js')
  switch (name) {
    case 'browser_navigate': {
      const state = await browserViewManager.navigate(sessionId, requireString(args.url, 'url'))
      return { ok: true, output: JSON.stringify(state, null, 2) }
    }
    case 'browser_click': {
      await browserViewManager.click(sessionId, requireString(args.selector, 'selector'))
      return { ok: true, output: `已点击 ${args.selector}` }
    }
    case 'browser_type': {
      await browserViewManager.typeText(sessionId, requireString(args.selector, 'selector'), requireString(args.text, 'text'))
      return { ok: true, output: `已填写 ${args.selector}` }
    }
    case 'browser_screenshot': {
      const path = await browserViewManager.screenshot(
        sessionId,
        typeof args.selector === 'string' && args.selector.trim() ? args.selector : undefined
      )
      return { ok: true, output: path ? `截图已保存: ${path}` : '当前浏览器视图不可截图。' }
    }
    case 'browser_wait_for': {
      await browserViewManager.waitFor(sessionId, requireString(args.selector, 'selector'), numberArg(args.timeoutMs) ?? 5000)
      return { ok: true, output: `已等待到 ${args.selector}` }
    }
    case 'browser_evaluate': {
      const result = await browserViewManager.evaluate(sessionId, requireString(args.script, 'script'))
      return { ok: true, output: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }
    }
    default:
      return { ok: false, output: `未知浏览器工具: ${name}` }
  }
}

async function browserAutomationStatus(): Promise<ToolExecResult> {
  try {
    const puppeteer = await import('puppeteer-core')
    return {
      ok: true,
      output: JSON.stringify({
        driver: 'electron-webcontents',
        chromium: 'electron-bundled',
        puppeteerCoreAvailable: true,
        puppeteerCoreKeys: Object.keys(puppeteer).slice(0, 8)
      }, null, 2)
    }
  } catch (error) {
    return {
      ok: false,
      output: JSON.stringify({
        driver: 'electron-webcontents',
        chromium: 'electron-bundled',
        puppeteerCoreAvailable: false,
        error: error instanceof Error ? error.message : String(error)
      }, null, 2)
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`)
  return value
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
