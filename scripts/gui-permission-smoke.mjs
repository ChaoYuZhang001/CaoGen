#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
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
    if (specifier === 'node:crypto') return { createHash, randomUUID }
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
  const decision = permissionManager.decideGuiPermission('gui_click', { title: 'Editor', x: 10, y: 20 }, {
    guiAutomationEnabled: false,
    guiAutomationTemporaryGrantUntil: 0
  }, { sessionId: 'session-a', cwd: 'D:/project' }, 1_000)
  assert(decision.kind === 'deny', `expected deny, got ${JSON.stringify(decision)}`)
})

check('permission manager offers scoped grant only for a stable target', () => {
  permissionManager.revokeAllGuiAutomationGrants()
  const decision = permissionManager.decideGuiPermission('gui_type', {
    processName: 'editor.exe', automationId: 'prompt', text: 'hello'
  }, {
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: 0
  }, { sessionId: 'session-a', cwd: 'D:/project' }, 1_000)
  assert(decision.kind === 'ask', `expected ask, got ${JSON.stringify(decision)}`)
  assert(decision.temporaryScopeLabel?.includes('editor.exe'), 'stable app target must have a scope label')
})

check('targetless hotkey cannot receive a temporary grant', () => {
  const decision = permissionManager.decideGuiPermission('gui_hotkey', { keys: ['ctrl', 's'] }, {
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: 999_999
  }, { sessionId: 'session-a', cwd: 'D:/project' }, 1_000)
  assert(decision.kind === 'ask', `expected ask, got ${JSON.stringify(decision)}`)
  assert(!decision.temporaryScopeLabel, 'targetless hotkey must not expose temporary grant scope')
})

check('window-bound hotkey can receive an exact temporary grant', () => {
  const decision = permissionManager.decideGuiPermission('gui_hotkey', {
    processName: 'editor.exe', keys: ['ctrl', 's']
  }, {
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: 0
  }, { sessionId: 'session-a', cwd: 'D:/project' }, 1_000)
  assert(decision.kind === 'ask', `expected ask, got ${JSON.stringify(decision)}`)
  assert(decision.temporaryScopeLabel?.includes('editor.exe'), 'window-bound hotkey must expose its exact scope')
})

check('legacy persisted global expiry no longer grants any gui action', () => {
  permissionManager.revokeAllGuiAutomationGrants()
  const decision = permissionManager.decideGuiPermission('gui_click', {
    title: 'Editor', automationId: 'save'
  }, {
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: 999_999
  }, { sessionId: 'session-a', cwd: 'D:/project' }, 1_000)
  assert(decision.kind === 'ask', `legacy global grant must be ignored, got ${JSON.stringify(decision)}`)
})

check('scoped grant matches only exact session project action and input', () => {
  permissionManager.revokeAllGuiAutomationGrants()
  const input = { processName: 'editor.exe', automationId: 'prompt', text: 'hello' }
  const grant = permissionManager.grantTemporaryGuiAutomation('session-a', 'D:/project', 'gui_type', input, 1_000)
  assert(grant.expiresAt === 301_000, `expected 5 minute expiry, got ${grant.expiresAt}`)
  const settings = {
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: 0
  }
  const exact = permissionManager.decideGuiPermission(
    'gui_type', input, settings, { sessionId: 'session-a', cwd: 'D:/project' }, 2_000
  )
  assert(exact.kind === 'allow' && exact.grantId === grant.id, `expected exact allow, got ${JSON.stringify(exact)}`)
  for (const [label, toolName, candidateInput, context] of [
    ['session', 'gui_type', input, { sessionId: 'session-b', cwd: 'D:/project' }],
    ['project', 'gui_type', input, { sessionId: 'session-a', cwd: 'D:/other' }],
    ['action', 'gui_click', input, { sessionId: 'session-a', cwd: 'D:/project' }],
    ['input', 'gui_type', { ...input, text: 'different' }, { sessionId: 'session-a', cwd: 'D:/project' }]
  ]) {
    const decision = permissionManager.decideGuiPermission(toolName, candidateInput, settings, context, 2_000)
    assert(decision.kind === 'ask', `${label} change must require approval, got ${JSON.stringify(decision)}`)
  }
})

check('permission manager ignores non-gui tools', () => {
  const decision = permissionManager.decideGuiPermission('bash', {}, {
    guiAutomationEnabled: false,
    guiAutomationTemporaryGrantUntil: 0
  }, { sessionId: 'session-a', cwd: 'D:/project' }, 1_000)
  assert(decision.kind === 'not-gui', `expected not-gui, got ${JSON.stringify(decision)}`)
})

check('scoped grant expires and is explicitly revocable', () => {
  permissionManager.revokeAllGuiAutomationGrants()
  const input = { title: 'Editor', automationId: 'save' }
  const grant = permissionManager.grantTemporaryGuiAutomation('session-a', 'D:/project', 'gui_click', input, 1_000)
  const settings = { guiAutomationEnabled: true, guiAutomationTemporaryGrantUntil: 0 }
  const expired = permissionManager.decideGuiPermission(
    'gui_click', input, settings, { sessionId: 'session-a', cwd: 'D:/project' }, 301_000
  )
  assert(expired.kind === 'ask', `grant must expire at exact boundary, got ${JSON.stringify(expired)}`)
  const replacement = permissionManager.grantTemporaryGuiAutomation('session-a', 'D:/project', 'gui_click', input, 400_000)
  assert(permissionManager.revokeGuiAutomationGrant(replacement.id), 'explicit revoke must remove the grant')
  assert(permissionManager.listGuiAutomationGrants(400_001).length === 0, 'revoked grant must disappear from the shared view')
  assert(!permissionManager.revokeGuiAutomationGrant(grant.id), 'already expired grant must not be revocable')
})

check('non-GUI capability grant binds exact session project tool and input', () => {
  permissionManager.revokeAllToolCapabilityGrants()
  const input = { file_path: 'src/a.ts', content: 'const value = 1\n' }
  const effectScope = {
    targetKind: 'file_content',
    targetDigest: 'effect-digest-a',
    summary: '文件 src/a.ts -> 1 bytes'
  }
  const scope = permissionManager.temporaryToolGrantScopeLabel('write_file', input, 'medium', effectScope)
  assert(scope?.includes('src/a.ts'), `stable file target must be visible in scope: ${scope}`)
  assert(scope?.includes('输入摘要'), `exact input digest must be visible in scope: ${scope}`)
  const grant = permissionManager.grantTemporaryToolCapability(
    'session-a',
    'D:/project',
    'write_file',
    input,
    'medium',
    effectScope,
    1_000
  )
  assert(grant.kind === 'tool', `expected tool grant kind, got ${JSON.stringify(grant)}`)
  assert(grant.expiresAt === 301_000, `expected five minute expiry, got ${grant.expiresAt}`)
  const exact = permissionManager.decideToolCapabilityPermission(
    'write_file',
    input,
    { sessionId: 'session-a', cwd: 'D:/project', effectTargetDigest: effectScope.targetDigest },
    2_000
  )
  assert(exact.kind === 'allow' && exact.grantId === grant.id, `exact operation must match: ${JSON.stringify(exact)}`)
  const mismatches = [
    permissionManager.decideToolCapabilityPermission('write_file', input, { sessionId: 'session-b', cwd: 'D:/project', effectTargetDigest: effectScope.targetDigest }, 2_000),
    permissionManager.decideToolCapabilityPermission('write_file', input, { sessionId: 'session-a', cwd: 'D:/other', effectTargetDigest: effectScope.targetDigest }, 2_000),
    permissionManager.decideToolCapabilityPermission('edit_file', input, { sessionId: 'session-a', cwd: 'D:/project', effectTargetDigest: effectScope.targetDigest }, 2_000),
    permissionManager.decideToolCapabilityPermission('write_file', { ...input, content: 'changed' }, { sessionId: 'session-a', cwd: 'D:/project', effectTargetDigest: effectScope.targetDigest }, 2_000)
  ]
  assert(mismatches.every((item) => item.kind === 'none'), `scope escaped exact binding: ${JSON.stringify(mismatches)}`)
})

check('non-GUI temporary grants reject unstable and elevated-risk operations', () => {
  assert(
    permissionManager.temporaryToolGrantScopeLabel('bash', { command: 'npm test' }, 'high') === undefined,
    'high-risk shell command must not receive a temporary grant scope'
  )
  assert(
    permissionManager.temporaryToolGrantScopeLabel('mcp_call_tool', { server: 'x', tool: 'write' }, 'medium') === undefined,
    'opaque MCP tool must not receive a temporary grant scope'
  )
  let threw = false
  try {
    permissionManager.grantTemporaryToolCapability(
      'session-a', 'D:/project', 'bash', { command: 'danger' }, 'critical',
      { targetKind: 'file_content', targetDigest: 'effect-digest-danger', summary: '文件 danger' },
      1_000
    )
  } catch {
    threw = true
  }
  assert(threw, 'critical command grant creation must fail closed')
})

check('non-GUI capability grants expire revoke and close by session', () => {
  permissionManager.revokeAllToolCapabilityGrants()
  const effectScope = { targetKind: 'file_content', targetDigest: 'effect-digest-b', summary: '文件 src/a.ts' }
  const first = permissionManager.grantTemporaryToolCapability(
    'session-a', 'D:/project', 'bash', { command: 'npm test' }, 'medium', effectScope, 10_000
  )
  permissionManager.grantTemporaryToolCapability(
    'session-b', 'D:/project', 'git_commit', { message: 'test' }, 'medium', effectScope, 10_000
  )
  assert(permissionManager.revokeToolCapabilityGrantsForSession('session-a') === 1, 'session close must revoke its exact grants')
  assert(!permissionManager.revokeToolCapabilityGrant(first.id), 'session-revoked grant must no longer exist')
  const remaining = permissionManager.listToolCapabilityGrants(10_001)
  assert(remaining.length === 1 && remaining[0].sessionId === 'session-b', `wrong remaining grants: ${JSON.stringify(remaining)}`)
  assert(permissionManager.listToolCapabilityGrants(310_000).length === 0, 'tool grant must expire at exact boundary')
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

check('native tool gate evaluates gui permission before bypassPermissions', () => {
  const text = source('src/main/native-tool-runtime.ts')
  const openai = source('src/main/openaiEngine.ts')
  const anthropic = source('src/main/anthropicEngine.ts')
  const gateStart = text.indexOf('async gateTool')
  const preflightStart = text.indexOf('\n  preflightToolGate(', gateStart)
  const gateBlock = text.slice(gateStart, preflightStart)
  const preflightCall = gateBlock.indexOf('this.preflightToolGate(name, input, toolUseId, effectHandle?.targetDigest)')
  const guiAllow = gateBlock.indexOf("guiDecision.kind === 'allow'")
  const guiAsk = gateBlock.indexOf("guiDecision.kind === 'ask'")
  const bypass = gateBlock.indexOf("mode === 'bypassPermissions'")
  const preflightGuiDecision = text.indexOf('decideGuiPermission(name,', preflightStart)
  assert(gateStart !== -1 && preflightStart !== -1, 'native tool gate/preflight markers not found')
  assert(preflightCall !== -1 && preflightGuiDecision !== -1, 'gateTool must invoke GUI-aware preflight')
  assert(guiAllow !== -1 && guiAsk !== -1 && bypass !== -1, 'gateTool GUI/bypass markers not found')
  assert(preflightCall < guiAllow && guiAllow < bypass && guiAsk < bypass, 'GUI decision must run before bypassPermissions check')
  assert(openai.includes('new NativeToolRuntime('), 'OpenAIEngine must delegate tool permission and Effect semantics to NativeToolRuntime')
  assert(anthropic.includes('new NativeToolRuntime('), 'AnthropicEngine must delegate tool permission and Effect semantics to NativeToolRuntime')
})

check('native tool gate evaluates policy denylist before gui permission allow or ask', () => {
  const text = source('src/main/native-tool-runtime.ts')
  const gateStart = text.indexOf('async gateTool')
  const preflightStart = text.indexOf('\n  preflightToolGate(', gateStart)
  const policy = text.indexOf('const policy = evaluateToolPermission', preflightStart)
  const policyDeny = text.indexOf("policy.kind === 'deny'", policy)
  const guiDecision = text.indexOf('decideGuiPermission(name,', preflightStart)
  assert(policy !== -1 && policyDeny !== -1 && guiDecision !== -1, 'gateTool policy/gui markers not found')
  assert(policy < guiDecision && policyDeny < guiDecision, 'policy denylist must run before GUI allow/ask path')
})

check('native gui gate decisions are audit logged', () => {
  const text = source('src/main/native-tool-runtime.ts')
  const gateStart = text.indexOf('async gateTool')
  const preflightStart = text.indexOf('\n  preflightToolGate(', gateStart)
  const auditStart = text.indexOf('private auditGateDecision', preflightStart)
  const gateBlock = text.slice(gateStart, preflightStart)
  const preflightBlock = text.slice(preflightStart, auditStart)
  assert(
    preflightBlock.includes("guiDecision.kind === 'deny'") && preflightBlock.includes("this.auditGateDecision('deny'"),
    'OpenAI GUI deny decision must be audited'
  )
  assert(
    gateBlock.includes("guiDecision.kind === 'allow'") && gateBlock.includes("this.auditGateDecision('allow'"),
    'OpenAI GUI allow decision must be audited'
  )
  assert(
    gateBlock.includes("guiDecision.kind === 'ask'") && gateBlock.includes("this.auditGateDecision('ask'"),
    'OpenAI GUI ask decision must be audited'
  )
})

check('native gui ask exposes exact grant scope while duplicate approval does not', () => {
  const text = source('src/main/native-tool-runtime.ts')
  const gateStart = text.indexOf('async gateTool')
  const preflightStart = text.indexOf('\n  preflightToolGate(', gateStart)
  const gateBlock = text.slice(gateStart, preflightStart)
  assert(
    gateBlock.includes(
      'this.requestToolPermission(name, input, toolUseId, guiDecision.reason, undefined, true, policy.risk.level, effectScope)'
    ),
    'ordinary GUI approval must expose the main-computed exact grant scope'
  )
  assert(
    gateBlock.includes(
      'idempotency.reason,\n        idempotency.duplicateExecutionId,\n        false,\n        policy.risk.level'
    ),
    'duplicate-effect approval must not create a temporary capability grant'
  )
})

check('permission policy classifies browser_navigate file URLs as paths', () => {
  const text = source('src/main/permission/tool-permission.ts')
  const browserBranch = text.indexOf("toolName === 'browser_navigate'")
  const fileUrlPath = text.indexOf('extractFileUrlPath(input.url)', browserBranch)
  const fileUrlToPath = text.indexOf('fileURLToPath(url)')
  assert(browserBranch !== -1 && fileUrlPath !== -1, 'browser_navigate must extract path from file:// URL')
  assert(fileUrlToPath !== -1, 'file:// URL extraction must use fileURLToPath')
})

check('native permission response grants temporary gui authorization only via message token', () => {
  const text = source('src/main/native-tool-runtime.ts')
  const token = text.indexOf('message === GUI_TEMPORARY_GRANT_MESSAGE')
  const guiPending = text.indexOf("pending.info.toolName.startsWith('gui_')", token)
  const grant = text.indexOf('grantTemporaryGuiAutomation(', token)
  assert(token !== -1 && grant !== -1, 'respondPermission must honor GUI_TEMPORARY_GRANT_MESSAGE')
  assert(guiPending !== -1 && guiPending < grant, 'temporary GUI grant token must be scoped to pending gui_* tool')
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

check('structured permission rules replace raw user DSL and migrate in the main process', () => {
  const shared = source('src/shared/types.ts')
  const mainSettings = source('src/main/settings.ts')
  const policy = source('src/main/permission/tool-permission.ts')
  const renderer = source('src/renderer/src/components/SettingsModal.tsx')
  assert(shared.includes('permissionRulesVersion: 2'), 'AppSettings must version structured permission rules')
  assert(shared.includes('permissionRules: PermissionRuleConfig[]'), 'AppSettings must persist structured rules')
  assert(mainSettings.includes('migrateLegacyPermissionRules(raw)'), 'main process must migrate legacy permission text')
  assert(mainSettings.includes('permissionRules: mergePermissionRules('), 'main process must merge persisted and legacy rules')
  assert(mainSettings.includes('normalizePermissionRules(raw.permissionRules, false)'), 'main process must normalize persisted rules')
  assert(policy.includes('const structuredRules = activeStructuredRules('), 'runtime must evaluate structured rules')
  assert(policy.includes('PERMISSION_RULE_FIELDS'), 'main validation must reject unknown rule fields')
  assert(renderer.includes('draft.permissionRules.map((rule)'), 'settings must render structured rule rows')
  assert(renderer.includes('permissionRuleRiskAtLeast'), 'settings must expose risk comparison controls')
  for (const semanticField of [
    'commandPattern', 'networkHostPattern', 'guiApplicationPattern',
    'guiWindowPattern', 'mcpToolPattern', 'mcpArgumentPointer', 'mcpArgumentPattern',
    'capabilityScope', 'requirePostcondition'
  ]) {
    assert(shared.includes(`${semanticField}:`), `permission rule type missing ${semanticField}`)
    assert(renderer.includes(`rule.${semanticField}`), `settings must expose semantic selector ${semanticField}`)
  }
  assert(policy.includes('requestHasValidGuiPostcondition(request)'), 'runtime must validate required GUI postconditions')
  for (const legacyField of ['permissionAllowlist', 'permissionDenylist', 'permissionTemporaryAllowlist', 'allowedTools', 'disallowedTools']) {
    assert(!renderer.includes(`value={draft.${legacyField}}`), `renderer must not expose raw DSL field ${legacyField}`)
  }
})

check('renderer exposes gui enable switch and scoped temporary allow action', () => {
  const settings = source('src/renderer/src/components/SettingsModal.tsx')
  assert(settings.includes('checked={draft.guiAutomationEnabled}'), 'SettingsModal must expose guiAutomationEnabled')
  assert(settings.includes('guiAutomationTemporaryGrantUntil: e.target.checked'), 'disabling switch must clear grant branch')
  assert(settings.includes(': 0'), 'disabling switch must clear guiAutomationTemporaryGrantUntil to 0')
  assert(settings.includes('listGuiAutomationGrants()'), 'settings must read active grants from the main process')
  assert(settings.includes('revokeGuiAutomationGrant(grant.id)'), 'settings must support exact grant revocation')
  assert(settings.includes('revokeAllGuiAutomationGrants()'), 'settings must support immediate revoke-all')

  const permissionBar = source('src/renderer/src/components/PermissionBar.tsx')
  assert(permissionBar.includes('req.guiGrantScope'), 'temporary allow button must require a main-process scope')
  assert(permissionBar.includes('GUI_TEMPORARY_GRANT_MESSAGE'), 'temporary allow must send grant token')
})

check('native runtime evaluates exact tool grants and hard boundaries before bypassPermissions', () => {
  const text = source('src/main/native-tool-runtime.ts')
  const capability = text.indexOf("toolCapabilityDecision.kind === 'allow'")
  const hardBoundary = text.indexOf("mode === 'bypassPermissions' && requiresExplicitApprovalDespiteBypass")
  const bypass = text.indexOf("if (mode === 'bypassPermissions')", hardBoundary + 1)
  assert(capability !== -1 && capability < hardBoundary && hardBoundary < bypass,
    'exact grants and non-bypassable boundary must run before generic bypass')
  for (const marker of ["'mcp_call_tool'", "'git_push'", "'git_create_issue'", "'send_notification'", "riskLevel === 'critical'", "riskLevel === 'high'", "name.toLowerCase().startsWith('mcp__')"]) {
    assert(text.includes(marker), `missing non-bypassable permission marker ${marker}`)
  }
})

check('native permission response creates tool grant only through exact message token', () => {
  const text = source('src/main/native-tool-runtime.ts')
  assert(text.includes('TOOL_TEMPORARY_GRANT_MESSAGE'), 'native runtime must recognize tool grant token')
  assert(text.includes('grantTemporaryToolCapability('), 'native runtime must create tool grant in main process')
  assert(text.includes('riskLevel: policy.risk.level'), 'permission request must carry authoritative risk level')
  assert(text.includes('capabilities: classifyToolCapabilities(name, input)'),
    'permission request must carry main-process-computed capabilities')
  assert(text.includes('temporaryToolGrantScopeLabel(name, input, riskLevel, effectScope)'), 'request must expose only computed stable scope')
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

check('gui grant ipc exposes read and revoke only', () => {
  const preload = source('src/preload/index.ts')
  const ipc = source('src/main/ipc/permission-grant-handlers.ts')
  for (const marker of ['listGuiAutomationGrants', 'revokeGuiAutomationGrant', 'revokeAllGuiAutomationGrants']) {
    assert(preload.includes(marker), `preload missing ${marker}`)
  }
  assert(ipc.includes("'permissions:grants:list'"), 'main IPC must expose grant list')
  assert(ipc.includes("'permissions:grants:revoke'"), 'main IPC must expose exact and revoke-all dispatch')
  assert(!preload.includes('createGuiAutomationGrant'), 'renderer must not expose a grant creation API')
})

check('tool capability renderer surface exposes read and revoke only', () => {
  const permissionBar = source('src/renderer/src/components/PermissionBar.tsx')
  assert(permissionBar.includes('req.capabilities'), 'permission card must show the actual capability set')
  const settings = source('src/renderer/src/components/SettingsModal.tsx')
  const preload = source('src/preload/index.ts')
  const ipc = source('src/main/ipc/permission-grant-handlers.ts')
  assert(permissionBar.includes('req.toolGrantScope'), 'permission card must require main-computed tool scope')
  assert(permissionBar.includes('TOOL_TEMPORARY_GRANT_MESSAGE'), 'permission card must send exact tool grant token')
  for (const marker of ['listToolCapabilityGrants', 'revokeToolCapabilityGrant', 'revokeAllToolCapabilityGrants']) {
    assert(preload.includes(marker), `preload missing ${marker}`)
    assert(settings.includes(marker), `settings missing ${marker}`)
  }
  for (const channel of ["'permissions:grants:list'", "'permissions:grants:revoke'"]) {
    assert(ipc.includes(channel), `main IPC missing ${channel}`)
  }
  assert(!preload.includes('createToolCapabilityGrant'), 'renderer must not expose a tool grant creation API')
})

check('session close revokes scoped grants before asynchronous teardown', () => {
  const text = source('src/main/ipc.ts')
  const handlerStart = text.indexOf("ipcMain.handle('sessions:close'")
  const handlerEnd = text.indexOf("'sessions:permission'", handlerStart)
  const block = text.slice(handlerStart, handlerEnd)
  const revokeGui = block.indexOf('revokeGuiAutomationGrantsForSession(id)')
  const revokeTool = block.indexOf('revokeToolCapabilityGrantsForSession(id)')
  const close = block.indexOf('await sessionManager.close(id)')
  assert(handlerStart !== -1 && handlerEnd !== -1, 'session close handler not found')
  assert(revokeGui !== -1 && revokeTool !== -1 && close !== -1, 'session close must revoke both grant kinds')
  assert(revokeGui < close && revokeTool < close, 'grant revocation must fail closed before asynchronous teardown')
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
