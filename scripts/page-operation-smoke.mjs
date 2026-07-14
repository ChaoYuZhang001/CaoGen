#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const outDir = path.join(repoRoot, 'test-results', 'caogen-deep')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outDir, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-page-smoke-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const port = await findFreePort(9400)
const PAGE_SMOKE_PROVIDER_ID = 'page-smoke-openai'
const PAGE_SMOKE_PROVIDER_NAME = 'Page Smoke OpenAI'
const PAGE_SMOKE_MODEL = 'page-smoke-model'
const electronBin =
  process.platform === 'win32'
    ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

if (!existsSync(electronBin)) fail('Electron binary not found. Run npm install first.')
if (!existsSync(mainEntry)) fail('Built Electron main entry not found. Run npm run build first.')

mkdirSync(runDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(path.join(projectDir, 'README.md'), '# Page smoke project\n')
writeFileSync(path.join(projectDir, 'notes.txt'), 'Plain preview note for Agent context.\nFollow-up action: summarize this file.\n')
writeFileSync(
  path.join(projectDir, 'browser-fixture.html'),
  [
    '<!doctype html>',
    '<html>',
    '<head><meta charset="utf-8"><title>CaoGen Browser Annotation Fixture</title></head>',
    '<body>',
    '<main id="fixture"><h1>Browser annotation target</h1><button class="cta">Fix spacing</button></main>',
    '</body>',
    '</html>'
  ].join('\n')
)
writeFileSync(path.join(projectDir, 'sample.json'), '{"ok":true}\n')
writeFileSync(
  path.join(projectDir, 'logo.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  )
)
writeFileSync(
  path.join(projectDir, 'report.pdf'),
  [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Contents 4 0 R >> endobj',
    '4 0 obj << /Length 44 >> stream',
    'BT /F1 12 Tf 20 70 Td (CaoGen PDF preview) Tj ET',
    'endstream endobj',
    'xref',
    '0 5',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    '0000000200 00000 n ',
    'trailer << /Root 1 0 R /Size 5 >>',
    'startxref',
    '294',
    '%%EOF'
  ].join('\n')
)
const briefDocxPath = path.join(projectDir, 'brief.docx')
if (process.platform === 'darwin') {
  const briefSourcePath = path.join(tempRoot, 'brief-source.txt')
  writeFileSync(briefSourcePath, 'Hello CaoGen\n\nOffice preview works\n')
  const converted = spawnSync('/usr/bin/textutil', ['-convert', 'docx', '-output', briefDocxPath, briefSourcePath], {
    encoding: 'utf8'
  })
  if (converted.status !== 0) {
    fail(`textutil failed to create the page-smoke DOCX: ${converted.stderr || converted.stdout}`)
  }
} else {
  writeFileSync(
    briefDocxPath,
    createZip({
      '[Content_Types].xml': '<Types></Types>',
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Hello CaoGen</w:t></w:r></w:p><w:p><w:r><w:t>Office preview works</w:t></w:r></w:p></w:body></w:document>'
    })
  )
}
writeFileSync(
  path.join(projectDir, 'report.xlsx'),
  createZip({
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Details" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Name</t></si><si><t>CaoGen</t></si><si><t>Score</t></si><si><t>Task</t></si><si><t>Preview</t></si><si><t>State</t></si><si><t>Ready</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>9</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c><c r="B1" t="s"><v>5</v></c></row><row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>6</v></c></row></sheetData></worksheet>'
  })
)
writeFileSync(
  path.join(projectDir, 'slides.pptx'),
  createZip({
    'ppt/slides/slide1.xml':
      '<p:sld><p:cSld><p:spTree><a:t>First slide</a:t><a:t>Delivery plan</a:t></p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide2.xml':
      '<p:sld><p:cSld><p:spTree><a:t>Second slide</a:t></p:spTree></p:cSld></p:sld>'
  })
)
writeFileSync(path.join(projectDir, 'broken.docx'), Buffer.from('not an office zip\n'))
initGitProject(projectDir)
writePageSmokeUserData()

const electronArgs = [`--remote-debugging-port=${port}`, mainEntry]
const app = spawn(electronSpawnCommand(), electronSpawnArgs(electronArgs), {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: userDataDir,
    OPENAI_API_KEY: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let stdout = ''
let stderr = ''
app.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
})
app.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

const report = {
  runId,
  projectDir,
  userDataDir,
  remoteDebuggingPort: port,
  checks: [],
  screenshots: [],
  warnings: []
}

try {
  const target = await waitForTarget(port, 20_000)
  const appTargetId = target.id
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Console.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  await bringPageToFront(cdp)
  cdp.on('Runtime.consoleAPICalled', (params) => {
    report.warnings.push(`renderer console ${params.type}: ${formatConsoleArgs(params.args)}`)
  })
  cdp.on('Runtime.exceptionThrown', (params) => {
    report.warnings.push(`renderer exception: ${formatExceptionDetails(params.exceptionDetails)}`)
  })
  cdp.on('Log.entryAdded', (params) => {
    const entry = params.entry ?? {}
    if (entry.level === 'error' || entry.level === 'warning') {
      report.warnings.push(`renderer log ${entry.level}: ${entry.text || JSON.stringify(entry)}`)
    }
  })
  await sleep(1200)

  await check(cdp, 'welcome screen renders CaoGen brand', async () => {
    const text = await visibleText(cdp)
    assert(text.includes('CaoGen'), 'CaoGen brand missing')
    const brand = await evalValue(
      cdp,
      `(() => {
        const mark = document.querySelector('[data-brand-logo="caogen-app-icon"]');
        const img = mark?.querySelector('img');
        return {
          ok: Boolean(mark && img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0),
          src: img?.getAttribute('src') || '',
          width: img?.naturalWidth || 0,
          height: img?.naturalHeight || 0
        };
      })()`
    )
    assert(brand?.ok, `CaoGen app icon logo did not render: ${JSON.stringify(brand)}`)
    const pluginLogo = readFileSync(path.join(repoRoot, 'plugins/vscode/media/caogen.svg'), 'utf8')
    assert(pluginLogo.includes('data:image/png;base64,'), 'VS Code extension logo should embed the CaoGen app icon asset')
    assert(!/<polygon\b|rotate\(45|◇|◆|◈/i.test(pluginLogo), 'VS Code extension logo still looks like an old diamond placeholder')
  })
  await screenshot(cdp, '01-welcome')

  await check(cdp, 'settings page replaces the workspace and plugin/migration tabs are reachable', async () => {
    await clickByText(cdp, '设置')
    await waitForText(cdp, '设置')
    const settingsSurface = await evalValue(
      cdp,
      `({
        pageCount: document.querySelectorAll('.settings-page').length,
        settingsBackdropCount: document.querySelectorAll('.settings-page .modal-backdrop').length,
        workspaceCount: document.querySelectorAll('.workbench, .welcome, .office-view').length
      })`
    )
    assert(settingsSurface?.pageCount === 1, `settings page missing: ${JSON.stringify(settingsSurface)}`)
    assert(settingsSurface?.settingsBackdropCount === 0, `settings still uses a modal backdrop: ${JSON.stringify(settingsSurface)}`)
    assert(settingsSurface?.workspaceCount === 0, `workspace should be replaced while settings is open: ${JSON.stringify(settingsSurface)}`)
    await clickByText(cdp, '控制室 / 外观')
    await waitForText(cdp, '工作台布局')
    await waitForText(cdp, '聊天缩放')
    const layoutControls = await evalValue(
      cdp,
      `({
        rangeCount: document.querySelectorAll('.settings-pane input[type="range"]').length,
        backgroundResizeHandleCount: document.querySelectorAll('.sidebar-resize-handle').length
      })`
    )
    assert(layoutControls?.rangeCount >= 3, `settings layout controls missing: ${JSON.stringify(layoutControls)}`)
    assert(layoutControls?.backgroundResizeHandleCount === 0, `background sidebar is still mounted: ${JSON.stringify(layoutControls)}`)
    await screenshot(cdp, '02-settings-page')
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false
      })
      await sleep(300)
      const mobileLayout = await evalValue(
        cdp,
        `(() => {
          const rect = (selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const value = node.getBoundingClientRect();
            return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
          };
          return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            bodyScrollWidth: document.body.scrollWidth,
            page: rect('.settings-page'),
            header: rect('.settings-page-header'),
            tabs: rect('.settings-tabs'),
            pane: rect('.settings-pane'),
            actions: rect('.settings-page-actions')
          };
        })()`
      )
      assert(mobileLayout?.viewport?.width === 390, `mobile viewport not applied: ${JSON.stringify(mobileLayout)}`)
      assert(mobileLayout?.bodyScrollWidth <= 390, `settings page overflows horizontally: ${JSON.stringify(mobileLayout)}`)
      assert(mobileLayout?.header?.bottom <= mobileLayout?.tabs?.top + 1, `settings tabs overlap header: ${JSON.stringify(mobileLayout)}`)
      assert(mobileLayout?.tabs?.bottom <= mobileLayout?.pane?.top + 1, `settings content overlaps tabs: ${JSON.stringify(mobileLayout)}`)
      assert(mobileLayout?.pane?.bottom <= mobileLayout?.actions?.top + 1, `settings actions overlap content: ${JSON.stringify(mobileLayout)}`)
      assert(mobileLayout?.actions?.bottom <= 845, `settings actions leave the viewport: ${JSON.stringify(mobileLayout)}`)
      await screenshot(cdp, '02-settings-page-mobile')
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride')
      await sleep(250)
    }
    await clickByText(cdp, '插件')
    await waitForText(cdp, '插件')
    await clickByText(cdp, '迁移')
    await waitForText(cdp, '迁移')
    await clickByText(cdp, '取消')
  })
  await screenshot(cdp, '02-after-settings')

  await check(cdp, 'CaoGen relay provider template can be saved with user keys without becoming the default', async () => {
    const settingsBefore = JSON.parse(readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'))
    await clickByText(cdp, '设置')
    await waitForText(cdp, '设置')
    await clickByText(cdp, '厂商')
    await waitForText(cdp, '+ 添加', 10_000)
    await clickByText(cdp, '+ 添加')
    await waitForText(cdp, '添加 Provider', 10_000)
    const providerEditorSurface = await evalValue(
      cdp,
      `({
        editorCount: document.querySelectorAll('.provider-editor').length,
        nestedBackdropCount: document.querySelectorAll('.modal-backdrop-nested').length,
        globalSettingsActionsCount: document.querySelectorAll('.settings-page-actions').length
      })`
    )
    assert(providerEditorSurface?.editorCount === 1, `inline provider editor missing: ${JSON.stringify(providerEditorSurface)}`)
    assert(providerEditorSurface?.nestedBackdropCount === 0, `provider editor still uses a modal backdrop: ${JSON.stringify(providerEditorSurface)}`)
    assert(providerEditorSurface?.globalSettingsActionsCount === 0, `global settings actions should hide while editing a provider: ${JSON.stringify(providerEditorSurface)}`)
    await screenshot(cdp, '02-provider-editor-page')
    await chooseProviderEditorSelectOption(cdp, 'CaoGen 中转站模板')
    await waitForText(cdp, 'CaoGen 中转站预设入口', 10_000)
    await setInputByPlaceholder(cdp, '例如:公司网关 / OpenRouter', 'CaoGen Relay UI Smoke')
    await setInputByPlaceholder(cdp, '<your-api-key>', 'sk-page-smoke-primary')
    await setInputByPlaceholder(cdp, '例如:主账号 / 备用额度 / 中转站 A', '主账号')
    await setInputByPlaceholder(cdp, '备用额度=sk-...\n中转站 A=sk-...', '备用额度=sk-page-smoke-backup')
    await setInputByPlaceholder(cdp, 'gpt-4o\nclaude-3-5-sonnet\ngemini-1.5-pro', 'caogen-relay-fast\ncaogen-relay-strong')
    await screenshot(cdp, '02-provider-editor-filled')
    await clickProviderEditorSave(cdp)
    await waitForText(cdp, 'CaoGen Relay UI Smoke', 10_000)
    await waitForText(cdp, 'https://gpt.zhangrui.xyz/dashboard', 10_000)
    await waitForText(cdp, '2 个模型', 10_000)
    await waitForText(cdp, '2 个可用密钥', 10_000)

    const settingsAfter = JSON.parse(readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'))
    assert(settingsAfter.defaultProviderId === settingsBefore.defaultProviderId, 'relay template save should not set a default provider')
    assert(settingsAfter.defaultModel === settingsBefore.defaultModel, 'relay template save should not set a default model')

    const providers = JSON.parse(readFileSync(path.join(userDataDir, 'providers.json'), 'utf8'))
    const relay = providers.find((provider) => provider.name === 'CaoGen Relay UI Smoke')
    assert(relay, 'saved relay provider not found')
    assert(relay.id !== 'caogen-relay', 'preset key must not be persisted as a hidden provider id')
    assert(relay.baseUrl === 'https://gpt.zhangrui.xyz/dashboard', `unexpected relay baseUrl: ${relay.baseUrl}`)
    assert(relay.openaiProtocol === 'chat', `unexpected relay protocol: ${relay.openaiProtocol}`)
    assert(JSON.stringify(relay.models) === JSON.stringify(['caogen-relay-fast', 'caogen-relay-strong']), `unexpected relay models: ${JSON.stringify(relay.models)}`)
    assert(Array.isArray(relay.apiKeys) && relay.apiKeys.length === 2, `relay should save primary + backup keys: ${JSON.stringify(relay.apiKeys)}`)
    assert(relay.apiKeys.every((key) => /^enc:|^b64:/.test(key.encryptedToken)), 'relay keys must be encrypted/encoded, not plaintext')
    assert(!JSON.stringify(relay).includes('sk-page-smoke'), 'relay provider must not persist plaintext API keys')
    assert(relay.activeKeyId === relay.apiKeys[0].id, 'primary relay key should be active after creation')
    await clickByText(cdp, '取消')
  })
  await screenshot(cdp, '02-provider-relay')

  await check(cdp, 'automatic routing preferences can be configured from settings UI', async () => {
    const providers = JSON.parse(readFileSync(path.join(userDataDir, 'providers.json'), 'utf8'))
    const relay = providers.find((provider) => provider.name === 'CaoGen Relay UI Smoke')
    assert(relay, 'relay provider must exist before configuring routing preferences')

    await clickByText(cdp, '设置')
    await waitForText(cdp, '设置')
    await clickByText(cdp, '通用')
    await waitForText(cdp, '模型角色偏好', 10_000)
    await setSettingsCheckbox(cdp, 'P2-003 多模型智能混合调度', true)
    await chooseSettingsSelectByLabel(cdp, '自动调度策略', '速度优先')
    await chooseSettingsSelectByLabel(cdp, '低成本 · Provider', 'CaoGen Relay UI Smoke')
    await chooseSettingsSelectByLabel(cdp, '低成本 · 模型', 'caogen-relay-fast')
    await chooseSettingsSelectByLabel(cdp, '调研 · Provider', 'CaoGen Relay UI Smoke')
    await chooseSettingsSelectByLabel(cdp, '调研 · 模型', 'caogen-relay-strong')
    await chooseSettingsSelectByLabel(cdp, '策划 · Provider', 'CaoGen Relay UI Smoke')
    await chooseSettingsSelectByLabel(cdp, '策划 · 模型', 'caogen-relay-strong')
    await chooseSettingsSelectByLabel(cdp, '开发 · Provider', 'CaoGen Relay UI Smoke')
    await chooseSettingsSelectByLabel(cdp, '开发 · 模型', 'caogen-relay-strong')
    await chooseSettingsSelectByLabel(cdp, '测试 · Provider', 'CaoGen Relay UI Smoke')
    await chooseSettingsSelectByLabel(cdp, '测试 · 模型', 'caogen-relay-fast')
    await chooseSettingsSelectByLabel(cdp, '文档 · Provider', 'CaoGen Relay UI Smoke')
    await chooseSettingsSelectByLabel(cdp, '文档 · 模型', 'caogen-relay-fast')
    await evalValue(
      cdp,
      `(() => {
        const target = document.querySelector('.model-task-role-list');
        target?.scrollIntoView({ block: 'start' });
        return Boolean(target);
      })()`
    )
    await sleep(250)
    await screenshot(cdp, '02-routing-settings')
    await chooseSettingsSelectByLabel(cdp, '强推理 · Provider', 'CaoGen Relay UI Smoke')
    await chooseSettingsSelectByLabel(cdp, '强推理 · 模型', 'caogen-relay-strong')
    await chooseSettingsSelectByLabel(cdp, '审查 · Provider', 'CaoGen Relay UI Smoke')
    await chooseSettingsSelectByLabel(cdp, '审查 · 模型', 'caogen-relay-strong')
    await chooseSettingsSelectByLabel(cdp, '备用 · Provider', 'CaoGen Relay UI Smoke')
    await chooseSettingsSelectByLabel(cdp, '备用 · 模型', 'caogen-relay-fast')

    await clickByText(cdp, '+ 添加规则')
    await waitForText(cdp, '规则名', 10_000)
    await setLatestRoutingRuleField(cdp, 'input:not([type="checkbox"])', '发布审查')
    await setLatestRoutingRuleField(cdp, 'textarea', 'release,发布,上线')
    await chooseLatestRoutingRuleSelect(cdp, 0, 'CaoGen Relay UI Smoke')
    await chooseLatestRoutingRuleSelect(cdp, 1, 'caogen-relay-strong')
    await chooseLatestRoutingRuleSelect(cdp, 2, '全部关键词命中')
    await chooseLatestRoutingRuleSelect(cdp, 3, '速度优先')
    await chooseLatestRoutingRuleSelect(cdp, 4, '高')
    await setLatestRoutingRuleTask(cdp, '审查', true)
    await screenshot(cdp, '02-custom-routing-rule')
    await clickSettingsSave(cdp)

    const settings = JSON.parse(readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'))
    assert(settings.smartModelRoutingEnabled === true, 'smart routing should be enabled')
    assert(settings.schedulerStrategy === 'speed', `scheduler strategy should be speed: ${settings.schedulerStrategy}`)
    assert(settings.lowCostProviderId === relay.id, 'low-cost provider should be the saved relay')
    assert(settings.lowCostModel === 'caogen-relay-fast', 'low-cost model should be saved')
    assert(settings.researchProviderId === relay.id && settings.researchModel === 'caogen-relay-strong', 'research role should be saved')
    assert(settings.planningProviderId === relay.id && settings.planningModel === 'caogen-relay-strong', 'planning role should be saved')
    assert(settings.codingProviderId === relay.id && settings.codingModel === 'caogen-relay-strong', 'coding role should be saved')
    assert(settings.testingProviderId === relay.id && settings.testingModel === 'caogen-relay-fast', 'testing role should be saved')
    assert(settings.documentationProviderId === relay.id && settings.documentationModel === 'caogen-relay-fast', 'documentation role should be saved')
    assert(settings.strongReasoningProviderId === relay.id, 'strong reasoning provider should be the saved relay')
    assert(settings.strongReasoningModel === 'caogen-relay-strong', 'strong reasoning model should be saved')
    assert(settings.reviewProviderId === relay.id, 'review provider should be the saved relay')
    assert(settings.reviewModel === 'caogen-relay-strong', 'review model should be saved')
    assert(settings.fallbackProviderId === relay.id, 'fallback provider should be the saved relay')
    assert(settings.fallbackModel === 'caogen-relay-fast', 'fallback model should be saved')
    const rule = settings.modelRoutingRules?.find((item) => item.name === '发布审查')
    assert(rule?.enabled === true, 'custom routing rule should be enabled')
    assert(rule.providerId === relay.id, 'custom routing rule should target the saved relay')
    assert(rule.model === 'caogen-relay-strong', 'custom routing rule should target the strong model')
    assert(rule.match.includes('release') && rule.match.includes('发布'), `custom routing rule match not saved: ${rule.match}`)
    assert(rule.keywordMode === 'all', `custom routing keyword mode not saved: ${rule.keywordMode}`)
    assert(rule.whenStrategy === 'speed', `custom routing strategy condition not saved: ${rule.whenStrategy}`)
    assert(rule.minRiskLevel === 'high', `custom routing risk condition not saved: ${rule.minRiskLevel}`)
    assert(rule.taskKinds?.includes('review'), `custom routing task condition not saved: ${JSON.stringify(rule.taskKinds)}`)
  })

  await check(cdp, 'inline new session workspace creates a Provider-scoped project session', async () => {
    await clickByText(cdp, '+ 新建会话')
    await waitForText(cdp, '今天想做点什么?')
    await setInputByPlaceholder(cdp, '/path/to/project', projectDir)
    await clickByText(cdp, '指定模型')
    await chooseSelectOptionByText(cdp, PAGE_SMOKE_PROVIDER_NAME)
    await chooseSelectOptionByText(cdp, PAGE_SMOKE_MODEL)
    await setInputByPlaceholder(cdp, '随心输入,回车即开始新会话…', '请检查项目状态')
    await clickSelector(cdp, '.welcome-send')
    await waitForAriaLabel(cdp, '⎇ Worktree', 10_000) // 工具栏图标化后按 aria-label 断言
  })
  await screenshot(cdp, '03-session')

  await check(cdp, 'project rules can be edited and saved from settings without mutating global settings', async () => {
    const settingsBefore = readFileSync(path.join(userDataDir, 'settings.json'), 'utf8')
    await clickByText(cdp, '设置')
    await waitForText(cdp, '设置')
    await clickByText(cdp, '项目规则')
    await waitForText(cdp, '结构化规则助手', 10_000)
    await waitForText(cdp, projectDir, 10_000)
    await setProjectRuleTextarea(cdp, '项目提示词', '- 使用中文回答\n- UI smoke marker: project-rule-e2e')
    await setProjectRuleTextarea(cdp, '技术栈与架构', '- 技术栈: Electron + React + TypeScript\n- 关键模块: settings/project rules')
    await setProjectRuleTextarea(cdp, '测试命令', '- 默认测试命令: npm run test:page\n- 专项 smoke: project rules UI')
    await setProjectRuleTextarea(cdp, '禁止修改目录', '- dist/\n- node_modules/\n- secrets/')
    await setProjectRuleTextarea(
      cdp,
      '模型调度策略',
      '- 简单任务: provider=page-smoke-openai model=page-smoke-model\n- 复杂任务: provider=page-smoke-openai model=page-smoke-model\n- 成本 / 速度 / 质量偏好: 速度优先'
    )
    await setProjectRuleTextarea(cdp, '项目记忆', '- 已确认事实: page smoke 写入项目级规则,不修改全局设置')
    await clickByText(cdp, '同步并保存')
    await waitForText(cdp, '已同步并保存项目规则', 10_000)

    const saved = readFileSync(path.join(projectDir, 'caogen.md'), 'utf8')
    assert(saved.includes('# 项目提示词'), 'caogen.md should include project prompt section')
    assert(saved.includes('project-rule-e2e'), 'caogen.md should include the project prompt marker')
    assert(saved.includes('# 模型调度策略'), 'caogen.md should include model dispatch section')
    assert(saved.includes('provider=page-smoke-openai model=page-smoke-model'), 'caogen.md should include routing hint')
    assert(saved.includes('- secrets/'), 'caogen.md should include forbidden path edits')
    const settingsAfter = readFileSync(path.join(userDataDir, 'settings.json'), 'utf8')
    assert(settingsAfter === settingsBefore, 'project rule save should not mutate global settings.json')
    await clickByText(cdp, '取消')
  })
  await screenshot(cdp, '03-project-rules')

  await check(cdp, 'chat layout controls resize and density toggle are interactive', async () => {
    await waitForAriaLabel(cdp, '聊天布局控制', 10_000)
    await clickByAriaLabel(cdp, '放大聊天内容')
    await waitForText(cdp, '105%', 5_000)
    await clickByAriaLabel(cdp, '切换紧凑聊天密度')
    const state = await evalValue(
      cdp,
      `(() => ({
        compact: document.querySelector('.chat')?.classList.contains('chat-density-compact') ?? false,
        scale: getComputedStyle(document.querySelector('.chat')).getPropertyValue('--chat-scale').trim()
      }))()`
    )
    assert(state.compact === true, `compact chat density not applied: ${JSON.stringify(state)}`)
    assert(state.scale === '1.05', `chat scale not persisted on root: ${JSON.stringify(state)}`)
    await clickByAriaLabel(cdp, '重置聊天缩放')
    await waitForText(cdp, '100%', 5_000)
  })
  await screenshot(cdp, '03-layout-controls')

  await check(cdp, 'sidebar layout controls resize collapse and expand', async () => {
    const before = await sidebarState(cdp)
    await dragByAriaLabel(cdp, '拖拽调整侧栏宽度', 60, 0)
    const resized = await sidebarState(cdp)
    assert(resized.width > before.width + 24, `sidebar width did not grow: ${JSON.stringify({ before, resized })}`)
    await clickByAriaLabel(cdp, '收回侧栏')
    const collapsed = await sidebarState(cdp)
    assert(collapsed.collapsed === true, `sidebar did not collapse: ${JSON.stringify(collapsed)}`)
    assert(collapsed.width <= 80, `collapsed sidebar width too large: ${JSON.stringify(collapsed)}`)
    await clickByAriaLabel(cdp, '展开侧栏')
    const expanded = await sidebarState(cdp)
    assert(expanded.collapsed === false, `sidebar did not expand: ${JSON.stringify(expanded)}`)
    assert(expanded.width >= 280, `expanded sidebar did not restore width: ${JSON.stringify(expanded)}`)
  })
  await screenshot(cdp, '03-sidebar-layout')

  let worktreeRecord = null
  await check(cdp, 'managed worktree registry is created for git projects', async () => {
    worktreeRecord = await waitForWorktreeRecord(userDataDir)
    assert(worktreeRecord.sourceCwd === projectDir, `wrong source cwd: ${JSON.stringify(worktreeRecord)}`)
    writeFileSync(path.join(worktreeRecord.cwd, 'merge-ui.txt'), 'worktree merge ui smoke\n')
  })

  await check(cdp, 'worktree merge UI inspects an applyable patch', async () => {
    await clickByAriaLabel(cdp, '⎇ Worktree') // 图标按钮
    await waitForText(cdp, '隔离工作区', 10_000)
    await waitForText(cdp, '改动\n1', 10_000)
    await clickByText(cdp, '检查合并')
    await waitForText(cdp, '合并检查通过，可应用到主工作区', 10_000)
    await waitForText(cdp, 'merge-ui.txt', 10_000)
    await waitForText(cdp, 'Patch 预览', 10_000)
    await waitForText(cdp, 'git apply --check passed.', 10_000)
  })
  await screenshot(cdp, '04-worktree-merge')

  await check(cdp, 'tool panel layout controls resize and collapse', async () => {
    const before = await toolPanelState(cdp)
    await dragByAriaLabel(cdp, '拖拽调整工具面板宽度', -80, 0, { yRatio: 0.25 })
    const resized = await toolPanelState(cdp)
    assert(resized.width > before.width + 40, `tool panel width did not grow: ${JSON.stringify({ before, resized })}`)
    await clickByAriaLabel(cdp, '收回工具面板')
    await waitForNoAriaLabel(cdp, '收回工具面板', 5_000)
  })
  await screenshot(cdp, '04-tool-panel-layout')

  await check(cdp, 'workbench panels open from chat toolbar', async () => {
    // 常显图标(按 aria-label 点击):文件 / 终端
    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'README.md', 10_000)
    await clickByAriaLabel(cdp, '❯ 终端')
    await waitForText(cdp, '终端', 10_000)
    // 低频项在 '⋯ 更多' 下拉里:先展开菜单,菜单项按文本点击
    const overflow = [
      ['插件', '插件生态'],
      ['Routines', 'Routines'],
      ['记忆', '项目记忆'],
      ['子 Agent', '子代理编排']
    ]
    for (const [item, marker] of overflow) {
      await clickByAriaLabel(cdp, '更多操作') // 打开 ⋯ 更多下拉
      await clickByText(cdp, item)
      await waitForText(cdp, marker, 10_000)
    }
  })
  await screenshot(cdp, '05-workbench-panels')

  await check(cdp, 'browser native view is removed when switching panels', async () => {
    await clickByAriaLabel(cdp, '◉ 浏览器')
    await waitForText(cdp, '内置浏览器', 10_000)
    await waitForBrowserViewTargets(port, appTargetId, 1, 10_000)
    await setInputByPlaceholder(cdp, '输入 URL 或域名', pathToFileURL(path.join(projectDir, 'browser-fixture.html')).href)
    await press(cdp, 'Enter')
    await waitForText(cdp, 'CaoGen Browser Annotation Fixture', 10_000)
    await setInputByPlaceholder(cdp, '批注说明。先在网页中选中文本或区域附近内容。', '批注: CTA spacing needs a fix')
    await clickByText(cdp, '保存批注')
    await waitForText(cdp, '已保存网页批注', 10_000)
    await waitForText(cdp, '批注: CTA spacing needs a fix', 10_000)
    await clickByText(cdp, '发给 Agent')
    await waitForText(cdp, '请基于这个 CaoGen 网页批注定位并修复问题。', 10_000)
    await waitForText(cdp, 'CTA spacing needs a fix', 10_000)
    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'README.md', 10_000)
    await waitForBrowserViewTargets(port, appTargetId, 0, 10_000)
  })
  await screenshot(cdp, '06-browser-switch')

  await check(cdp, 'image and PDF previews render from project files', async () => {
    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'logo.png', 10_000)
    await clickFilePreview(cdp, 'logo.png')
    await waitForText(cdp, 'Image Preview', 10_000)
    const image = await waitForImagePreview(cdp)
    assert(image.src.startsWith('data:image/png;base64,'), `image preview did not use data URL: ${image.src.slice(0, 60)}`)
    assert(image.naturalWidth > 0 && image.naturalHeight > 0, `image preview did not decode: ${JSON.stringify(image)}`)

    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'report.pdf', 10_000)
    await clickFilePreview(cdp, 'report.pdf')
    await waitForText(cdp, 'PDF Preview', 10_000)
    const pdf = await evalValue(
      cdp,
      `(() => {
        const object = document.querySelector('object[type="application/pdf"]');
        const placeholder = document.body.innerText.includes('PDF preview placeholder');
        return { ok: Boolean(object), data: object?.getAttribute('data') || '', placeholder };
      })()`
    )
    assert(pdf.ok, 'PDF object preview not found')
    assert(pdf.data.startsWith('data:application/pdf;base64,'), `PDF preview did not use data URL: ${pdf.data.slice(0, 80)}`)
    assert(!pdf.placeholder, 'old PDF placeholder is still visible')
  })
  await screenshot(cdp, '07-preview-assets')

  await check(cdp, 'preview content can be sent to Agent from PDF text and Office files', async () => {
    await assertPreviewAgentState(cdp, { sendable: '1', type: 'pdf', mode: 'asset' })
    await clickPreviewSendToAgent(cdp)
    await waitForPreviewSendState(cdp, 'sent')
    await waitForLatestUserMessageIncludes(cdp, [
      '请基于这个 CaoGen 产物预览继续工作。',
      '文件: report.pdf',
      '类型: pdf',
      '内容截断: 否',
      'CaoGen PDF preview'
    ])

    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'notes.txt', 10_000)
    await clickFilePreview(cdp, 'notes.txt')
    await waitForText(cdp, 'Text Preview', 10_000)
    await assertPreviewAgentState(cdp, { sendable: '1', type: 'text', mode: 'text' })
    await clickPreviewSendToAgent(cdp)
    await waitForPreviewSendState(cdp, 'sent')
    await waitForLatestUserMessageIncludes(cdp, [
      '文件: notes.txt',
      '类型: text',
      '内容字符:',
      '内容截断: 否',
      'Plain preview note for Agent context'
    ])

    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'brief.docx', 10_000)
    await clickFilePreview(cdp, 'brief.docx')
    await waitForText(cdp, 'Word Preview', 10_000)
    await assertPreviewAgentState(cdp, { sendable: '1', type: 'office', mode: 'text' })
    if (process.platform === 'darwin') {
      const visual = await waitForOfficeVisualState(cdp, 'ready', 10_000)
      assert(visual.mode === 'visual', `ready Office visual should become the default mode: ${JSON.stringify(visual)}`)
      assert(
        visual.format === 'document'
          ? visual.frameReady && visual.frameWidth > 0 && visual.frameHeight > 0
          : visual.imageComplete && visual.naturalWidth > 0,
        `Office visual should render a document iframe or PNG fallback: ${JSON.stringify(visual)}`
      )
      await screenshot(cdp, '08-office-visual')
      await clickOfficePreviewMode(cdp, 'structure')
    }
    await waitForText(cdp, 'Office preview works', 10_000)
    await clickPreviewSendToAgent(cdp)
    await waitForPreviewSendState(cdp, 'sent')
    await waitForLatestUserMessageIncludes(cdp, [
      '文件: brief.docx',
      '类型: office',
      '内容截断: 否',
      'Hello CaoGen',
      'Office preview works'
    ])

    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'report.xlsx', 10_000)
    await clickFilePreview(cdp, 'report.xlsx')
    await waitForText(cdp, 'Excel Preview', 10_000)
    await selectOfficeStructureMode(cdp)
    await waitForOfficeUnit(cdp, { index: '1', total: '2', title: 'Summary', kind: 'sheet' })
    await waitForText(cdp, 'Summary', 10_000)
    await waitForText(cdp, 'Name', 10_000)
    await waitForText(cdp, 'Score', 10_000)
    await waitForText(cdp, 'CaoGen', 10_000)
    await assertPreviewAgentState(cdp, { sendable: '1', type: 'office', mode: 'text' })
    await clickPreviewSendToAgent(cdp)
    await waitForPreviewSendState(cdp, 'sent')
    await waitForLatestUserMessageIncludes(cdp, [
      '文件: report.xlsx',
      '类型: office',
      '内容截断: 否',
      'Excel Workbook',
      'Name\tScore',
      'CaoGen\t9',
      'Preview\tReady'
    ])

    await clickOfficeUnitAction(cdp, 'next')
    await waitForOfficeUnit(cdp, { index: '2', total: '2', title: 'Details', kind: 'sheet' })
    await waitForText(cdp, 'Task', 10_000)
    await waitForText(cdp, 'Preview', 10_000)
    await waitForText(cdp, 'Ready', 10_000)
    await savePreviewNote(cdp, 'Details sheet needs review')
    const storedAnnotation = await waitForStoredPreviewAnnotation(userDataDir, 'Details sheet needs review')
    assert(storedAnnotation.locator?.page === 2, `current sheet annotation should persist page=2: ${JSON.stringify(storedAnnotation)}`)
    assert(storedAnnotation.locator?.quote?.includes('Preview Ready'), 'current sheet annotation should persist a quote')
    assert(storedAnnotation.locator?.selector?.includes('office:sheet:2:Details'), 'current sheet annotation should persist a selector')
    await clickPreviewSendCurrentUnit(cdp)
    await waitForPreviewSendState(cdp, 'sent')
    await waitForLatestUserMessageIncludes(cdp, [
      '文件: report.xlsx',
      '发送范围: 当前结构单元',
      '当前单元: Details',
      '当前序号: 2/2',
      '单元类型: sheet',
      'Preview\tReady',
      'locator={"page":2'
    ])

    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'slides.pptx', 10_000)
    await clickFilePreview(cdp, 'slides.pptx')
    await waitForText(cdp, 'PowerPoint Preview', 10_000)
    await selectOfficeStructureMode(cdp)
    await waitForOfficeUnit(cdp, { index: '1', total: '2', title: 'Slide 1', kind: 'slide' })
    await waitForText(cdp, 'Slide 1', 10_000)
    await waitForText(cdp, 'First slide', 10_000)
    await waitForText(cdp, 'Delivery plan', 10_000)
    await assertTextAbsent(cdp, 'Second slide')
    await clickOfficeUnitAction(cdp, 'next')
    await waitForOfficeUnit(cdp, { index: '2', total: '2', title: 'Slide 2', kind: 'slide' })
    await waitForText(cdp, 'Second slide', 10_000)
    await assertTextAbsent(cdp, 'Delivery plan')
    await clickPreviewSendCurrentUnit(cdp)
    await waitForPreviewSendState(cdp, 'sent')
    await waitForLatestUserMessageIncludes(cdp, [
      '文件: slides.pptx',
      '发送范围: 当前结构单元',
      '当前单元: Slide 2',
      '当前序号: 2/2',
      'Second slide'
    ])
    await assertPreviewAgentState(cdp, { sendable: '1', type: 'office', mode: 'text' })
    await clickPreviewSendToAgent(cdp)
    await waitForPreviewSendState(cdp, 'sent')
    await waitForLatestUserMessageIncludes(cdp, [
      '文件: slides.pptx',
      '类型: office',
      '内容截断: 否',
      'PowerPoint Presentation',
      'First slide',
      'Second slide'
    ])

    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'broken.docx', 10_000)
    await clickFilePreview(cdp, 'broken.docx')
    await waitForPreviewFailure(cdp, ['Office 文档无法解析', '不是有效的 Office Open XML ZIP 文件'])
    await assertPreviewAgentState(cdp, { sendable: '1', type: '', mode: '' })
    await clickPreviewSendToAgent(cdp)
    await waitForPreviewSendState(cdp, 'sent')
    await waitForLatestUserMessageIncludes(cdp, [
      '文件: broken.docx',
      '类型: (unknown)',
      '预览错误: Office 文档无法解析',
      '预览内容: (此预览没有可发送的文本内容'
    ])
  })
  await screenshot(cdp, '08-preview-send-agent')

  await check(cdp, 'slash command popup exposes key workbench commands', async () => {
    await focusComposer(cdp)
    await typeText(cdp, '/pl')
    await waitForText(cdp, '/plugins')
    await press(cdp, 'Escape')
  })
  await screenshot(cdp, '09-slash-popup')

  await check(cdp, 'office view loads without blank first screen', async () => {
    await bringPageToFront(cdp)
    await clickByText(cdp, 'Agent 控制室')
    await waitForText(cdp, 'Agent 控制室', 10_000)
    await bringPageToFront(cdp)
    const officeTelemetry = await waitForOfficeTelemetry(cdp)
    report.officeTelemetry = officeTelemetry
    const canvasStats = await waitForCanvasPixels(cdp)
    report.officeCanvas = canvasStats
  })
  await screenshot(cdp, '10-office')

  await cdp.close()
} finally {
  const exited = await terminate(app)
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  const cspWarning = report.warnings.find((warning) => /ERR_BLOCKED_BY_CSP|Content Security Policy/i.test(warning))
  if (cspWarning) {
    report.checks.push({
      name: 'runtime does not block previews by CSP',
      status: 'fail',
      durationMs: 0,
      error: cspWarning
    })
  }
  writeFileSync(path.join(runDir, 'page-operation-smoke.json'), JSON.stringify(report, null, 2))
  cleanupTempRoot(tempRoot)
}

const failed = report.checks.filter((item) => item.status === 'fail')
if (failed.length > 0) {
  console.error(`page operation smoke failed: ${failed.map((f) => f.name).join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`page operation smoke ok: ${runDir}`)
}

function writePageSmokeUserData() {
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(
    path.join(userDataDir, 'providers.json'),
    JSON.stringify(
      [
        {
          id: PAGE_SMOKE_PROVIDER_ID,
          name: PAGE_SMOKE_PROVIDER_NAME,
          baseUrl: 'http://127.0.0.1:1',
          engine: 'openai',
          encryptedToken: `b64:${Buffer.from('mock-key').toString('base64')}`,
          models: [PAGE_SMOKE_MODEL],
          openaiProtocol: 'responses',
          note: 'Page smoke provider; no network call is expected.',
          createdAt: Date.now()
        }
      ],
      null,
      2
    )
  )
  writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify(
      {
        defaultModel: '',
        defaultPermissionMode: 'default',
        defaultProviderId: '',
        language: 'zh',
        theme: 'dark'
      },
      null,
      2
    )
  )
}

async function check(cdp, name, fn) {
  const startedAt = Date.now()
  try {
    await fn()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    try {
      await screenshot(cdp, `fail-${report.checks.length}`)
    } catch {
      // keep original assertion as the useful error
    }
    throw error
  }
}

async function screenshot(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = path.join(runDir, `${name}.png`)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  report.screenshots.push(file)
}

async function clickByAriaLabel(cdp, label) {
  const result = await evalValue(
    cdp,
    `(() => {
      const el = document.querySelector('[aria-label=${JSON.stringify(label)}]');
      if (!el) return { ok: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `aria-label button not found: ${label}`)
  await sleep(250)
}

async function dragByAriaLabel(cdp, label, deltaX, deltaY, origin = {}) {
  const point = await evalValue(
    cdp,
    `(() => {
      const el = document.querySelector('[aria-label=${JSON.stringify(label)}]');
      if (!el) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      const rect = el.getBoundingClientRect();
      const xRatio = ${JSON.stringify(origin.xRatio ?? 0.5)};
      const yRatio = ${JSON.stringify(origin.yRatio ?? 0.5)};
      return { ok: true, x: rect.left + rect.width * xRatio, y: rect.top + rect.height * yRatio };
    })()`
  )
  assert(point?.ok, `draggable aria-label not found: ${label}\n${point?.text ?? ''}`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x + deltaX,
    y: point.y + deltaY,
    button: 'left',
    buttons: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x + deltaX,
    y: point.y + deltaY,
    button: 'left',
    clickCount: 1
  })
  await sleep(300)
}

async function sidebarState(cdp) {
  return evalValue(
    cdp,
    `(() => {
      const el = document.querySelector('.sidebar');
      if (!el) return { ok: false, collapsed: false, width: 0 };
      return {
        ok: true,
        collapsed: el.classList.contains('sidebar-collapsed'),
        width: Number.parseFloat(getComputedStyle(el).width)
      };
    })()`
  )
}

async function toolPanelState(cdp) {
  return evalValue(
    cdp,
    `(() => {
      const el = document.querySelector('.workbench-side');
      if (!el) return { ok: false, width: 0 };
      return {
        ok: true,
        width: Number.parseFloat(getComputedStyle(el).width)
      };
    })()`
  )
}

async function clickByText(cdp, text) {
  const result = await evalValue(
    cdp,
    `(() => {
      const needle = ${JSON.stringify(text)};
      const elements = [...document.querySelectorAll('button, [role="button"], option')];
      const el = elements.find((candidate) => (candidate.innerText || candidate.textContent || '').trim().includes(needle));
      if (!el) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `button/text not found: ${text}\n${result?.text ?? ''}`)
  await sleep(250)
}

async function clickSelector(cdp, selector) {
  const result = await evalValue(
    cdp,
    `(() => {
      const selector = ${JSON.stringify(selector)};
      const element = document.querySelector(selector);
      if (!element) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `selector not found: ${selector}\n${result?.text ?? ''}`)
  await sleep(250)
}

async function clickFilePreview(cdp, filePath) {
  const result = await evalValue(
    cdp,
    `(() => {
      const needle = ${JSON.stringify(filePath)};
      const rows = [...document.querySelectorAll('.file-row-wrap')];
      const row = rows.find((candidate) => candidate.querySelector('.file-row-path')?.textContent?.trim() === needle);
      const button = row?.querySelector('.file-row-preview');
      if (!button) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `file preview button not found for ${filePath}\n${result?.text ?? ''}`)
  await sleep(250)
}

async function waitForImagePreview(cdp, timeout = 5000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `(() => {
        const img = document.querySelector('.preview-renderer img');
        return {
          ok: Boolean(img),
          src: img?.getAttribute('src') || '',
          complete: Boolean(img?.complete),
          naturalWidth: img?.naturalWidth || 0,
          naturalHeight: img?.naturalHeight || 0
        };
      })()`
    )
    if (last?.ok && last.complete && last.naturalWidth > 0 && last.naturalHeight > 0) return last
    await sleep(150)
  }
  throw new Error(`image preview did not decode: ${JSON.stringify(last)}`)
}

async function waitForOfficeVisualState(cdp, expectedState, timeout = 5000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `(() => {
        const root = document.querySelector('[data-office-visual-state]');
        const img = root?.querySelector('img');
        const frame = root?.querySelector('iframe[data-office-system-preview="document"]');
        const frameBounds = frame?.getBoundingClientRect();
        return {
          ok: Boolean(root),
          state: root?.getAttribute('data-office-visual-state') || '',
          mode: root?.getAttribute('data-office-preview-mode') || '',
          fidelity: root?.getAttribute('data-office-visual-fidelity') || '',
          format: root?.getAttribute('data-office-visual-format') || '',
          loadState: root?.getAttribute('data-office-visual-load-state') || '',
          frameReady: Boolean(frame?.getAttribute('src')?.startsWith('data:text/html;base64,')),
          frameWidth: frameBounds?.width || 0,
          frameHeight: frameBounds?.height || 0,
          imageComplete: Boolean(img?.complete),
          naturalWidth: img?.naturalWidth || 0,
          naturalHeight: img?.naturalHeight || 0
        };
      })()`
    )
    if (last?.ok && last.state === expectedState && (expectedState !== 'ready' || last.loadState === 'loaded')) return last
    await sleep(150)
  }
  throw new Error(`Office visual state did not become ${expectedState}: ${JSON.stringify(last)}`)
}

async function selectOfficeStructureMode(cdp) {
  const result = await evalValue(
    cdp,
    `(() => {
      const button = document.querySelector('[data-office-preview-mode-option="structure"]');
      if (!button || button.disabled) return { ok: false, disabled: Boolean(button?.disabled) };
      button.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `Office structure mode button unavailable: ${JSON.stringify(result)}`)
  const start = Date.now()
  while (Date.now() - start < 5000) {
    const mode = await evalValue(
      cdp,
      `document.querySelector('[data-office-preview-mode]')?.getAttribute('data-office-preview-mode') || ''`
    )
    if (mode === 'structure') return
    await sleep(100)
  }
  throw new Error('Office preview did not switch to structure mode')
}

async function waitForOfficeUnit(cdp, expected, timeout = 5000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `(() => {
        const root = document.querySelector('[data-office-unit-index]');
        return {
          index: root?.getAttribute('data-office-unit-index') || '',
          total: root?.getAttribute('data-office-unit-total') || '',
          title: root?.getAttribute('data-office-unit-title') || '',
          kind: root?.getAttribute('data-office-unit-kind') || ''
        };
      })()`
    )
    if (
      last?.index === expected.index &&
      last?.total === expected.total &&
      last?.title === expected.title &&
      last?.kind === expected.kind
    ) {
      return last
    }
    await sleep(100)
  }
  throw new Error(`Office unit state mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(last)}`)
}

async function clickOfficeUnitAction(cdp, action) {
  const result = await evalValue(
    cdp,
    `(() => {
      const button = document.querySelector('[data-office-unit-action=${JSON.stringify(action)}]');
      if (!button || button.disabled) return { ok: false, disabled: Boolean(button?.disabled) };
      button.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `Office unit action unavailable: ${action} ${JSON.stringify(result)}`)
  await sleep(150)
}

async function clickPreviewSendCurrentUnit(cdp) {
  const result = await evalValue(
    cdp,
    `(() => {
      const button = document.querySelector('[data-preview-send-current-unit="1"]');
      if (!button || button.disabled) return { ok: false, disabled: Boolean(button?.disabled) };
      button.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `preview current-unit send button unavailable: ${JSON.stringify(result)}`)
  await sleep(250)
}

async function savePreviewNote(cdp, note) {
  const result = await evalValue(
    cdp,
    `(() => {
      const editor = document.querySelector('.preview-annotations textarea');
      const button = document.querySelector('.preview-annotations .browser-annotation-actions button');
      if (!editor || !button) return { ok: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(editor, ${JSON.stringify(note)});
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`
  )
  assert(result?.ok, 'preview annotation editor unavailable')
  await sleep(100)
  const clicked = await evalValue(
    cdp,
    `(() => {
      const button = document.querySelector('.preview-annotations .browser-annotation-actions button');
      if (!button || button.disabled) return { ok: false, disabled: Boolean(button?.disabled) };
      button.click();
      return { ok: true };
    })()`
  )
  assert(clicked?.ok, `preview annotation save button unavailable: ${JSON.stringify(clicked)}`)
}

async function waitForStoredPreviewAnnotation(root, note, timeout = 5000) {
  const annotationRoot = path.join(root, 'preview-annotations')
  const start = Date.now()
  while (Date.now() - start < timeout) {
    for (const filePath of listFiles(annotationRoot)) {
      if (!filePath.endsWith('.json')) continue
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (parsed?.note === note) return parsed
    }
    await sleep(100)
  }
  throw new Error(`stored preview annotation not found: ${note}`)
}

function listFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

async function assertTextAbsent(cdp, text) {
  const present = await evalValue(cdp, `document.body.innerText.includes(${JSON.stringify(text)})`)
  assert(!present, `text should be absent from the current Office unit: ${text}`)
}

async function clickOfficePreviewMode(cdp, mode) {
  const result = await evalValue(
    cdp,
    `(() => {
      const button = document.querySelector('[data-office-preview-mode-option=${JSON.stringify(mode)}]');
      if (!button || button.disabled) return { ok: false, disabled: Boolean(button?.disabled) };
      button.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `Office preview mode button unavailable: ${mode} ${JSON.stringify(result)}`)
  const state = await waitForOfficeVisualState(cdp, 'ready', 5_000)
  assert(state.mode === mode, `Office preview mode did not switch to ${mode}: ${JSON.stringify(state)}`)
}

async function assertPreviewAgentState(cdp, expected, timeout = 5000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `(() => {
        const panel = document.querySelector('.preview-panel');
        if (!panel) return { ok: false, text: document.body.innerText.slice(0, 2000) };
        return {
          ok: true,
          sendable: panel.getAttribute('data-preview-agent-sendable') || '',
          type: panel.getAttribute('data-preview-agent-source-type') || '',
          mode: panel.getAttribute('data-preview-agent-source-mode') || '',
          annotations: panel.getAttribute('data-preview-annotations') || '',
          sendState: panel.getAttribute('data-preview-send-state') || ''
        };
      })()`
    )
    const ok =
      last?.ok &&
      (expected.sendable === undefined || last.sendable === expected.sendable) &&
      (expected.type === undefined || last.type === expected.type) &&
      (expected.mode === undefined || last.mode === expected.mode)
    if (ok) return last
    await sleep(150)
  }
  throw new Error(`preview Agent state mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(last)}`)
}

async function waitForPreviewFailure(cdp, needles, timeout = 5000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `(() => {
        const panel = document.querySelector('.preview-panel');
        const notice = panel?.querySelector('.notice-error.workspace-diff-notice');
        const text = (notice?.innerText || notice?.textContent || '').trim();
        const needles = ${JSON.stringify(needles)};
        const missing = needles.filter((needle) => !text.includes(needle));
        return {
          ok: Boolean(notice) && missing.length === 0,
          missing,
          text,
          sendable: panel?.getAttribute('data-preview-agent-sendable') || '',
          type: panel?.getAttribute('data-preview-agent-source-type') || '',
          mode: panel?.getAttribute('data-preview-agent-source-mode') || ''
        };
      })()`
    )
    if (last?.ok) return last
    await sleep(150)
  }
  throw new Error(`preview failure reason not visible: ${JSON.stringify(last)}`)
}

async function clickPreviewSendToAgent(cdp) {
  const result = await evalValue(
    cdp,
    `(() => {
      const header = document.querySelector('.preview-panel > .workspace-diff-top');
      const button = [...(header?.querySelectorAll('button') ?? [])].find((candidate) =>
        (candidate.innerText || candidate.textContent || '').includes('发给 Agent') && !candidate.disabled
      );
      if (!button) {
        return {
          ok: false,
          state: document.querySelector('.preview-panel')?.getAttribute('data-preview-send-state') || '',
          text: document.body.innerText.slice(0, 2000)
        };
      }
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `preview send button not found or disabled: ${JSON.stringify(result)}`)
  await sleep(250)
}

async function clickProviderEditorSave(cdp) {
  const result = await evalValue(
    cdp,
    `(() => {
      const editor = document.querySelector('.provider-editor');
      const buttons = [...(editor?.querySelectorAll('.provider-editor-actions button') ?? [])];
      const button = buttons.find((candidate) =>
        (candidate.innerText || candidate.textContent || '').trim().includes('保存') && !candidate.disabled
      );
      if (!button) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `provider editor save button not found: ${result?.text ?? ''}`)
  await sleep(300)
}

async function clickSettingsSave(cdp) {
  const result = await evalValue(
    cdp,
    `(() => {
      const page = document.querySelector('.settings-page');
      const actions = page?.querySelector(':scope > .settings-page-actions');
      const button = [...(actions?.querySelectorAll('button') ?? [])].find((candidate) =>
        (candidate.innerText || candidate.textContent || '').trim().includes('保存') && !candidate.disabled
      );
      if (!button) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `settings save button not found: ${result?.text ?? ''}`)
  await sleep(400)
}

async function waitForPreviewSendState(cdp, state, timeout = 5000) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `document.querySelector('.preview-panel')?.getAttribute('data-preview-send-state') || ''`
    )
    if (last === state) return
    await sleep(150)
  }
  throw new Error(`preview send state did not become ${state}: ${last}`)
}

async function waitForLatestUserMessageIncludes(cdp, needles, timeout = 5000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `(() => {
        const nodes = [...document.querySelectorAll('.msg-user-text')];
        const text = nodes.length > 0 ? (nodes[nodes.length - 1].innerText || nodes[nodes.length - 1].textContent || '') : '';
        const needles = ${JSON.stringify(needles)};
        const missing = needles.filter((needle) => !text.includes(needle));
        return { ok: missing.length === 0, missing, text };
      })()`
    )
    if (last?.ok) return
    await sleep(150)
  }
  throw new Error(`latest user message missing preview prompt content: ${JSON.stringify(last)}`)
}

function initGitProject(cwd) {
  git(cwd, ['init', '-q', '-b', 'main'])
  git(cwd, ['config', 'user.email', 'smoke@example.test'])
  git(cwd, ['config', 'user.name', 'CaoGen Page Smoke'])
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-q', '-m', 'initial smoke fixture'])
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

async function waitForWorktreeRecord(userDataDir, timeout = 10_000) {
  const registry = path.join(userDataDir, 'worktrees', 'index.json')
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    if (existsSync(registry)) {
      const raw = JSON.parse(readFileSync(registry, 'utf8'))
      const records = Array.isArray(raw) ? raw : Array.isArray(raw?.records) ? raw.records : []
      last = records.find((record) => record?.state === 'active') ?? records[0] ?? null
      if (last?.worktreePath && existsSync(last.worktreePath)) return last
    }
    await sleep(150)
  }
  throw new Error(`active worktree record not found: ${JSON.stringify(last)}`)
}

async function waitForBrowserViewTargets(remotePort, appTargetId, expectedCount, timeout = 5000) {
  const start = Date.now()
  let last = []
  while (Date.now() - start < timeout) {
    last = await browserViewTargets(remotePort, appTargetId)
    if (last.length === expectedCount) return last
    await sleep(200)
  }
  throw new Error(
    `expected ${expectedCount} browser native target(s), got ${last.length}: ${JSON.stringify(last.map((item) => ({ id: item.id, type: item.type, url: item.url, title: item.title })))} `
  )
}

async function browserViewTargets(remotePort, appTargetId) {
  const targets = await fetchJson(`http://127.0.0.1:${remotePort}/json/list`)
  return targets.filter((item) => {
    if (!item.webSocketDebuggerUrl || item.id === appTargetId) return false
    const url = typeof item.url === 'string' ? item.url : ''
    return url === 'about:blank' || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file:')
  })
}

async function setInputByPlaceholder(cdp, placeholder, value) {
  const result = await evalValue(
    cdp,
    `(() => {
      const el = [...document.querySelectorAll('input, textarea')].find((candidate) => candidate.placeholder === ${JSON.stringify(placeholder)});
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      setter?.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  )
  assert(result === true, `input not found for placeholder: ${placeholder}`)
}

async function setProjectRuleTextarea(cdp, label, value) {
  const result = await evalValue(
    cdp,
    `(() => {
      const labelText = ${JSON.stringify(label)};
      const value = ${JSON.stringify(value)};
      const field = [...document.querySelectorAll('.project-rule-field')].find((candidate) =>
        (candidate.querySelector('span')?.textContent || '').trim() === labelText
      );
      const el = field?.querySelector('textarea');
      if (!el) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`
  )
  assert(result?.ok, `project rule textarea not found: ${label}\n${result?.text ?? ''}`)
  await sleep(150)
}

async function chooseSettingsSelectByLabel(cdp, label, optionText, timeout = 5000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `(() => {
        const labelText = ${JSON.stringify(label)};
        const optionText = ${JSON.stringify(optionText)};
        const labels = [...document.querySelectorAll('.settings-pane label.field-label')];
        for (const label of labels) {
          const clone = label.cloneNode(true);
          for (const child of clone.querySelectorAll('select,input,textarea,option')) child.remove();
          const directText = (clone.textContent || '').replace(/\\s+/g, ' ').trim();
          if (directText !== labelText) continue;
          const select = label.querySelector('select') || (label.nextElementSibling?.tagName === 'SELECT' ? label.nextElementSibling : null);
          const option = [...(select?.options ?? [])].find((candidate) => candidate.textContent.includes(optionText) && !candidate.disabled);
          if (!select || !option) return { ok: false, reason: 'option-missing', label: directText, options: [...(select?.options ?? [])].map((item) => item.textContent) };
          select.value = option.value;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }
        return { ok: false, reason: 'label-missing', labels: labels.map((item) => {
          const clone = item.cloneNode(true);
          for (const child of clone.querySelectorAll('select,input,textarea,option')) child.remove();
          return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
        }) };
      })()`
    )
    if (last?.ok) {
      await sleep(250)
      return
    }
    await sleep(150)
  }
  throw new Error(`settings select option not found: ${label} -> ${optionText}\n${JSON.stringify(last)}`)
}

async function setSettingsCheckbox(cdp, text, checked) {
  const result = await evalValue(
    cdp,
    `(() => {
      const text = ${JSON.stringify(text)};
      const checked = ${JSON.stringify(checked)};
      const label = [...document.querySelectorAll('.settings-pane label.settings-check')].find((candidate) =>
        (candidate.innerText || candidate.textContent || '').includes(text)
      );
      const input = label?.querySelector('input[type="checkbox"]');
      if (!input) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      if (input.checked !== checked) {
        input.scrollIntoView({ block: 'center', inline: 'center' });
        input.click();
      }
      return { ok: true };
    })()`
  )
  assert(result?.ok, `settings checkbox not found: ${text}\n${result?.text ?? ''}`)
  await sleep(250)
}

async function setLatestRoutingRuleField(cdp, field, value) {
  const result = await evalValue(
    cdp,
    `(() => {
      const cards = [...document.querySelectorAll('.routing-rule-card')];
      const card = cards.at(-1);
      const el = card?.querySelector(${JSON.stringify(field)});
      if (!el) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      setter?.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`
  )
  assert(result?.ok, `latest routing rule ${field} not found: ${result?.text ?? ''}`)
  await sleep(150)
}

async function chooseLatestRoutingRuleSelect(cdp, index, optionText, timeout = 5000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('.routing-rule-card')];
        const card = cards.at(-1);
        const select = card?.querySelectorAll('select')?.[${JSON.stringify(index)}];
        const option = [...(select?.options ?? [])].find((candidate) =>
          candidate.textContent.includes(${JSON.stringify(optionText)}) && !candidate.disabled
        );
        if (!select || !option) {
          return {
            ok: false,
            options: [...(select?.options ?? [])].map((item) => item.textContent)
          };
        }
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`
    )
    if (last?.ok) {
      await sleep(250)
      return
    }
    await sleep(150)
  }
  throw new Error(`latest routing rule select option not found: #${index} -> ${optionText}\n${JSON.stringify(last)}`)
}

async function setLatestRoutingRuleTask(cdp, text, checked) {
  const result = await evalValue(
    cdp,
    `(() => {
      const cards = [...document.querySelectorAll('.routing-rule-card')];
      const card = cards.at(-1);
      const label = [...(card?.querySelectorAll('.routing-rule-task-option') ?? [])].find((candidate) =>
        (candidate.innerText || candidate.textContent || '').trim() === ${JSON.stringify(text)}
      );
      const input = label?.querySelector('input[type="checkbox"]');
      if (!input) return { ok: false, text: card?.innerText || document.body.innerText.slice(0, 2000) };
      if (input.checked !== ${JSON.stringify(checked)}) input.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `latest routing rule task not found: ${text}\n${result?.text ?? ''}`)
  await sleep(200)
}

async function chooseProviderEditorSelectOption(cdp, text) {
  const result = await evalValue(
    cdp,
    `(() => {
      const editor = document.querySelector('.provider-editor');
      const needle = ${JSON.stringify(text)};
      for (const select of editor?.querySelectorAll('select') ?? []) {
        const option = [...select.options].find((candidate) => candidate.textContent.includes(needle) && !candidate.disabled);
        if (!option) continue;
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      return { ok: false, text: editor?.innerText || document.body.innerText.slice(0, 2000) };
    })()`
  )
  assert(result?.ok, `provider editor select option not found: ${text}\n${result?.text ?? ''}`)
  await sleep(250)
}

async function chooseSelectOptionByText(cdp, text, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await evalValue(
      cdp,
      `(() => {
        const needle = ${JSON.stringify(text)};
        for (const select of document.querySelectorAll('select')) {
          const rect = select.getBoundingClientRect();
          const style = window.getComputedStyle(select);
          if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
          const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (top !== select && !select.contains(top)) continue;
          const option = [...select.options].find((candidate) => candidate.textContent.includes(needle) && !candidate.disabled);
          if (!option) continue;
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      })()`
    )
    if (result === true) return
    await sleep(150)
  }
  throw new Error(`select option not found: ${text}`)
}

async function focusComposer(cdp) {
  const ok = await evalValue(
    cdp,
    `(() => {
      const el = document.querySelector('.composer-input');
      if (!el) return false;
      el.focus();
      return true;
    })()`
  )
  assert(ok === true, 'composer input not found')
}

async function typeText(cdp, text) {
  for (const char of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: char })
  }
  await sleep(250)
}

async function press(cdp, key) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key })
  await sleep(250)
}

async function waitForText(cdp, text, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const body = await visibleText(cdp)
    if (body.includes(text)) return
    await sleep(150)
  }
  const body = await visibleText(cdp)
  throw new Error(`text not found: ${text}\nVisible text:\n${body.slice(0, 2000)}`)
}

async function waitForAriaLabel(cdp, label, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const found = await evalValue(
      cdp,
      `!!document.querySelector('[aria-label=${JSON.stringify(label)}]')`
    )
    if (found) return
    await sleep(150)
  }
  throw new Error(`aria-label not found: ${label}`)
}

async function waitForNoAriaLabel(cdp, label, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const found = await evalValue(
      cdp,
      `!!document.querySelector('[aria-label=${JSON.stringify(label)}]')`
    )
    if (!found) return
    await sleep(150)
  }
  throw new Error(`aria-label still found: ${label}`)
}

async function waitForCanvasPixels(cdp, timeout = 10_000) {
  const start = Date.now()
  let lastStats = null
  while (Date.now() - start < timeout) {
    lastStats = await evalValue(
      cdp,
      `(() => {
        const canvas = document.querySelector('.office canvas');
        if (!canvas) return { canvas: false };
        const width = canvas.width;
        const height = canvas.height;
        const rect = canvas.getBoundingClientRect();
        const parents = [];
        let node = canvas;
        for (let i = 0; i < 4 && node; i++) {
          const nodeRect = node.getBoundingClientRect?.();
          const style = window.getComputedStyle(node);
          parents.push({
            tag: node.tagName,
            className: node.className || '',
            width: nodeRect?.width ?? 0,
            height: nodeRect?.height ?? 0,
            offsetWidth: node.offsetWidth ?? 0,
            offsetHeight: node.offsetHeight ?? 0,
            styleWidth: style.width,
            styleHeight: style.height,
            display: style.display,
            position: style.position
          });
          node = node.parentElement;
        }
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl || width < 100 || height < 100 || rect.width < 300 || rect.height < 200) {
          return { canvas: true, hidden: document.hidden, hasFocus: document.hasFocus(), gl: Boolean(gl), width, height, rectWidth: rect.width, rectHeight: rect.height, parents, colorSum: 0, alphaSum: 0, dataUrlLength: canvas.toDataURL('image/png').length };
        }
        const xs = [0.18, 0.33, 0.5, 0.67, 0.82];
        const ys = [0.2, 0.38, 0.55, 0.72, 0.88];
        const pixel = new Uint8Array(4);
        let colorSum = 0;
        let alphaSum = 0;
        let samples = 0;
        for (const xRatio of xs) {
          for (const yRatio of ys) {
            const x = Math.max(0, Math.min(width - 1, Math.floor(width * xRatio)));
            const y = Math.max(0, Math.min(height - 1, Math.floor(height * yRatio)));
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            colorSum += pixel[0] + pixel[1] + pixel[2];
            alphaSum += pixel[3];
            samples += 1;
          }
        }
        return { canvas: true, hidden: document.hidden, hasFocus: document.hasFocus(), gl: true, width, height, rectWidth: rect.width, rectHeight: rect.height, parents, colorSum, alphaSum, samples, dataUrlLength: canvas.toDataURL('image/png').length };
      })()`
    )
    if (
      lastStats?.canvas &&
      lastStats.width >= 100 &&
      lastStats.height >= 100 &&
      (lastStats.rectWidth ?? 0) >= 300 &&
      (lastStats.rectHeight ?? 0) >= 200
    ) {
      if ((lastStats.colorSum ?? 0) > 500 || (lastStats.dataUrlLength ?? 0) > 10_000) return lastStats
    }
    await sleep(300)
  }
  throw new Error(`3D office canvas did not become visibly nonblank: ${JSON.stringify(lastStats)}`)
}

async function waitForOfficeTelemetry(cdp, timeout = 10_000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `(() => {
        const wrap = document.querySelector('.office-canvas-wrap');
        const panel = document.querySelector('.office-selection-panel');
        const num = (name) => Number(wrap?.getAttribute(name) ?? 0);
        return {
          ok: Boolean(wrap),
          sessions: num('data-office-sessions'),
          isolatedSessions: num('data-office-isolated-sessions'),
          workspaceChangedFiles: num('data-office-workspace-changed-files'),
          gitTrackedSessions: num('data-office-git-tracked-sessions'),
          gitDirtySessions: num('data-office-git-dirty-sessions'),
          gitFiles: num('data-office-git-files'),
          gitStaged: num('data-office-git-staged'),
          gitUnstaged: num('data-office-git-unstaged'),
          gitUntracked: num('data-office-git-untracked'),
          routedSessions: num('data-office-routed-sessions'),
          failoverSessions: num('data-office-failover-sessions'),
          totalDurationMs: num('data-office-total-duration-ms'),
          routingBudgetPanels: num('data-office-routing-budget-panels'),
          clickableWorkstations: num('data-office-clickable-workstations'),
          oneRobotPerAgent: num('data-office-one-robot-per-agent'),
          selectedSession: wrap?.getAttribute('data-office-selected-session') || '',
          selectedPanelText: (panel?.innerText || panel?.textContent || '').replace(/\\s+/g, ' ').trim(),
          canvas: Boolean(document.querySelector('.office canvas'))
        };
      })()`
    )
    const ok =
      last?.ok &&
      last.sessions >= 1 &&
      last.isolatedSessions >= 1 &&
      last.workspaceChangedFiles >= 1 &&
      last.gitTrackedSessions >= 1 &&
      last.gitDirtySessions >= 1 &&
      last.gitFiles >= 1 &&
      last.gitUntracked >= 1 &&
      last.routedSessions + last.failoverSessions >= 1 &&
      last.totalDurationMs >= 1 &&
      last.routingBudgetPanels >= 1 &&
      last.clickableWorkstations >= last.sessions &&
      last.oneRobotPerAgent === 1 &&
      last.selectedSession &&
      [PAGE_SMOKE_MODEL, 'caogen-relay-fast', 'caogen-relay-strong'].some((model) => last.selectedPanelText.includes(model)) &&
      last.selectedPanelText.includes('文件 1') &&
      last.canvas
    if (ok) return last
    await sleep(250)
  }
  throw new Error(`3D office telemetry did not reflect live session/worktree/git state: ${JSON.stringify(last)}`)
}

async function bringPageToFront(cdp) {
  await cdp.send('Page.bringToFront').catch(() => undefined)
  await evalValue(cdp, `(() => { window.focus(); return true; })()`).catch(() => undefined)
  await sleep(100)
}

async function visibleText(cdp) {
  return evalValue(cdp, 'document.body.innerText')
}

async function evalValue(cdp, expression) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text || 'Runtime.evaluate failed')
      }
      return response.result?.value
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('CDP timeout') || attempt > 0) break
      report.warnings.push(`Runtime.evaluate timeout, retrying once: ${expression.slice(0, 120)}`)
      await cdp.send('Page.bringToFront').catch(() => undefined)
      await sleep(500)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function waitForTarget(remotePort, timeout) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${remotePort}/json/list`)
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) return target
    } catch {
      // Electron may still be booting.
    }
    await sleep(250)
  }
  throw new Error(`remote debugging target not available on port ${remotePort}`)
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.json()
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free remote debugging port from ${start}`)
}

function isPortFree(port) {
  return new Promise((resolve) => {
    import('node:net').then(({ createServer }) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
  })
}

async function terminate(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  child.kill('SIGTERM')
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: child.exitCode, signal: 'SIGKILL' })
    }, 3000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
  return result
}

function summarizeProcessOutput(out, err, exit) {
  const warnings = []
  if (exit.signal && exit.signal !== 'SIGTERM') warnings.push(`electron exited via ${exit.signal}`)
  const cleanErr = err.trim()
  if (cleanErr) warnings.push(cleanErr.split('\n').slice(-8).join('\n'))
  const cleanOut = out.trim()
  if (cleanOut) warnings.push(cleanOut.split('\n').slice(-8).join('\n'))
  return warnings
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function cleanupTempRoot(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    console.warn(`temporary cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function electronSpawnCommand() {
  return electronBin
}

function electronSpawnArgs(args) {
  return args
}

function createZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt32LE(offset, 42)

    localParts.push(local, nameBuffer, data)
    centralParts.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }

  const centralOffset = offset
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatConsoleArgs(args = []) {
  return args
    .map((arg) => {
      if (typeof arg.value === 'string') return arg.value
      if (arg.value !== undefined) return JSON.stringify(arg.value)
      return arg.description || arg.type || ''
    })
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000)
}

function formatExceptionDetails(details = {}) {
  const parts = []
  if (details.text) parts.push(details.text)
  const exception = details.exception ?? {}
  if (exception.description) {
    parts.push(exception.description)
  } else if (exception.value !== undefined) {
    parts.push(String(exception.value))
  } else if (exception.type) {
    parts.push(exception.type)
  }
  const frame = details.stackTrace?.callFrames?.[0]
  if (frame) {
    const location = `${frame.url || '<anonymous>'}:${Number(frame.lineNumber ?? -1) + 1}:${Number(frame.columnNumber ?? -1) + 1}`
    parts.push(`at ${frame.functionName || '<anonymous>'} (${location})`)
  }
  return parts.filter(Boolean).join(' | ').slice(0, 1500) || JSON.stringify(details)
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    const listeners = new Map()

    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      if (!data.id && data.method) {
        const callbacks = listeners.get(data.method) ?? []
        for (const callback of callbacks) callback(data.params ?? {})
        return
      }
      if (!data.id || !pending.has(data.id)) return
      const item = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) item.reject(new Error(data.error.message || JSON.stringify(data.error)))
      else item.resolve(data.result ?? {})
    })
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++
          ws.send(JSON.stringify({ id, method, params }))
          return new Promise((resolveSend, rejectSend) => {
            pending.set(id, { resolve: resolveSend, reject: rejectSend })
            const timeoutMs = method === 'Runtime.evaluate' ? 30_000 : 15_000
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id)
                rejectSend(new Error(`CDP timeout: ${method}`))
              }
            }, timeoutMs)
          })
        },
        on(method, callback) {
          const callbacks = listeners.get(method) ?? []
          callbacks.push(callback)
          listeners.set(method, callbacks)
        },
        close() {
          ws.close()
        }
      })
    }, { once: true })
    ws.addEventListener('error', () => reject(new Error('DevTools WebSocket connection failed')), { once: true })
  })
}
