# CaoGen good first issue drafts

These are reviewed drafts for maintainers to create as real GitHub issues. They are intentionally scoped outside the Effect Ledger, Workflow Ledger, acceptance/recovery core, and release/signing paths.

这些草稿供维护者人工创建为 GitHub Issue。所有任务都刻意避开 Effect Ledger、Workflow Ledger、验收/恢复核心和发布签名链路。

## Repository evidence used

The drafts were checked against the current worktree with `wc -l` and `rg`:

- Provider presets live in the 4,016-line `src/renderer/src/store.ts`; `scripts/provider-presets-smoke.mjs` is 33 lines. A StepFun logo exists, but there is no StepFun entry in `PROVIDER_PRESETS`.
- `src/main/previewOps.ts` is 742 lines. Its extension map includes JSON/CSV/Markdown/text but not `.yaml`, `.yml`, or `.toml`.
- `src/renderer/src/i18n.ts` is 798 lines and stores paired `{ zh, en }` values; no dedicated i18n parity script exists.
- `BrowserPanel.tsx` is 222 lines. Its back/forward arrow-only buttons do not have `aria-label` or `title`.
- `src/renderer/src/format.ts` is a 30-line pure helper module with no dedicated smoke test.
- `RoutinePanel.tsx` is 456 lines and still contains hard-coded Chinese failure/status strings.
- The repository does **not** use Monaco. Markdown highlighting is implemented by the 30-line `Markdown.tsx` with `rehype-highlight` and `highlight.js`, so draft 7 uses the real stack instead of inventing a Monaco task.
- `ToolCallCard.tsx` is 220 lines and renders tool output without a copy action.
- Provider connectivity currently uses the 317-line `modelDiscovery.ts`; `provider-connectivity-smoke.mjs` is 55 lines and mostly asserts source wiring rather than exercising a gateway through a local HTTP fixture.
- The focused provider and preview smoke scripts have no contributor-facing documentation.

## Shared boundaries for all ten issues

- Do not modify `src/main/task/effect-*`, `src/main/task/workflow-ledger-*`, acceptance/recovery modules, signing credentials, `.env`, or release configuration.
- Do not make real paid model calls. Network behavior must use a local mock server or an explicitly manual test.
- Keep the PR focused and run `npm run typecheck && npm run build` plus the targeted command listed in the issue.
- Preserve Chinese and English UI parity for every user-visible string.

---

## 1. Add a StepFun provider preset

**中文摘要：** 按现有模板结构新增“阶跃星辰 / StepFun”Provider 预设，不改凭据存储或路由核心。

### Why

CaoGen already includes a StepFun provider logo, but `PROVIDER_PRESETS` has no StepFun configuration. A preset would reduce setup friction for a domestic provider without changing runtime behavior.

### Suggested scope

- Verify the current official StepFun API base URL, protocol compatibility, and model naming from StepFun's documentation before coding.
- Add one StepFun entry to `PROVIDER_PRESETS` using the existing `ProviderPreset` shape.
- Keep the hint explicit that users bring their own key and that live model names should be confirmed with “Fetch models”.
- Extend `scripts/provider-presets-smoke.mjs` to check the new preset's engine, protocol, base URL shape, and non-empty setup hint.

### Suggested files

- `src/renderer/src/store.ts`
- `scripts/provider-presets-smoke.mjs`

### Acceptance criteria

- The preset appears in the Provider editor and does not become a hidden default Provider.
- The preset uses only a documented official or compatible endpoint.
- No API key, token, or credential header is hard-coded.
- `node scripts/provider-presets-smoke.mjs` passes.
- `npm run typecheck && npm run build` passes.

### Out of scope

Provider credential storage, automatic billing data, routing policy, failover behavior, and real-network validation.

Suggested labels: `good first issue`, `provider`, `china-ecosystem`, `help wanted`

---

## 2. Preview `.yaml` and `.yml` files as text

**中文摘要：** 给工作台文件预览增加 YAML 文本预览，保持只读，不引入 YAML 执行或反序列化。

### Why

The preview extension map supports common text formats but currently treats `.yaml` and `.yml` as unknown. YAML files are common in CI, deployment, and agent configuration workflows.

### Suggested scope

- Add `.yaml` and `.yml` to `PREVIEW_BY_EXTENSION` as read-only text previews.
- Use a safe text MIME and the existing bounded text-reading path.
- Add fixtures to `scripts/preview-ops-smoke.mjs` that verify type, MIME, content, and path boundaries.
- Update README capability wording only if needed; do not claim YAML editing or semantic parsing.

### Suggested files

- `src/main/previewOps.ts`
- `scripts/preview-ops-smoke.mjs`

### Acceptance criteria

- Both extensions open in the existing text preview.
- Large-file truncation and project-path checks remain unchanged.
- YAML content is displayed as text and is never executed or deserialized.
- `node scripts/preview-ops-smoke.mjs` passes.
- `npm run typecheck && npm run build` passes.

### Out of scope

YAML editing, schema validation, formatting, code generation, or Office preview changes.

Suggested labels: `good first issue`, `preview`, `desktop`, `help wanted`

---

## 3. Add an automated zh/en translation parity smoke test

**中文摘要：** 新增 i18n 双语完整性检查，阻止空翻译、只有中文或只有英文的字典项进入主分支。

### Why

The current dictionary shape pairs Chinese and English values, but there is no dedicated repository check for empty strings, malformed entries, or modular translation dictionaries that are defined but not merged.

### Suggested scope

- Add `scripts/i18n-parity-smoke.mjs` using the already-installed TypeScript parser or another existing dependency.
- Inspect `src/renderer/src/i18n.ts` and `src/renderer/src/i18n/*.ts` without evaluating application runtime code.
- Fail on a missing/empty `zh` value, missing/empty `en` value, duplicate key in the merged dictionary, or a translation module that is never merged.
- Add `test:i18n-parity` to `package.json`.
- Include small synthetic parser fixtures inside the smoke script so failure behavior is tested without modifying production dictionaries.

### Suggested files

- `scripts/i18n-parity-smoke.mjs`
- `package.json`
- `src/renderer/src/i18n.ts` only if a small export or marker is needed

### Acceptance criteria

- The current dictionary passes.
- Synthetic missing-Chinese, missing-English, empty-string, and duplicate-key cases fail with readable messages.
- The script does not require Electron, a browser, network access, or API keys.
- `npm run test:i18n-parity` passes.
- `npm run typecheck && npm run build` passes.

### Out of scope

Rewriting the i18n library, translating the whole application, or moving all strings in one PR.

Suggested labels: `good first issue`, `i18n`, `testing`, `help wanted`

---

## 4. Add accessible names and tooltips to browser navigation buttons

**中文摘要：** 为工作台浏览器的后退/前进图标按钮补齐中英 tooltip 和 `aria-label`。

### Why

`BrowserPanel.tsx` renders back and forward as arrow-only buttons. They are visually familiar but are unnamed for screen readers and provide no hover explanation.

### Suggested scope

- Add Chinese and English i18n keys for browser Back and Forward.
- Add matching `aria-label` and `title` attributes to the two arrow buttons.
- Preserve disabled states based on `canGoBack` and `canGoForward`.
- Add or extend a focused static/UI smoke assertion for the accessible names.

### Suggested files

- `src/renderer/src/components/workbench/BrowserPanel.tsx`
- `src/renderer/src/i18n.ts`
- a focused existing browser/page smoke script

### Acceptance criteria

- Both arrow-only buttons have localized accessible names and hover tooltips.
- Keyboard focus and disabled behavior remain unchanged.
- No new visible text is added beside the icons.
- The targeted smoke passes.
- `npm run typecheck && npm run build` passes.

### Out of scope

Browser history implementation, URL handling, DOM picking, screenshots, and network observation.

Suggested labels: `good first issue`, `accessibility`, `workbench`, `help wanted`

---

## 5. Add a smoke test for renderer formatting helpers

**中文摘要：** 给 `formatCost`、`formatTokens`、`formatDuration` 和 `basename` 增加纯函数 smoke 测试。

### Why

`src/renderer/src/format.ts` is small, widely reused, and currently lacks a dedicated focused test. It is a low-risk entry point for learning CaoGen's smoke-test style.

### Suggested scope

- Add `scripts/renderer-format-smoke.mjs` following the compile-and-import pattern in `scripts/preview-utils-smoke.mjs`.
- Cover zero/negative values, sub-cent costs, regular costs, thousands/millions of tokens, millisecond/second durations, Windows paths, POSIX paths, and trailing separators.
- Avoid locale-sensitive `formatTime` assertions unless the test pins locale/timezone safely.
- Add `test:renderer-format` to `package.json`.

### Suggested files

- `scripts/renderer-format-smoke.mjs`
- `package.json`
- `src/renderer/src/format.ts` only if a test exposes a real edge-case bug

### Acceptance criteria

- The test is deterministic on macOS, Windows, and Linux CI environments.
- No Electron window, network, or API key is required.
- `npm run test:renderer-format` passes.
- `npm run typecheck && npm run build` passes.

### Out of scope

Changing product currency policy, token accounting, cost calculation, or timestamps stored by sessions.

Suggested labels: `good first issue`, `testing`, `renderer`, `help wanted`

---

## 6. Make Routine failure copy actionable and bilingual

**中文摘要：** 清理 Routine 面板里硬编码的“失败/错误/上次运行失败”，改为中英一致且能指导下一步的文案。

### Why

`RoutinePanel.tsx` contains hard-coded Chinese status and fallback error strings. In English mode, users can still see Chinese, and “Last run failed” does not explain where to inspect details or retry.

### Suggested scope

- Add focused zh/en i18n entries for Routine error, failed status, and the fallback “last run failed” message.
- Replace only the hard-coded failure/status strings in `RoutinePanel.tsx`.
- Keep real `lastError` content unchanged when it exists.
- Make the fallback message point users to the run details/log already available in the panel; do not invent a new recovery workflow.

### Suggested files

- `src/renderer/src/components/workbench/RoutinePanel.tsx`
- `src/renderer/src/i18n.ts`
- an existing Routine smoke script

### Acceptance criteria

- English mode contains no Chinese fallback failure copy in the Routine panel.
- Chinese and English messages communicate the same action.
- Existing run status logic and stored errors are unchanged.
- The targeted Routine smoke passes.
- `npm run typecheck && npm run build` passes.

### Out of scope

Routine scheduling, execution, permissions, run storage, or cloud runners.

Suggested labels: `good first issue`, `i18n`, `routines`, `help wanted`

---

## 7. Add TOML code-fence highlighting to the existing Markdown renderer

**中文摘要：** 仓库没有 Monaco；请基于现有 `highlight.js` 栈让 ` ```toml ` 代码块稳定高亮。

### Why

CaoGen uses `react-markdown`, `rehype-highlight`, and `highlight.js`, not Monaco. TOML is common in Rust, Python, and tool configuration, but the renderer does not explicitly register a TOML language/alias.

### Suggested scope

- Register a TOML-compatible language definition or alias with the existing `rehype-highlight` configuration.
- Prefer an existing `highlight.js` language module; do not add a large editor dependency.
- Add a focused renderer/static smoke fixture for a fenced `toml` block.
- Keep `ignoreMissing: true` behavior for unknown languages.

### Suggested files

- `src/renderer/src/components/Markdown.tsx`
- a focused Markdown renderer smoke script

### Acceptance criteria

- A fenced block labeled `toml` receives highlight classes and remains readable.
- Unknown language fences still render without crashing.
- The change does not import Monaco or another full editor.
- The targeted smoke passes.
- `npm run typecheck && npm run build` passes.

### Out of scope

Replacing the Markdown renderer, changing raw HTML safety, or adding a full code editor.

Suggested labels: `good first issue`, `markdown`, `syntax-highlighting`, `help wanted`

---

## 8. Add “Copy output” to tool result cards

**中文摘要：** 在工具结果卡片中加入复制输出按钮，带中英文案、成功状态和可访问名称。

### Why

`ToolCallCard.tsx` shows tool output in a `<pre>` block but requires manual text selection. Long command, search, and file-tool results are frequently copied into issues, notes, or follow-up prompts.

### Suggested scope

- Add a compact copy action beside the result label or below the result.
- Copy the full `resultText`, not only the truncated preview.
- Add localized “Copy output”, “Copied”, and failure text.
- Add an accessible name and a short-lived success state that does not resize the card.
- Handle missing Clipboard API or write failures without crashing.

### Suggested files

- `src/renderer/src/components/ToolCallCard.tsx`
- `src/renderer/src/i18n.ts`
- styles and a focused UI/static smoke script

### Acceptance criteria

- Copy uses the full result, including when “show all” has not been clicked.
- Empty results disable or hide the action.
- Success/failure feedback is bilingual and accessible.
- Tool execution, reconciliation status, and Diff behavior are unchanged.
- The targeted smoke passes.
- `npm run typecheck && npm run build` passes.

### Out of scope

Changing tool output storage, redaction policy, Effect reconciliation, or result truncation limits.

Suggested labels: `good first issue`, `ux`, `tools`, `help wanted`

---

## 9. Exercise one-api/new-api gateway connectivity with a local mock server

**中文摘要：** 用本地 HTTP fixture 验证 one-api/new-api 预设的 `/v1/models` 连通性，不请求真实服务、不产生费用。

### Why

The Provider UI already has a connectivity probe, and the one-api/new-api preset points at a gateway root. The current 55-line smoke mostly checks source wiring; it does not execute model discovery against a gateway-shaped endpoint.

### Suggested scope

- Extend `scripts/provider-connectivity-smoke.mjs` or add a focused companion script that starts a local HTTP server.
- Exercise a gateway root where model discovery succeeds through `/v1/models`.
- Cover at least one auth failure and one rate-limit/server classification with synthetic responses.
- Assert that credentials are sent only to the local fixture and never printed.
- Do not call a real one-api/new-api deployment or send a chat/completion request.

### Suggested files

- `scripts/provider-connectivity-smoke.mjs` or a new focused gateway smoke
- `src/main/provider/modelDiscovery.ts` only if the fixture reveals a real compatibility bug
- `package.json` if a new command is added

### Acceptance criteria

- The test runs offline against `127.0.0.1` on an ephemeral port.
- A gateway root resolves the expected `/v1/models` candidate and returns parsed model IDs.
- 401/403, 429, and 5xx responses keep their current structured error kinds.
- No real key, service, or paid generation is required.
- The targeted smoke passes.
- `npm run typecheck && npm run build` passes.

### Out of scope

Gateway account management, billing, routing, failover, credential persistence, or external network validation.

Suggested labels: `good first issue`, `provider`, `gateway`, `testing`, `help wanted`

---

## 10. Document the provider connectivity smoke script

**中文摘要：** 为 `provider-connectivity-smoke.mjs` 写一页贡献者文档，说明用途、运行方式、无真实网络边界和常见失败。

### Why

The provider connectivity smoke is short and important, but a new contributor must read the source to understand what it proves, what it does not prove, and how to extend it safely.

### Suggested scope

- Add `docs/testing/provider-connectivity-smoke.md`.
- Explain the command, files inspected/executed, expected output, and common failure messages.
- State clearly that the current smoke is local and does not prove a real provider account, quota, China network path, or release readiness.
- Explain how to add a synthetic fixture without logging credentials.
- Link the page from `CONTRIBUTING.md` or a small testing index.

### Suggested files

- `docs/testing/provider-connectivity-smoke.md`
- `CONTRIBUTING.md` or an existing testing index

### Acceptance criteria

- A new contributor can run the smoke and interpret a failure without reading the script first.
- The document distinguishes static/source assertions, local mock coverage, and real external validation.
- No real API key instructions are added.
- All links and commands are valid.
- `npm run typecheck && npm run build` passes.

### Out of scope

Changing the smoke's behavior, running external provider tests, or documenting the entire Deep suite.

Suggested labels: `good first issue`, `documentation`, `testing`, `help wanted`
