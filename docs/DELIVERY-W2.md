# W2 交付总结 — canonical Artifact producer 接入 ART-005 验收闸门

> 交付日期：2026-07-30
> 所属主线：「替代竞品」收编主线 · 第四棒 W2（PLAN §9 · 波次 C「交付链与审计」）
> 上游：ART-005 已建验收闸门（`deriveDeliveryVerdict` + DeliveryVerdictBanner + WorkflowAcceptanceRow repair 入口 + TraceabilityView）
> 分支：`codex/m1-macos-x64-candidate`

## TL;DR
把 canonical Artifact producer（document 文档 + spreadsheet 可计算表格）接入 ART-005 已建好的验收闸门——模型生成 docx/xlsx **不是完成**，产物必须进入 canonical Artifact、自动挂结构/打开性 Evidence、关联 Goal Acceptance；「文件生成但验收未过」时 `deriveDeliveryVerdict` 返回 `not_done`，Goal 不被标记完成。直接对标 WorkBuddy「成品体验」差距。

## 交付状态
- **IS_PASS：YES**（QA 独立门禁验证全绿）
- 测试通过率：注入单测 `office-self-check.test.ts` 10/10；targeted tsc 0 错误；`git diff --check` CLEAN
- 已知问题：2 项非阻断（见末节）

## 提交清单（3 个批次）
| Hash | 任务 | 文件 |
|---|---|---|
| `6bd24369` | T01 | `src/shared/effect-types.ts`（追加 `office_artifact` EffectTarget 分支）、`src/main/task/effect-target-validation.ts`（同步 `isEffectTarget` + `isOfficeArtifactTarget`） |
| `2b9e6ae5` | T02 | `src/main/agent/tools/office-artifact.ts`（main 侧 office 生成工具）、`src/main/agent/tools/office-self-check.ts`（结构/打开性自校验） |
| `b37c17cf` | T03+T05 | `src/main/task/artifact-lifecycle-producer.ts`（producer 分支 `registerOfficeArtifactLifecycle`）、`src/main/agent/tools/office-self-check.test.ts` |

## 文件清单（6 个，仅 main + shared）
新增/修改：
- `src/shared/effect-types.ts`（修改）
- `src/main/task/effect-target-validation.ts`（修改）
- `src/main/task/artifact-lifecycle-producer.ts`（修改）
- `src/main/agent/tools/office-artifact.ts`（新增）
- `src/main/agent/tools/office-self-check.ts`（新增）
- `src/main/agent/tools/office-self-check.test.ts`（新增）

renderer / preload / IPC 全部零改动。

## 门禁矩阵（QA 独立核实）
| 项 | 结果 |
|---|---|
| commit 真实落盘（3 个、6 文件一致） | ✅ PASS |
| C-1：office_artifact 落在 `effect-types.ts`（非 shared/types.ts） | ✅ PASS |
| C-2：`isEffectTarget` 同步加 office_artifact 分支 + `isOfficeArtifactTarget` | ✅ PASS |
| producer 接入：复用 `registerPersistedArtifactLifecycle`（source_ref，无新 lifecycle/blob） | ✅ PASS |
| 六环链路（AC-7）：无新 IPC/preload/renderer 改动、未碰无关 WIP | ✅ PASS |
| deriveDeliveryVerdict 零改动（仍只读 snapshot.acceptances） | ✅ PASS |
| 单测 `office-self-check.test.ts` | ✅ 10/10 |
| targeted tsc（隔离无关 WIP） | ✅ 0 错误 |
| package.json docx/exceljs 状态 | ✅ 已声明且安装（注：架构师 C-8「未安装」在 commit 时属实，现已被后续 WIP 补全） |
| self-check 偏离（结构化 OOXML 校验，规避 ExcelJS Node22 解析 bug） | ✅ 可接 |
| T06（presentation/pdf）未实现 | ✅ 属 P1 预期，不阻塞 1.0 |
| `git diff --check` | ✅ CLEAN |
| Electron 真机 e2e（test:studio-surface 等） | ⏭️ SKIP（本环境二进制损坏，同 D0/ART-005） |

## 架构师亲核纠正（PRD 假设 vs 实际代码）
- **C-1**：`EffectTarget` 真身在 `src/shared/effect-types.ts`，非 PRD 误写的 `shared/types.ts`——已按实际位置实现。
- **C-2（重要）**：`isEffectTarget()` 是显式 switch，追加 `office_artifact` 不是纯 additive，必须同步改 `effect-target-validation.ts`，否则新 Effect 在校验阶段被拒——已落实（PRD「3 个最小改动点」外的第 4 个 main 改动）。

## 用户下一步建议
1. **恢复 Electron 真机环境后补 e2e**：当前 `node_modules/electron` 二进制损坏（Info.plist 40.10.2 实跑 v24.15.0、debug port 打不开），UI 层 AC-3/4/5 预览/下钻/repair 因 renderer 零改动+既有面板已在 ART-005 验证而逻辑自动流入，需环境恢复后跑 `test:studio-surface` 等做端到端确认。
2. **T06（P1）横扩 presentation/pdf**：在 `registerOfficeArtifactLifecycle` 同分支把 artifactKind 扩展到 `presentation`/`pdf`，复用同一 producer 与闸门（注意：当前工作树宽泛版有 pptxgenjs/pdfkit 相关 T06 笔误待统一清理）。
3. **公式真值校验（P1-2）**：当前 spreadsheet 预览展示 OOXML 存储值、公式以 {formula,result} 透传未重算；可在 producer 加公式真值 Evidence（受 ExcelJS Node22 解析 bug 影响，需另觅方案）。
4. **合并到主线前**：本分支脏树含大量既有未提交 WIP（含 `src/main/git/pull-request-effect.ts` 4 个无关类型错误），合并时需与这些 WIP 协调，W2 三提交本身干净、可独立 cherry-pick。
5. **收编主线续棒**：W2 已建产→Artifact→闸门闭环，下一棒可沿 W2 其余 producer（PPT/PDF）或回 W1 剩余项（真人 30 分钟主链验证 M2-T8）推进。

## 已知问题（非阻断）
- **K1**：Electron 真机 e2e 未跑（环境二进制损坏），仅类型检查 + 注入单测验证。
- **K2**：`office-artifact.ts:410` 工作树宽泛版有 `paraSpaceAfterPt`（应为 `paraSpaceAfter`）笔误，位于 T06 presentation 延期路径，**W2 已提交代码中不存在**；仅工作树周期还原的宽泛快照含之，T06 统一处理后消除。
