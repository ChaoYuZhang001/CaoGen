# 增量架构设计：W2 — canonical Artifact producer 接入 ART-005 验收闸门

> 文档版本：v1.0 · 编写日期：2026-07-30
> 角色：临时架构师（替代 `software-architect` 自定义子代理）
> 上游：已完成 W2 PRD（`docs/PRD-W2-artifact-producer.md`）、ART-005 闸门（已 commit `6691b2a5`/`16093e66`/`e419f81c`）
> 配套图：`class-diagram-w2-artifact-producer.mermaid`、`sequence-diagram-w2-artifact-producer.mermaid`
> 约束红线：**仅扩展 producer（main 内既有 confirmed-effect→artifact 通道）→ canonical Artifact → ART-005 闸门（store/UI 自动消费）；可动 main，禁动 IPC，不新增 IPC 通道，不新写 lifecycle，不新写 blob 落库，不新建结果 UI 面板。**

---

## 0. 本人亲核结论（PRD 假设 vs 实际代码）

所有接口位置均已 `Read`/`Grep` 核实，**PRD 的接口假设大部分成立，但有 1 处必须纠正、2 处需补强**：

| # | PRD 假设 | 实际代码（已核实） | 结论 |
|---|---|---|---|
| **C-1（纠正）** | `EffectTarget` 在 `shared/types.ts` | 实际定义在 `src/shared/effect-types.ts`（`EffectRecord.target` 的联合类型，`src/shared/types.ts` 仅 `export type * from './effect-types'` 再导出）。`artifact-lifecycle-producer.ts` 注释里写的 `EffectRecord` 也是从 `../../shared/types` 引入，但**类型真身在 `effect-types.ts`** | **追加 `office_artifact` 分支应改 `src/shared/effect-types.ts`**，不是 `shared/types.ts` |
| **C-2（纠正/补强）** | 追加 `office_artifact` 到 `EffectTarget` 是"additive、不影响 IPC 序列化/版本化" | `src/main/task/effect-target-validation.ts:3` 的 `isEffectTarget()` 是一个**显式 switch**：未知 `kind` 会落在 `kind==='unsupported'` 分支被拒绝/降格。不扩展该校验函数，新 Effect 会在反序列化/校验阶段被丢弃 | **追加 EffectTarget 分支 ≠ 纯 additive**；T01 必须同步在 `effect-target-validation.ts` 增加 `office_artifact` 校验分支（main 侧改动，允许，但超出 PRD 声明的"3 个最小改动点"）。详见 §8-A |
| **C-3（确认）** | `REQUIRED_ARTIFACT_KINDS` 16 kind 是否含 `document`/`spreadsheet` | `src/main/task/artifact-lifecycle-types.ts:9` 的 16 kind 列表**已包含 `document` 与 `spreadsheet`**（`WorkflowArtifactKind` 联合同样包含） | 复用现有 artifact `kind` 即可，**无需新增 artifact kind**；新增的是 `EffectTarget` 的 `office_artifact` 分支（见 C-2） |
| **C-4（确认）** | `registerPersistedArtifactLifecycle` 处理 digest/provenance/version/creatingRun/supersession/blob\|sourceRef/retention | `src/main/task/artifact-lifecycle-api.ts:44` 签名与 `ArtifactLifecycleRegistrationInput`（`artifact-lifecycle-types.ts:44`）完全吻合：`id/projectId/goalId?/workItemId?/runId/lineageId/kind/title/version/provenance/mediaType?/supersedesId?/retention/content{blob\|source_ref}/metadata?`；内部 `registerArtifactLifecycle`（`artifact-lifecycle-store.ts:87`）调用 `registerWorkflowArtifact` 自动落 canonical `WorkflowArtifactRecord` | producer 直接复用，无新落库逻辑 |
| **C-5（确认）** | 新 canonical Artifact 自动汇入 `snapshot.artifacts`，无需改 renderer | `getStudioResultSnapshot` 读取 workflow ledger；`registerArtifactLifecycle` 内部 `registerWorkflowArtifact`（`artifact-lifecycle-store.ts:98`）已写入 ledger，`StudioResultArtifact`（`studio-result-types.ts:90`）字段 `kind/mediaType/evidenceIds/acceptanceIds/locations` 齐备 | **renderer 零改动**即可让新 Artifact 流入 ArtifactRow / DeliveryVerdictBanner / TraceabilityView |
| **C-6（确认）** | `deriveDeliveryVerdict` 只读 `snapshot.acceptances` | `src/renderer/src/store/delivery-verdict.ts:36` 仅遍历 `snapshot.acceptances`，产出 `verifiable`/`not_done` | 本棒让 producer 为该 Artifact 创建/关联 Acceptance，即自然驱动 `not_done`，**闸门函数零改动** |
| **C-7（确认）** | "打开"走既有 `openTool('preview', path)`，"下钻证据"走既有 `handleDrillEvidence` | `StudioResultPanel.tsx:769` `openLocation` 对 `location.path` 调 `openTool('preview', location.path)`；`PreviewRenderer.tsx` 已支持 `office` 类型（docx/xlsx 结构与视觉预览，含 excel 行内容提取 `OfficeStructurePreview`）；`handleDrillEvidence` 在 `StudioResultPanel.tsx:259` 已实现 | **预览/下钻零改动**；spreadsheet 内容提取预览**已存在**（结构视图渲染 excel 行），见 §8-D |
| **C-8（补充）** | 依赖 `docx`/`exceljs` 是否已装 | 全局 `package.json` **未安装** docx/exceljs（仅 `node_modules/file-type` 把 "docx" 当作扩展名识别）；AGPL 项目引入 MIT 依赖无冲突 | T02 需把二者加入根 `package.json` **运行时依赖**（Electron main 打包），非 devDeps。详见 §6 |

> 红线复核：本设计所有新动作都发生在 **main 进程**（producer 分支、office 生成工具、EffectTarget 扩展、Evidence/Acceptance 创建），renderer 完全经既有 `getStudioResultSnapshot` 消费；**无任何新增 IPC handler / channel / preload 改动**。

---

## 1. 实现方案与框架选型

- **框架**：复用既有 React 18 + Zustand + Electron-40 + 既有 producer 框架（`artifact-lifecycle-producer.ts` 的 `registerConfirmedRunArtifactLifecycles` 既由 `effect-runtime.ts:264/300/336` 在 run 持久化后触发）。本棒**不引入任何新框架**。
- **生成库落点（Q-2 默认采纳）**：`docx`（MIT）+ `exceljs`（MIT）置于 **main 进程**（`src/main/agent/tools/office-artifact.ts` 或并入 `openaiTools.ts` 的既有工具注册框架）。字节经既有 `confirmed office_artifact Effect → producer → registerPersistedArtifactLifecycle` 通道入 canonical store；**不在 renderer 生成再回传字节**（那才需新 IPC）。
- **artifact 存储形态**：与 `registerCodeForgePatchLifecycle` 一致，使用 `content.storageKind: 'source_ref'`（文件落在 Project 工作区），而非 `blob`。理由：office 文件本就是工作区产物，源文件可追溯、可被 `openTool('preview')` 直接打开，且符合既有 patch 通道的存储约定。
- **闸门复用**：producer 为该 Artifact 创建/关联一条 Acceptance（其 criterion 针对 office 成品），`deriveDeliveryVerdict` 自然返回 `not_done`（失败/待验）或 `verifiable`（通过）。**闸门函数、DeliveryVerdictBanner、WorkflowAcceptanceRow、TraceabilityView、ArtifactRow 全部零改动。**
- **不新建 lifecycle / blob 落库**：仅调用既有 `registerPersistedArtifactLifecycle`；supersession 由既有 lifecycle（`assertLineageTransition`/supersedesEdge）自动处理。

---

## 2. 文件列表（新增 / 修改；main 与 renderer）

| 路径 | 动作 | 说明 | 对应任务 |
|---|---|---|---|
| `src/main/task/artifact-lifecycle-producer.ts` | **修改** | 在 `registerConfirmedRunArtifactLifecycles` 的 `for` 循环内新增 `isConfirmedOfficeArtifactEffect` 分支；新增 `registerOfficeArtifactLifecycle(run, effect, rootDir)`（调用 `registerPersistedArtifactLifecycle` + 自动 Evidence/Acceptance） | T01、T03 |
| `src/shared/effect-types.ts` | **修改** | `EffectTarget` 联合类型新增分支 `office_artifact`（additive 成员） | T01 |
| `src/main/task/effect-target-validation.ts` | **修改** | `isEffectTarget()` 新增 `office_artifact` 分支 + `isOfficeArtifactTarget()` 校验器（**必改，否则新 Effect 被拒**，见 C-2） | T01 |
| `src/main/agent/tools/office-artifact.ts`（或并入 `openaiTools.ts`） | **新增** | main 侧 office 生成工具：docx/exceljs 写字节、写工作区、算 sha256、记录 `confirmed office_artifact` Effect（复用既有 effect 记录框架） | T02 |
| `src/main/agent/tools/office-self-check.ts` | **新增** | 结构/打开性自校验：回读文件、用 docx/exceljs 解析，断言 `kind`/`mediaType`/字节 `digest` 一致、可解析；输出 `{ok, kind, mediaType, digestMatch, reason}` | T03 |
| `src/main/task/artifact-lifecycle-producer.ts`（同上） | **修改** | T03 内：producer 调 `createWorkflowEvidence` + `saveWorkflowAcceptance` + `createWorkflowEvidenceLink`（均来自 `src/main/task/workflow-ledger-api.ts`，main 内调用，**无新 IPC**） | T03 |
| `docs/ARCH-W2-artifact-producer.md`、`class-diagram-w2-artifact-producer.mermaid`、`sequence-diagram-w2-artifact-producer.mermaid` | **新增** | 本架构交付物 | — |
| `src/renderer/.../PreviewRenderer.tsx`、`StudioResultPanel.tsx`、`delivery-verdict.ts`、`ArtifactRow` | **不改** | 新 Artifact 经 `getStudioResultSnapshot` 自动流入既有面板 | — |
| `src/preload/*`、`src/main/ipc*.ts` | **不改** | 无新 IPC | — |
| `src/main/task/artifact-lifecycle-api.ts`、`artifact-lifecycle-types.ts`、`artifact-lifecycle-store.ts` | **不改** | 复用既有 `registerPersistedArtifactLifecycle` 合同 | — |

> 脏树保护：仅精确 `git add` 上述 main 文件 + `src/shared/effect-types.ts`；**不碰** `src/main/git/pull-request-effect.ts` 等无关 WIP、不碰 ART-005 闸门语义、不动任何 renderer 消费逻辑。

---

## 3. 数据结构与接口

### 3.1 `office_artifact` Effect 形状（新增 `EffectTarget` 分支，C-1）

```ts
// src/shared/effect-types.ts  —— EffectTarget 联合新增成员
| {
    kind: 'office_artifact'
    /** 对应 canonical Artifact 的 kind，非 artifact 自身 kind 字段 */
    artifactKind: 'document' | 'spreadsheet'
    /** Project 工作区内绝对路径（与 ArtifactLifecycleRegistrationInput.content.sourceRef 一致） */
    workspacePath: string
    /** 字节 sha256，前缀 'sha256:' */
    sha256: string
    bytes: number
    /** OOXML media type：
     *  document → application/vnd.openxmlformats-officedocument.wordprocessingml.document
     *  spreadsheet → application/vnd.openxmlformats-officedocument.spreadsheetml.sheet */
    mediaType: string
    /** 来源材料引用（输入文档/数据表的 workspace 路径或 sourceRef），用于可追溯 */
    sourceRefs: string[]
    title: string
  }
```

> 这是 **additive 联合成员**：既有 effect 读取方以 `effect.target.kind` 判别，未知 kind 被忽略，向后兼容。但 **C-2 要求同步扩展 `isEffectTarget`**，否则新 Effect 在校验阶段被拒。

### 3.2 producer 调用 `registerPersistedArtifactLifecycle` 的 input 构造

```ts
await registerPersistedArtifactLifecycle({
  id: `artifact:office:${effect.id}`,
  projectId: workflowRun.projectId,
  goalId: workflowRun.goalId,
  workItemId: workflowRun.workItemId,
  runId: workflowRun.id,
  lineageId: `lineage:office:${effect.id}`,
  kind: effect.target.artifactKind,            // 'document' | 'spreadsheet'（已属 16 kind，C-3）
  title: effect.target.title,
  version: 1,
  provenance: 'explicit',
  mediaType: effect.target.mediaType,
  retention: { mode: 'retain' },
  content: {
    storageKind: 'source_ref',
    sourceRef: effect.target.workspacePath,
    expectedDigest: effect.target.sha256       // 'sha256:...'
  },
  metadata: {
    producer: 'office_delivery',
    effectId: effect.id,
    toolUseId: effect.toolUseId,
    sourceRefs: effect.target.sourceRefs
  },
  createdAt: effect.terminalAt ?? effect.updatedAt
}, rootDir)
```

### 3.3 `EffectTarget` 追加定义位置（C-1）

- 真身在 `src/shared/effect-types.ts` 的 `EffectTarget` 联合。PRD 写成 `shared/types.ts` 是错的（`types.ts` 只是再导出）。
- 同时在 `src/main/task/effect-target-validation.ts` 的 `isEffectTarget()` 增加：
  ```ts
  if (value.kind === 'office_artifact') return isOfficeArtifactTarget(value)
  ```
  并实现 `isOfficeArtifactTarget`（校验 `artifactKind` ∈ {'document','spreadsheet'}、`workspacePath`/`sha256`/`mediaType`/`title` 为 string、`sourceRefs` 为 string[]、`bytes` 为非负整数）。

### 3.4 spreadsheet 内容提取预览的数据流（C-7，renderer 零改动）

```
canonical spreadsheet Artifact（kind='spreadsheet', location.kind='workspace'|'file', path=workspacePath）
  → StudioResultPanel.onOpenLocation(location) → openTool('preview', location.path)   // 既有
  → PreviewRenderer 识别 path .xlsx / mediaType spreadsheetml → type='office'          // 既有
  → parseOfficePreviewContent(content) → model.kind==='excel'
  → OfficeStructurePreview 渲染 section.rows（内容提取：sheet 的行/列文本）            // 既有
```

> 既有预览展示的是 **OOXML 中存储的值**（含公式的文本），**非公式重算结果**。公式"真值"校验属 P1-2（见 §8-D）。P0 阶段结构预览已满足"内容提取预览"的可验收口径。

---

## 4. 程序调用流程（时序，详见 `sequence-diagram-w2-artifact-producer.mermaid`）

1. **模型调用 office 工具**（main 侧，T02）：`OfficeGeneratorTool` 用 docx/exceljs 生成字节 → 写 Project 工作区 → 算 sha256 → 记录 `confirmed office_artifact` Effect（含 kind/mediaType/sourceRefs）。
2. **既有触发**：run 持久化后 `effect-runtime.ts` 调 `registerConfirmedRunArtifactLifecycles(run)`；producer 遍历 `run.effects`，过滤 `status==='confirmed' && target.kind==='office_artifact'`。
3. **写 canonical Artifact**（复用）：调 `registerPersistedArtifactLifecycle`（input 见 §3.2，content=source_ref）→ 内部 `registerWorkflowArtifact` 自动落 `WorkflowArtifactRecord` + location。
4. **自动挂 Evidence + Acceptance**（T03，main 内调用既有 ledger API，无新 IPC）：
   - `office-self-check` 回读文件做结构/打开性校验（可解析、kind/mediaType 与字节一致、digest 一致、来源可追溯）。
   - `createWorkflowEvidence(结构校验结果, source='runtime')`。
   - `saveWorkflowAcceptance(针对 office 成品的 criterion, status 由 check 派生)`。
   - `createWorkflowEvidenceLink({ relation:'verifies', acceptanceId, criterionId, evidenceId })`。
5. **自动消费（ART-005 闸门）**：renderer 经 `getStudioResultSnapshot` 取到新 Artifact/Evidence/Acceptance；`deriveDeliveryVerdict` 仅读 `snapshot.acceptances` → `not_done`（失败/待验）或 `verifiable`（通过）。
6. **预览/下钻/返工（既有）**：`openTool('preview', path)` 走 office 视觉/结构预览；`handleDrillEvidence` 下钻 Evidence/Acceptance；若 Acceptance=failed，`WorkflowAcceptanceRow` 既有「查看返工 WorkItem」入口 → `openTool('tasks')` 返工，重生成后以 `supersedesId` 进入同一 lifecycle。

---

## 5. 任务列表（有序、含依赖、按实现顺序）

> 共 6 个任务（T06 为 P1，可择期）。每任务均对应 PRD AC。

### T01 — producer 分支 + EffectTarget additive（含单测）
- **改动文件**：`src/main/task/artifact-lifecycle-producer.ts`（新增 `isConfirmedOfficeArtifactEffect` + `registerOfficeArtifactLifecycle` 骨架，先仅写 Artifact，Evidence/Acceptance 留 T03）、`src/shared/effect-types.ts`（追加 `office_artifact` 分支）、`src/main/task/effect-target-validation.ts`（**新增 `isOfficeArtifactTarget` + `isEffectTarget` 分支，C-2 必改**）。
- **动作**：在 `registerConfirmedRunArtifactLifecycles` 循环内并列 code_forge 分支；构造 §3.2 的 `registerPersistedArtifactLifecycle` input（content=source_ref）。
- **验收点（AC-1）**：单测注入"生成快照 = 含 1 个 confirmed `office_artifact` Effect 的 run"，断言 `snapshot.artifacts` 含 `kind='document'|'spreadsheet'` 且 `digest`/`provenance`/`version`/`mediaType`/`locations` 字段完整；并断言 `isEffectTarget(officeEffect)` 返回 `true`。
- **依赖**：无。

### T02 — office 生成工具（docx/exceljs 写字节 + 写工作区 + 记录 Effect）
- **新增文件**：`src/main/agent/tools/office-artifact.ts`（或并入 `openaiTools.ts` 既有工具注册）、`src/main/agent/tools/office-self-check.ts`（先实现生成端所需的最小解析，T03 复用）。
- **动作**：工具接收结构化 spec（docx：标题/段落/列表；xlsx：sheet/行列），docx/exceljs 生成 `Uint8Array`，写到 Project 工作区路径，`crypto` 算 sha256，经**既有 effect 记录框架**落 `confirmed office_artifact` Effect。
- **验收点（AC-1/AC-3）**：E2E/单测断言生成的文件可被 docx/exceljs 重新打开、字节 sha256 与 Effect.sha256 一致；工具结果返回 workspace 路径。
- **依赖**：T01（Effect 形状与 producer 接入点就绪）；需先 `npm i docx exceljs`（§6）。

### T03 — 自动 Evidence / Acceptance 关联（结构/打开性校验，失败驱动 not_done）
- **改动文件**：`artifact-lifecycle-producer.ts` 的 `registerOfficeArtifactLifecycle` 补齐 T01 骨架。
- **动作**：producer 生成 Artifact 后调 `office-self-check`；据此 `createWorkflowEvidence`（结构/打开性，source='runtime'）+ `saveWorkflowAcceptance`（criterion 针对 office 成品，status：check 绿→`passed`，check 红→`failed`）+ `createWorkflowEvidenceLink(verifies)`。
- **验收点（AC-4/AC-6）**：单测注入"文件生成但结构校验失败" → 断言 `snapshot.acceptances` 含该 office Acceptance 且 status=`failed`，Evidence 记为失败；注入"无来源/打不开" → 同上。
- **依赖**：T01、T02。

### T04 — 预览接入（document 视觉预览 + spreadsheet 内容提取）
- **改动文件**：**无**（renderer 零改动，C-5/C-7）。仅做链路确认。
- **动作**：确认 `openTool('preview', location.path)` 对 docx 走 `officeVisual`（既有 main `previewVisual.ts`），对 xlsx 走 `OfficeStructurePreview` 行提取（既有）；spreadsheet 内容提取预览**已实现**，无需新解析。
- **验收点（AC-3）**：UI 测试点开 docx/xlsx → 预览可达；点"下钻证据"→ evidence Tab 高亮对应 evidenceId/acceptanceId。
- **依赖**：T01–T03。

### T05 — 复用 ART-005 闸门回归验证
- **改动文件**：无。
- **动作**：组合回归单测——构造"office Artifact 生成成功 + 其 Acceptance failed"快照，断言 `deriveDeliveryVerdict`=`not_done`、Goal 完成门禁禁用（AC-2）；构造"生成成功 + 来源无/损坏"断言失败链（AC-4）；构造 E2E 黄金路径（用户提供材料→生成 document+spreadsheet→预览/追溯/返工/导出）。
- **验收点（AC-2/AC-4/AC-5/AC-8）**：全部 `not_done` 推导与 repair 入口正确；导出包含 office Artifact manifest/digest 且标注未验收项（AC-6/AC-7）。
- **依赖**：T01–T04。

### T06 —（P1）PPT/PDF 横向扩展（如时间允许，否则留后续）
- **动作**：在 `registerOfficeArtifactLifecycle` 同分支把 `artifactKind` 扩展到 `presentation`/`pdf`，复用同一 producer 与闸门；`registerPersistedArtifactLifecycle` 的 `kind` 已支持 `presentation`（16 kind 内含）。
- **验收点**：与 T01–T05 同口径横扩。
- **依赖**：T01–T05；**不阻塞 1.0**。

> 任务边界自查：全部在 main 内；无新 IPC、无新 lifecycle、无新 blob 落库、无新结果面板——符合红线。

---

## 6. 依赖包清单（docx / exceljs 及许可）

| 包 | 版本策略 | 许可 | 是否需入 main 运行时依赖 | 备注 |
|---|---|---|---|---|
| `docx` | 最新稳定（如 `^9`） | **MIT** | **是**（根 `package.json` `dependencies`） | 仅 main 进程生成 docx 字节；Electron 主进程打包，非 devDep |
| `exceljs` | 最新稳定（如 `^4`） | **MIT** | **是**（根 `package.json` `dependencies`） | 同上；原生依赖仅 build 期，运行时纯 JS |
| `pptxgenjs` | 留 P1（T06） | MIT | 暂不加 | P1 才需 |

- **许可评估**：CaoGen 自身 AGPL-3.0；引入 MIT 运行时依赖**无冲突**（MIT 与 AGPL 单向兼容：AGPL 项目可包含 MIT 代码，只要保留其版权/许可声明）。无需特殊法务动作。
- **落点**：加入根 `package.json` 的 `dependencies`（非 `devDependencies`），由 Electron 打包进 main bundle；不需进 renderer（不在 renderer 生成，见 Q-2）。
- **体积**：docx/exceljs 均为纯 JS、体积小，对安装包影响可忽略。

---

## 7. 共享知识（跨文件约定）

- **office Artifact 的 `kind`**：canonical Artifact 用 `'document'` / `'spreadsheet'`（复用既有 16 kind，C-3）；`office_artifact` 是 **EffectTarget** 的分支名（两者不是同一字段，勿混）。
- **`mediaType` 口径**：
  - document → `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  - spreadsheet → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- **字节一致性校验口径（producer + self-check 共同遵守）**：
  1. 生成端写盘后算 `sha256(bytes)`；
  2. Effect 携带该 `sha256`，`registerPersistedArtifactLifecycle` 的 `content.expectedDigest` 用同一值；
  3. T03 self-check 回读文件重算 sha256，必须与 Effect.sha256 一致，否则 Evidence 记失败 → Acceptance 失败 → `not_done`；
  4. 解析校验：`docx`/`exceljs` 能打开且 `artifactKind` 与实际内容匹配（如 xlsx 字节确为 spreadsheetml），`mediaType` 与实际一致。
- **supersession**：由既有 lifecycle 合同处理（`assertLineageTransition` + `supersedesEdge`）。重生成时新 Artifact 以 `supersedesId` 指向旧版，producer 仅传 `supersedesId` 字段，**不重写 lifecycle**。
- **来源可追溯**：`sourceRefs` 记录输入材料路径，写入 Artifact `metadata.sourceRefs` 与 Effect，供 TraceabilityView 展示。
- **Evidence 身份**：结构/打开性 Evidence 统一 `kind: 'build_result'`（或 `delivery_check`），`source: 'runtime'`，`verifier: 'main-process'`——与 `createWorkflowEvidence` 默认 authority 一致。

---

## 8. 待明确事项（仅补漏 PRD 未覆盖且本棒必须解决者；标红=触及新行为边界）

- **A（标红·C-2 必改点）**：`EffectTarget` 追加 `office_artifact` **不是纯 additive**——`src/main/task/effect-target-validation.ts` 的 `isEffectTarget()` 是显式 switch，不扩展则新 Effect 被拒/降格。T01 必须同步改该校验函数（main 改动，允许，但属 PRD"3 个最小改动点"之外的第 4 个 main 改动）。**建议：默认纳入 T01，不另行报批。**
- **B（标红·Acceptance 由谁创建）**：PRD Q-6/P0-6 说"producer 自动创建 Acceptance criterion"。本设计默认 **producer 为每个 office Artifact 自动建一条 Acceptance**（criterion 针对"可打开/结构校验通过/来源可追溯"），status 由 self-check 派生。需 PM 确认：自动建 Acceptance 是否可接受（vs. 由 Goal 初始化处预置）。本棒按 producer 自建实现，因 Goal 初始化处改动会牵动更多面且不符合"最小 main 改动"。
- **C（标红·自动 passed 是否过宽）**：self-check 绿即把 Acceptance 置 `passed`，可能被模型"自证通过"。缓解：self-check 仅校验可解析/字节一致/来源可追溯（硬失败信号），**不替代人工/公式真值验收**；ART-005 的 `reviewWorkflowAcceptance` 仍允许人工重判为 failed。P1-2 再加公式真值 Evidence。建议：默认采纳"绿→passed / 红→failed"，由人工复核兜底。
- **D（spreadsheet 内容提取预览的口径）**：既有 `PreviewRenderer` 结构视图展示的是 **OOXML 存储值**（含公式文本），**非公式重算结果**。P0 阶段这已满足"内容提取预览"可验收口径；"公式真值校验/重算"列为 **P1-2**（属新 Evidence 类型，非本棒必须）。若 PM 要求 P0 即见计算值，需 main 侧预提取（exceljs 可算），但那会引入额外 main 处理——默认放 P1。
- **E（docx/exceljs 运行时入口与打包）**：确认加入根 `package.json` `dependencies` 后，Electron（forge/webpack）主进程打包无 ASAR/原生模块问题（docx/exceljs 纯 JS，预期无碍）。需在 T02 落地后跑一次 `npm run build` 验证。
- **F（office 生成工具是否算"新 IPC"）**：该工具是 **main 侧 agent 工具**（模型经既有 tool-calling 框架调用，字节在 main 内生成并落 Effect），**不新增 renderer↔main 的 IPC 通道**，符合"不动 IPC"红线。但它是 PRD 红线清单外的新增 main 能力，已在 §2 标为新增文件；若 team-lead 认为超出"仅 producer 扩展"口径，需回退为"仅接入既有外部工具产生的 office_artifact Effect"——默认按 PRD Q-2 采纳 main 侧工具。

> 范围克制重申：本棒 = producer 接入 + 复用闸门 + 自动 Evidence/Acceptance 关联 + 预览链路确认。任何会牵动新 IPC、新 lifecycle、新 blob 落库或新结果面板的设想均已排除或归 P1/待明确。

---

## 9. 一句话设计结论

在 main 进程既有的 `registerConfirmedRunArtifactLifecycles` 里并列新增一个 `office_artifact` producer 分支，复用 `registerPersistedArtifactLifecycle`（source_ref 存储）把 docx/xlsx 接入已有的 `document`/`spreadsheet` canonical Artifact，并就地用既有 ledger API 自动挂"结构/打开性"Evidence 与关联 Acceptance，使 `deriveDeliveryVerdict` 对"生成成功但验收未过"自然返回 `not_done`——renderer 经既有 `getStudioResultSnapshot` 零改动消费，全程无新 IPC、无新 lifecycle、无新结果面板；**唯一须纠正的 PRD 假设是 `office_artifact` 应加在 `src/shared/effect-types.ts` 且其 `EffectTarget` 扩展必须同步改 `effect-target-validation.ts` 的 `isEffectTarget`，否则新 Effect 会被校验拒绝。**
