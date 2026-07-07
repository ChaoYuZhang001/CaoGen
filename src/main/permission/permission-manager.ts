import { updateSettings } from '../settings'
import { isGuiToolName } from '../agent/tools/gui-tools'
import type { AppSettings } from '../../shared/types'

export const GUI_TEMPORARY_GRANT_MESSAGE = 'gui-temporary-grant:5m'
const GUI_TEMPORARY_GRANT_MS = 5 * 60 * 1000

export type GuiPermissionDecision =
  | { kind: 'not-gui' }
  | { kind: 'allow'; reason: string }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string }

export function decideGuiPermission(toolName: string, settings: AppSettings): GuiPermissionDecision {
  if (!isGuiToolName(toolName)) return { kind: 'not-gui' }
  if (!settings.guiAutomationEnabled) {
    return {
      kind: 'deny',
      reason: 'GUI 自动化默认关闭。请先在设置 > 权限中启用 GUI 自动化。'
    }
  }
  if (hasActiveGuiTemporaryGrant(settings)) {
    return {
      kind: 'allow',
      reason: 'GUI 临时授权仍在有效期内。'
    }
  }
  return {
    kind: 'ask',
    reason: '高风险 GUI 自动化: 该工具会操作真实桌面应用,需要用户逐次审批。'
  }
}

export function hasActiveGuiTemporaryGrant(settings: AppSettings, now = Date.now()): boolean {
  return (
    typeof settings.guiAutomationTemporaryGrantUntil === 'number' &&
    settings.guiAutomationTemporaryGrantUntil > now
  )
}

export function grantTemporaryGuiAutomation(now = Date.now()): AppSettings {
  return updateSettings({
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: now + GUI_TEMPORARY_GRANT_MS
  })
}
