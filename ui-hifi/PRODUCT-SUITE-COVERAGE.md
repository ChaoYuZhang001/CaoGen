# CaoGen 全功能高保真 UI 覆盖矩阵

> 原型入口：`ui-hifi/product-suite.html`
>
> 范围：覆盖 `docs/PRODUCT-REQUIREMENTS.md` 中 CaoGen 1.0 的功能域、关键异常态和非功能控制面。页面中的“当前能力 / 部分完成 / 目标”标签是事实边界，不代表原型页面本身已经进入生产代码。

## 信息架构

| 工作区 | 主要对象与动作 | 对应需求域 | 原型关键状态 |
|---|---|---|---|
| 总览 | 目标、运行、审批、成本、黄金工作流 | Goal / WorkItem / Run / Approval / Artifact | 运行、等待审批、待对账、交付进度 |
| Assistant | 对话、文件引用、执行摘要、审批、模式切换 | EXP-001～006 | 运行中、Provider 接管、待批准、Assistant 降噪 |
| 项目 | Project Workspace、Resource、规则、归档、导出、删除 | PROJ-001～007 | 活跃、归档、本地完整性、生命周期缺口 |
| 目标与工作项 | Goal Contract、List/Board、DAG、依赖、负责人 | GOAL-001/002、WORK-001～007 | backlog、running、waiting、done、Acceptance |
| 运行与 Supervisor | Run、Attempt、lease、heartbeat、pause/cancel/reassign | RUN-001～009 | 执行、等待依赖、暂停、待对账、完成 |
| 产物与交付 | Artifact、Evidence、Acceptance、Diff、patch、报告、PR | ART-001～007 | 测试通过、逐项验收、patch 导出、远端条件可用 |
| 数字团队 | RoleTemplate、DigitalWorker、Assignment、策略和绩效 | TEAM-001～009 | 在岗、空闲、待对账、权限覆盖缺口 |
| 3D Office | 真实运行状态投影、角色、工位、列表回退 | VIS-001～008 | 运行、等待、异常、目标人物资产 |
| Routines | 本地定时、运行记录、通知、防休眠、项目绑定 | AUTO-001/002/005 | 启用、暂停、成功、预算阻塞 |
| 资源与工作台 | 文件、终端、Diff、Git、浏览器、预览、Office 结构 | PROJ-002、EXP-005 | 文件修改、项目路径、发给 Agent |
| 插件、Skill 与 MCP | 安装、版本、来源、digest、Capability Manifest | CONN-001～003、TRUST-003/007 | 已连接、未配置、权限扩大待审批 |
| 记忆与学习 | draft、approve、reject、revoke、rollback、expiry | AUTO-003/004 | 待审批、已批准、过期、撤销、版本 diff |
| Provider 与路由 | 健康、预算、信任域、ModelAttempt、Failover | ROUTE-001～010 | 健康、余额不足、同域接管、跨域确认 |
| 审计与恢复 | Ledger、Effect、Evidence、恢复队列、Canonical 切换 | TRUST-001～006、NFR-REC、NFR-AUD | retry-safe、waiting_reconciliation、legacy/compare/canonical |
| 设置 | 体验模式、权限、信任域、预算、数据、外观、迁移 | NFR-PRIV、NFR-NEUTRAL、NFR-UX、迁移与保留 | fail-closed、本地优先、读源门禁、低性能回退 |

## 端到端覆盖

| 验收链路 | 原型入口 |
|---|---|
| 本地代码修复并交付 Diff/patch | 总览 → Assistant → 目标与工作项 → 运行 → 产物与交付 |
| Provider 故障切换 | Assistant → Provider 与路由 → 审计与恢复 |
| Assistant / Studio 无损切换 | 顶部模式控件；同一 Goal 与会话保持不变 |
| 崩溃和未知副作用恢复 | 总览警告 → 审计与恢复 → 只读对账抽屉 |
| Acceptance 门禁 | 产物与交付 → 逐 criterion Evidence → 用户最终批准 |
| 数字员工加入、分配与退休边界 | 数字团队 → 岗位详情 → 目标与工作项 |
| Routine 项目化 | Routines → Project 绑定 → WorkItem/Run 目标态 |
| 项目导出与删除 | 项目 → 生命周期 → 设置中的本地数据控制面 |

## 设计系统边界

- 主界面为高密度、低干扰的技术工作台，不采用营销页结构。
- 红色只承担品牌和高关注动作；绿色、蓝色、琥珀色、紫色分别表达成功、执行、等待和条件能力。
- 所有状态同时使用文字、颜色和图形，不只依赖颜色。
- 桌面使用导航轨、项目上下文、工作区和检查器；窄屏收敛为顶部模式切换与底部主导航。
- 3D Office 使用真实项目截图作为场景底图，并始终保留列表回退。
- 角色字标为水彩人物资产落地前的设计占位，不将 Provider 或模型品牌人格化。
