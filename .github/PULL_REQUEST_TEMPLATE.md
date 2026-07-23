## Summary / 变更摘要

<!-- What changed? Keep this concrete and user-visible where possible. / 改了什么？尽量写清用户可见结果。 -->

## Why / 背景

<!-- Which issue or workflow problem does this solve? / 解决哪个 Issue 或流程问题？ -->

Closes #

## Capability boundary / 能力边界

- Current behavior before this PR / PR 前当前行为：
- Behavior after this PR / PR 后行为：
- Roadmap or still under construction / 仍属路线图或建设中的部分：

## Scope / 改动范围

- Files or modules changed / 修改的文件或模块：
- Explicitly out of scope / 明确不做：
- Core ledger impact / 核心账本影响：None / 无

## Six-link architecture check / 六环链路检查

Mark changed links and explain any intentional `N/A`.

- [ ] Main process: `src/main/*`
- [ ] IPC: `src/main/ipc.ts` or `src/main/ipc/*`
- [ ] Preload: `src/preload/*`
- [ ] Shared types: `src/shared/*`
- [ ] Renderer store: `src/renderer/src/store.ts` or `src/renderer/src/store/*`
- [ ] UI: `src/renderer/src/components/*`
- [ ] Documentation-only or none of the six links / 仅文档或不涉及六环

## Verification / 验证

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] Targeted smoke or test / 聚焦 smoke 或测试：`________________`
- [ ] UI screenshots or recording attached when relevant / UI 改动已附截图或录屏

Not run and why / 未运行项及原因：

## Risk and rollback / 风险与回退

- Main risk / 主要风险：
- Rollback approach / 回退方式：

## Manual repository settings / 需要人工完成的仓库设置

- [ ] If `docs/social-preview.png` changed, a maintainer must upload it manually in GitHub **Settings → General → Social preview**. A PR cannot apply this setting automatically. / 如果修改了 `docs/social-preview.png`，维护者必须在 GitHub **Settings → General → Social preview** 手工上传，PR 无法自动应用该设置。
- [ ] No manual repository setting is required / 不需要人工仓库设置

## Final checklist / 最终确认

- [ ] The PR is focused and does not include unrelated formatting or refactors.
- [ ] User-visible strings preserve zh/en parity.
- [ ] No API keys, tokens, private data, or sensitive local paths are included.
- [ ] No signing credentials, `.env`, or release flow were changed.
- [ ] Roadmap work is not described as currently shipped.
- [ ] Effect/Workflow Ledger internals are untouched, or the issue contains an agreed maintainer-owned verification plan.
- [ ] Documentation and links match the current repository state.
