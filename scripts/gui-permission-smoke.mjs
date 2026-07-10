#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'gui-permission')
const reportDir = path.join(reportRoot, runId)
const guiToolNames = [
  'gui_list_windows',
  'gui_activate_window',
  'gui_screenshot',
  'gui_click',
  'gui_type',
  'gui_scroll',
  'gui_hotkey'
]

const checks = []
let lastSettingsPatch = null

function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (err) {
    checks.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function evaluatePermissionManager() {
  const input = source('src/main/permission/permission-manager.ts')
  const output = ts.transpileModule(input, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText

  const module = { exports: {} }
  const localRequire = (specifier) => {
    if (specifier === '../settings') {
      return {
        updateSettings(patch) {
          lastSettingsPatch = patch
          return patch
        }
      }
    }
    if (specifier === '../agent/tools/gui-tools') {
      return {
        isGuiToolName(name) {
          return guiToolNames.includes(name)
        }
      }
    }
    throw new Error(`unexpected require: ${specifier}`)
  }
  new Function('require', 'module', 'exports', output)(localRequire, module, module.exports)
  return module.exports
}

function evaluatePermissionInputFormatter() {
  const input = source('src/renderer/src/components/PermissionBar.tsx')
  const output = ts.transpileModule(input, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
  const module = { exports: {} }
  const localRequire = (specifier) => {
    if (specifier === '../store') return { useStore: () => () => undefined }
    if (specifier === '../i18n') return { useT: () => (key) => key }
    if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }
    throw new Error(`unexpected require: ${specifier}`)
  }
  new Function('require', 'module', 'exports', output)(localRequire, module, module.exports)
  return module.exports.formatPermissionInput
}

const permissionManager = evaluatePermissionManager()
const formatPermissionInput = evaluatePermissionInputFormatter()

check('permission manager denies gui tools when disabled by default', () => {
  const decision = permissionManager.decideGuiPermission('gui_click', {
    guiAutomationEnabled: false,
    guiAutomationTemporaryGrantUntil: 0
  })
  assert(decision.kind === 'deny', `expected deny, got ${JSON.stringify(decision)}`)
})

check('permission manager asks when enabled without temporary grant', () => {
  const decision = permissionManager.decideGuiPermission('gui_type', {
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: 0
  })
  assert(decision.kind === 'ask', `expected ask, got ${JSON.stringify(decision)}`)
})

check('permission manager allows active 5 minute temporary grant', () => {
  const now = Date.now()
  const decision = permissionManager.decideGuiPermission('gui_hotkey', {
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: now + 1_000
  })
  assert(decision.kind === 'allow', `expected allow, got ${JSON.stringify(decision)}`)
})

check('permission manager expires temporary grant at exact boundary', () => {
  const now = Date.now()
  const decision = permissionManager.decideGuiPermission('gui_click', {
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: now
  })
  assert(decision.kind === 'ask', `expected ask at boundary, got ${JSON.stringify(decision)}`)
})

check('permission manager rejects expired temporary grant', () => {
  const now = Date.now()
  const decision = permissionManager.decideGuiPermission('gui_type', {
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: now - 1
  })
  assert(decision.kind === 'ask', `expected ask after expiry, got ${JSON.stringify(decision)}`)
})

check('permission manager ignores non-gui tools', () => {
  const decision = permissionManager.decideGuiPermission('bash', {
    guiAutomationEnabled: false,
    guiAutomationTemporaryGrantUntil: 0
  })
  assert(decision.kind === 'not-gui', `expected not-gui, got ${JSON.stringify(decision)}`)
})

check('temporary grant writes enabled flag and 5 minute expiry', () => {
  lastSettingsPatch = null
  permissionManager.grantTemporaryGuiAutomation(1_000)
  assert(lastSettingsPatch?.guiAutomationEnabled === true, 'temporary grant must enable guiAutomationEnabled')
  assert(
    lastSettingsPatch?.guiAutomationTemporaryGrantUntil === 301_000,
    `expected expiry 301000, got ${lastSettingsPatch?.guiAutomationTemporaryGrantUntil}`
  )
})

check('openai tool schema exposes all gui tools', () => {
  const text = source('src/main/openaiTools.ts')
  const guiTools = source('src/main/agent/tools/gui-tools.ts')
  assert(text.includes('...GUI_TOOLS'), 'OPENAI_CODING_TOOLS must include GUI_TOOLS')
  assert(text.includes('isGuiToolName(name)'), 'executeCodingTool must branch on isGuiToolName')
  const branch = text.indexOf('if (isGuiToolName(name))')
  const switchPos = text.indexOf('switch (name)', branch)
  assert(branch !== -1 && switchPos !== -1 && branch < switchPos, 'GUI dispatch must happen before the normal tool switch')
  for (const name of guiToolNames) {
    assert(guiTools.includes(`'${name}'`), `missing GUI tool ${name}`)
  }
  assert(guiTools.includes('includeOcr'), 'gui_screenshot must expose includeOcr for screenshot recognition fallback')
  assert(
    source('src/main/gui/gui-controller.ts').includes('ocrImage(outPath)'),
    'gui controller must call OCR when includeOcr is requested'
  )
})

check('gui tools are not accidentally read-only or edit auto-allow tools', () => {
  const text = source('src/main/openaiTools.ts')
  const readonlyStart = text.indexOf('export const READONLY_TOOLS')
  const editStart = text.indexOf('export const EDIT_TOOLS')
  const readonlyBlock = text.slice(readonlyStart, editStart)
  const editBlock = text.slice(editStart, text.indexOf('export const RESPONSES_CODING_TOOLS'))
  for (const name of guiToolNames) {
    assert(!readonlyBlock.includes(name), `${name} must not be READONLY`)
    assert(!editBlock.includes(name), `${name} must not be EDIT auto-allow`)
  }
})

check('openai gate evaluates gui permission before bypassPermissions', () => {
  const text = source('src/main/openaiEngine.ts')
  const gateStart = text.indexOf('private async gateTool')
  const guiDecision = text.indexOf('decideGuiPermission(name,', gateStart)
  const bypass = text.indexOf("mode === 'bypassPermissions'", gateStart)
  assert(gateStart !== -1 && guiDecision !== -1 && bypass !== -1, 'gateTool markers not found')
  assert(guiDecision < bypass, 'GUI decision must run before bypassPermissions check')
})

check('claude gate evaluates gui permission before bypassPermissions', () => {
  const text = source('src/main/agentSession.ts')
  const gateStart = text.indexOf('private requestPermission')
  const guiDecision = text.indexOf('decideGuiPermission(policyToolName,', gateStart)
  const bypass = text.indexOf("this.meta.permissionMode === 'bypassPermissions'", gateStart)
  assert(gateStart !== -1 && guiDecision !== -1 && bypass !== -1, 'Claude permission markers not found')
  assert(guiDecision < bypass, 'Claude GUI decision must run before bypassPermissions check')
})

check('openai gate evaluates policy denylist before gui permission allow or ask', () => {
  const text = source('src/main/openaiEngine.ts')
  const gateStart = text.indexOf('private async gateTool')
  const policy = text.indexOf('const policy = evaluateToolPermission', gateStart)
  const policyDeny = text.indexOf("policy.kind === 'deny'", policy)
  const guiDecision = text.indexOf('decideGuiPermission(name,', gateStart)
  assert(policy !== -1 && policyDeny !== -1 && guiDecision !== -1, 'gateTool policy/gui markers not found')
  assert(policy < guiDecision && policyDeny < guiDecision, 'policy denylist must run before GUI allow/ask path')
})

check('openai gui gate decisions are audit logged', () => {
  const text = source('src/main/openaiEngine.ts')
  const gateStart = text.indexOf('private async gateTool')
  const guiDecision = text.indexOf('const guiDecision = decideGuiPermission', gateStart)
  const guiBlock = text.slice(guiDecision, text.indexOf("if (policy.kind === 'allow')", guiDecision))
  assert(guiBlock.includes("this.auditGateDecision('deny'"), 'OpenAI GUI deny decision must be audited')
  assert(guiBlock.includes("this.auditGateDecision('allow'"), 'OpenAI GUI allow decision must be audited')
  assert(guiBlock.includes("this.auditGateDecision('ask'"), 'OpenAI GUI ask decision must be audited')
})

check('permission policy classifies browser_navigate file URLs as paths', () => {
  const text = source('src/main/permission/tool-permission.ts')
  const browserBranch = text.indexOf("toolName === 'browser_navigate'")
  const fileUrlPath = text.indexOf('extractFileUrlPath(input.url)', browserBranch)
  const fileUrlToPath = text.indexOf('fileURLToPath(url)')
  assert(browserBranch !== -1 && fileUrlPath !== -1, 'browser_navigate must extract path from file:// URL')
  assert(fileUrlToPath !== -1, 'file:// URL extraction must use fileURLToPath')
})

check('openai permission response grants temporary gui authorization only via message token', () => {
  const text = source('src/main/openaiEngine.ts')
  const token = text.indexOf('message === GUI_TEMPORARY_GRANT_MESSAGE')
  const guiPending = text.indexOf("pending.info.toolName.startsWith('gui_')", token)
  const grant = text.indexOf('grantTemporaryGuiAutomation()', token)
  assert(token !== -1 && grant !== -1, 'respondPermission must honor GUI_TEMPORARY_GRANT_MESSAGE')
  assert(guiPending !== -1 && guiPending < grant, 'temporary GUI grant token must be scoped to pending gui_* tool')
})

check('claude permission response grants temporary gui authorization only via message token', () => {
  const text = source('src/main/agentSession.ts')
  const token = text.indexOf('message === GUI_TEMPORARY_GRANT_MESSAGE')
  const guiPending = text.indexOf("normalizeClaudeToolName(pending.info.toolName).startsWith('gui_')", token)
  const grant = text.indexOf('grantTemporaryGuiAutomation()', token)
  assert(token !== -1 && grant !== -1, 'Claude respondPermission must honor GUI_TEMPORARY_GRANT_MESSAGE')
  assert(guiPending !== -1 && guiPending < grant, 'Claude temporary GUI grant token must be scoped to pending gui_* tool')
})

check('settings defaults keep gui automation disabled', () => {
  for (const file of ['src/main/settings.ts', 'src/renderer/src/store.ts']) {
    const text = source(file)
    assert(text.includes('guiAutomationEnabled: false'), `${file} must default guiAutomationEnabled to false`)
    assert(text.includes('guiAutomationTemporaryGrantUntil: 0'), `${file} must default temporary grant to 0`)
  }
  const shared = source('src/shared/types.ts')
  assert(shared.includes('guiAutomationEnabled: boolean'), 'AppSettings must type guiAutomationEnabled')
  assert(shared.includes('guiAutomationTemporaryGrantUntil: number'), 'AppSettings must type temporary grant expiry')
})

check('renderer exposes gui enable switch and scoped temporary allow action', () => {
  const settings = source('src/renderer/src/components/SettingsModal.tsx')
  assert(settings.includes('checked={draft.guiAutomationEnabled}'), 'SettingsModal must expose guiAutomationEnabled')
  assert(settings.includes('guiAutomationTemporaryGrantUntil: e.target.checked'), 'disabling switch must clear grant branch')
  assert(settings.includes(': 0'), 'disabling switch must clear guiAutomationTemporaryGrantUntil to 0')

  const permissionBar = source('src/renderer/src/components/PermissionBar.tsx')
  assert(permissionBar.includes("req.toolName.startsWith('gui_')"), 'temporary allow button must be scoped to gui_* tools')
  assert(permissionBar.includes('GUI_TEMPORARY_GRANT_MESSAGE'), 'temporary allow must send grant token')
})

check('permission card exposes the full executable tail while redacting credential fields', () => {
  const dangerousSuffix = '; rm -rf "$HOME/important"'
  const formatted = formatPermissionInput({
    command: `${'echo safe '.repeat(20)}${dangerousSuffix}`,
    authorization: 'Bearer renderer-secret'
  })
  assert(
    formatted.includes('rm -rf') && formatted.includes('$HOME/important'),
    'permission input must not truncate a dangerous command suffix'
  )
  assert(!formatted.includes('renderer-secret'), 'permission input must redact credential fields')
  const permissionBar = source('src/renderer/src/components/PermissionBar.tsx')
  assert(permissionBar.includes('<pre className="permission-detail"'), 'permission input must render as selectable preformatted text')
  assert(!permissionBar.includes('slice(0, 120)'), 'permission input must not retain the old 120-character truncation')
})

check('renderer refreshes settings after temporary gui grant response', () => {
  const store = source('src/renderer/src/store.ts')
  const respond = store.indexOf('async respondPermission(sessionId, requestId, allow, message)')
  const grantToken = store.indexOf("message === 'gui-temporary-grant:5m'", respond)
  const refresh = store.indexOf('await window.agentDesk.getSettings()', grantToken)
  const setSettings = store.indexOf('set({ settings })', refresh)
  assert(respond !== -1 && grantToken !== -1, 'store respondPermission must detect temporary GUI grant token')
  assert(refresh !== -1 && setSettings !== -1, 'store must refresh settings after temporary GUI grant')
})

const failed = checks.filter((item) => !item.ok)
for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.ok ? '' : `: ${item.error}`}`)
}

const report = {
  status: failed.length === 0 ? 'passed' : 'failed',
  required,
  reportDir,
  runId,
  checks: checks.map((item) => ({
    name: item.name,
    status: item.ok ? 'pass' : 'fail',
    error: item.error
  })),
  failures: failed.map((item) => `${item.name}: ${item.error}`)
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

if (failed.length > 0) {
  process.exitCode = 1
}
