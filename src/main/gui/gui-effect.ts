import type { EffectTarget } from '../../shared/types'
import { confirmed, unresolved, type EffectReconciliationResult } from '../task/effect-reconciliation-result'
import {
  normalizeGuiPostcondition,
  verifyGuiPostcondition,
  type GuiPostcondition,
  type GuiPostconditionObserver
} from './gui-postcondition'
import { macosListWindows } from './macos-controller'
import { windowsListWindows } from './windows-controller'

const GUI_MUTATION_TOOLS = new Set([
  'gui_activate_window',
  'gui_click',
  'gui_type',
  'gui_scroll',
  'gui_hotkey'
])

export type GuiPostconditionEffectTarget = Extract<EffectTarget, { kind: 'gui_postcondition' }>

interface GuiEffectRuntimeOptions {
  platform?: NodeJS.Platform
  observe?: GuiPostconditionObserver
}

export async function buildGuiPostconditionEffectTarget(
  toolName: string,
  toolInput: Record<string, unknown>,
  options: GuiEffectRuntimeOptions = {}
): Promise<GuiPostconditionEffectTarget | undefined> {
  if (!GUI_MUTATION_TOOLS.has(toolName)) return undefined
  const postcondition = normalizeGuiPostcondition(toolInput.postcondition)
  const platform = options.platform ?? process.platform
  if (!postcondition || !isQueryablePostcondition(postcondition, toolInput, platform)) return undefined
  let observationSucceeded = false
  const observe = options.observe ?? platformObserver(platform)
  const verification = await verifyGuiPostcondition(async (input) => {
    const result = await observe(input)
    observationSucceeded = result.ok
    return result
  }, { ...postcondition, timeoutMs: 0, intervalMs: 50 })
  if (!observationSucceeded || verification.status === 'passed') return undefined
  return {
    kind: 'gui_postcondition',
    platform: platform as 'win32' | 'darwin',
    toolName: toolName as GuiPostconditionEffectTarget['toolName'],
    postcondition: {
      kind: postcondition.kind as 'window' | 'element',
      state: postcondition.state as GuiPostconditionEffectTarget['postcondition']['state'],
      windowId: postcondition.windowId!,
      ...(postcondition.elementId ? { elementId: postcondition.elementId } : {}),
      ...(postcondition.maxElements ? { maxElements: postcondition.maxElements } : {})
    },
    preconditionSatisfied: false
  }
}

export async function reconcileGuiPostconditionEffectTarget(
  target: GuiPostconditionEffectTarget,
  options: GuiEffectRuntimeOptions = {}
): Promise<EffectReconciliationResult> {
  const platform = options.platform ?? process.platform
  if (platform !== target.platform) {
    return unresolved({
      kind: target.kind,
      platform,
      expectedPlatform: target.platform,
      reason: 'GUI Effect 只能在创建它的操作系统平台执行只读对账'
    })
  }
  const condition = normalizeGuiPostcondition({
    ...target.postcondition,
    timeoutMs: 0,
    intervalMs: 50
  })!
  const verification = await verifyGuiPostcondition(
    options.observe ?? platformObserver(platform),
    condition
  )
  const evidence = {
    kind: target.kind,
    platform: target.platform,
    toolName: target.toolName,
    postcondition: target.postcondition,
    status: verification.status,
    observedWindowCount: verification.observed.windowCount,
    observedElementCount: verification.observed.elementCount
  }
  return verification.status === 'passed'
    ? confirmed(evidence, 'GUI 动作前尚未成立的精确后置条件现已成立，可确认副作用已发生')
    : unresolved({ ...evidence, reason: verification.error ?? 'GUI 精确后置条件仍未成立，禁止自动重放' })
}

function isQueryablePostcondition(
  postcondition: GuiPostcondition,
  toolInput: Record<string, unknown>,
  platform: NodeJS.Platform
): boolean {
  if (platform !== 'win32' && platform !== 'darwin') return false
  if (postcondition.kind === 'visual' || !postcondition.windowId) return false
  if (toolInput.windowId !== postcondition.windowId) return false
  if (!windowIdMatchesPlatform(postcondition.windowId, platform)) return false
  if (postcondition.kind === 'element' && !postcondition.elementId) return false
  return !hasFuzzySelectors(postcondition)
}

function hasFuzzySelectors(postcondition: GuiPostcondition): boolean {
  return Boolean(
    postcondition.title || postcondition.processName || postcondition.pid !== undefined ||
    postcondition.elementName || postcondition.automationId || postcondition.className ||
    postcondition.controlType || postcondition.elementIndex !== undefined || postcondition.sourceId
  )
}

function windowIdMatchesPlatform(windowId: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? /^win32:\d+$/.test(windowId)
    : /^darwin:\d+:\d+$/.test(windowId)
}

function platformObserver(platform: NodeJS.Platform): GuiPostconditionObserver {
  if (platform === 'win32') return (input) => windowsListWindows(input)
  if (platform === 'darwin') return (input) => macosListWindows(input)
  return async () => ({ ok: false, windows: [], error: `平台 ${platform} 不支持 GUI Effect 对账` })
}
