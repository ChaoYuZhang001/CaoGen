# CaoGen 开发与发布计划

> 制定日期：2026-07-22
> 配套：[`EXECUTION-PLAN.md`](./EXECUTION-PLAN.md)（战略/GTM）· 本文件是**工程与发布**执行计划
> 事实基线以 [`STATUS.md`](../STATUS.md) 为准

---

## 0. 现状与核心问题

- v0.1.6 macOS x64 已发布但**未签名**；`package.json` 已到 `1.0.0` 本地候选，但不是 1.0 stable。
- 签名/公证管线**已跑通**（notarytool 已向 Apple 认证成功），但被锁在**面向全部 1.0 的 Release Doctor 门禁**后面（要求 clean-commit Deep、64 个 P0 产品验收、真实 Provider release record、N1、secret-history 全部绑定到干净发布 commit）。
- worktree 长期 dirty（456 status entries），"干净候选"永远凑不齐 → **没有任何签名/stable 产物能发出去**。

**核心问题：发布门禁被按"全功能 1.0 stable"标准设计，把"发一个能装的签名 beta"这件小事也一起锁死了。**

**解法：把发布门禁分成两层——轻量 Beta 门禁（本周可发） vs 重量 1.0 Stable 门禁（延后到有牵引力之后）。**

---

## 1. 版本策略

### 1.1 版本号（建议）

| 版本 | 含义 | 门禁 |
|---|---|---|
| **0.2.0** | 签名楔子版——今天能用的一切，诚实标 beta | Beta 门禁（§3.1） |
| 0.2.x / 0.3.x | 楔子随真实用户迭代 | Beta 门禁 |
| **1.0.0** | **重新定义**为"第一个真人能依赖来做真实工作的稳定版"（= 被用户验证过的楔子），**不是** 42 个立项目标全做完 | 1.0 Stable 门禁（§3.5） |
| 2.0 | Agent Work OS 完整愿景（数字员工、canonical ledger、水墨 3D） | 长期 |

**动作：把 `package.json` 从 `1.0.0` 回退到 `0.2.0`。** 0.2.0 > 已发布的 0.1.6，更新源单调递增不受影响；未发布的本地 1.0.0 不影响 update feed。**别把"1.0"这个招牌烧在一个还没人用过的本地候选上。**

### 1.2 两层发布门禁

- **Beta 门禁**：只证明"这个包能装、能跑、不含密钥、签名有效"。本周可过。
- **1.0 Stable 门禁**：现有 Release Doctor 全套（产品验收、N1、真实 Provider record…）。**延后**，是 2.0/验证后的事。

---

## 2. 开发计划

### 2.1 楔子 Feature Freeze — 0.2 里包含什么

**冻结范围（只这些，不再加新大功能）：** 多 Provider/BYOK/自定义 Base URL、智能路由（四策略）+ 同 Provider 换 Key + 跨厂商 failover、worktree 隔离、工作台（终端/浏览器/Diff/Git/文件编辑/Office 预览）、3D 办公区（机器人版）、项目/会话管理、本地 Routine、记忆建议、插件/Skill/MCP 扫描。

**这些已经能用。0.2 的开发不是加功能，是让上面这些更稳、更好装、更好上手。**

### 2.2 必做开发项（按优先级）

| 优先级 | 项目 | 说明 | 负责人 |
|---|---|---|---|
| **P0** | 发布门禁降级 | 实现 §3.1 Beta 门禁脚本（可复用现有 `test:deep`/`test:page`/`packaged-app`/`secret:scan`/`macos-release-preflight`），与 Release Doctor 解耦 | 创始人 |
| **P0** | 楔子主链路 bug 清零 | 沿"加 key → 选模型 → @文件 → 跑任务 → 看 Diff → 提交"这条真实路径手动走一遍，修掉所有卡点 | 创始人 |
| **P0** | 版本号回退 0.2.0 + update feed 连续性 | 见 §1.1，验证 `latest-mac.yml` 链路 | 创始人 |
| **P1** | 首次启动/onboarding 打磨 | 发布获客后新用户第一屏体验：空状态引导加 Provider、"只读第一个任务"安全上手 | 创始人 |
| **P1** | 贡献者友好重构（拆大文件） | 与 Sol 的 §4 任务 7 同一件事，降低外部 PR 门槛 | Sol |
| **P2** | 路由/成本可读性小优化 | 调度理由、成本气泡的文案清晰度 | 任意 |

### 2.3 立刻暂停的开发项（对 0 用户是过早优化）

- Effect Ledger v9 / reconciler 扩展 / 补偿执行
- Canonical Conversation Ledger、跨 Provider 上下文账本
- Native Runtime 统一 / 协议 Adapter 重构
- 数字员工 / Goal-WorkItem-Acceptance 生命周期
- 水墨 3D 美术

> 这些是 2.0 的核心，但要**等有真实用户、有数据要保护、有团队/融资**再回来做。现在每投一小时在这上面，就少一小时在"让人用上"。

### 2.4 分支与提交纪律

- `main` 保持可构建；每个发布从 **一个干净 commit 打 tag**（`v0.2.0`），**只要该 commit 干净，不要求整个 worktree 历史干净**。
- 保留六环链路：主进程 → IPC → preload → types → store → UI 全通才算接通。
- 每任务独立提交，信息写"做了什么 + 怎么验证"。
- 发布分支：从 tag 出包，不在 dirty worktree 上出正式包。

### 2.5 迭代节奏

- **周更 patch**（0.2.x）：真实用户报的 bug 当周修当周发。
- **月更 minor**（0.3.0…）：用户投票最多的改进。
- 功能优先级从阶段 4 起由**用户需求**排，不由需求文档 42 目标排。

---

## 3. 发布计划

### 3.1 Beta 发布门禁（轻量，本周可过）

签名楔子版必须且只需通过这些——**全部用现有脚本**：

1. 从干净 commit 打 tag（只需该 commit 干净）
2. `npm run typecheck` ✅
3. `npm run build` ✅
4. `npm run test:deep` — required 全绿（当前 147 required pass / 0 fail）
5. `npm run test:page` — Electron 页面流 ✅
6. `test:packaged-app:mac` — 成品从全新用户目录真实启动出 CaoGen renderer ✅
7. `release-packaging-audit` — 解析 app.asar，运行时文件完整 ✅
8. `npm run secret:scan`（worktree）✅
9. 签名 → 公证 → staple → 审计 ✅
10. 记录 SHA256 + 写 release notes（诚实标 beta）

**不需要：** 64 个 P0 产品验收、42 目标 closure、N1 真人计时、真实 Provider release record、7 天 soak。**那些是 1.0 stable 门禁（§3.5）。**

### 3.2 发布 Runbook（逐步）

```
1. 确认工作 → 提交 → 干净 commit
2. git tag v0.2.0
3. checkout tag → npm ci → npm run build
4. 出包：DMG + ZIP（electron-builder）
5. codesign（Developer ID）→ notarytool 提交 → 等通过 → staple
6. macos-release-preflight / release-packaging-audit 审计签名产物
7. shasum -a 256 记录所有资产
8. 写 RELEASE-NOTES（能力=已发布口径，标 beta + 未来愿景分开）
9. 创建 GitHub Release，传 DMG/ZIP/blockmap/latest-mac.yml
10. 发布后远端 read-text 审计资产名/大小/SHA256/latest.yml
11. 更新官网 site-config.json：signatureState 改「已签名」、去掉右键打开摩擦
12. 阶段 4 发布帖（EXECUTION-PLAN §3 阶段 4）
```

### 3.3 平台顺序

| 平台 | 状态 | 计划 |
|---|---|---|
| **macOS x64（签名）** | 管线就绪 | **先发**——0.2.0 首个签名产物 |
| Windows x64（签名） | v0.1.5 未签名 | 次发——补 Authenticode 签名 |
| macOS arm64 | 历史发过 | 需 Apple Silicon 真机构建+验证，随后 |
| Linux | 配置存在 | AppImage，最后，不承诺日期 |

### 3.4 回滚计划

- 每个 Release 保留上一个可用版本可下载。
- 严重问题：GitHub Release 标 pre-release/撤下，官网下载指回上一稳定 tag。
- update feed（`latest-mac.yml`）只指向验证过的版本，坏版本不进 feed。

### 3.5 1.0 Stable 门禁（延后，重量级）

现有 Release Doctor 全套——**不在当前范围**，等阶段 5 有牵引力后再启动：
- 64 个 P0 产品验收 closure
- clean-commit Deep 绑定 + secret-history
- 真实默认 Provider release record（send/tool/artifact/recovery/usage/billing）
- N1 真人 30 分钟证据
- macOS 签名/公证/staple + Apple Silicon 证据
- 7 天 soak（或显式 waiver）

---

## 4. 6-8 周开发+发布合并时间线

| 周 | 开发 | 发布 | 里程碑 |
|---|---|---|---|
| **W1** | 门禁降级脚本 + 版本回退 0.2.0 + 主链路 bug 清零 | 跑通 Beta 门禁 → **签名 0.2.0 macOS 发布** | 有能无摩擦安装的签名包 |
| **W2** | onboarding 打磨 + demo 录制 | 官网/README 改口径（Sol 并行） | 陌生人 10 秒看懂 + 装得上 |
| **W2-3** | Sol：README/英文/CONTRIBUTING/good-first-issues/拆文件 | 建真 issue、issue/PR 模板 | 仓库可被贡献 |
| **W3-5** | 用户反馈快修（周更 0.2.x） | 阶段 4 发布帖（Reddit/HN/V2EX/PH）| 首批 100-500 装机 + 首个外部 PR |
| **W4** | Windows 签名 | Windows x64 签名版发布 | 双平台签名 |
| **W5-8** | 按用户投票迭代 + 留住贡献者 | 月更 0.3.0 | 可融资的牵引力数字 |

---

## 5. 铁律

1. **签名 ≠ 宣称 stable。** 0.2.x 始终诚实标 beta；"完整 Agent Work OS 愿景在路上"每字都真。
2. **干净 commit ≠ 干净 worktree。** 只需发布那个 commit 干净，别再等整个历史干净。
3. **Required 永不 skip 充数**（这条继承现有纪律，不放松）。
4. **正式包只从 tag 出，不从 dirty worktree 出。**
5. **发布物不含任何凭据**（secret scan 硬门禁）。

> **一句话：把"发一个能装的签名 beta"从"全功能 1.0 stable"里解绑，本周就发得出去。**
