# CaoGen 水墨数字员工视觉资产生产规范

> 规范版本：1.4-draft  
> 目标模型：`gpt-image-2`  
> 资产状态：STYLE-A 主语言与 STYLE-D 深色可读性方向已冻结；七个独立角色母版、七张 Tool-Running 和七张 Awaiting-Approval 已通过审查；七张 Idle 副本已建立；其余四种状态尚未生成；21 张离线透明候选通过机械结构检查但因接触阴影未获准注册  
> 产品门禁：`VIS-002..VIS-007`  

## 1. 产品视觉命题

CaoGen 的水墨人物不是装饰插画，而是 DigitalWorker、Role、Assignment、WorkItem、Run、Approval、Artifact 和 Acceptance 的视觉投影。

视觉必须同时成立：

1. 现代中国水墨与透明水彩，不是古风、仙侠或文旅国潮。
2. 生产力软件中的专业数字员工，不是游戏英雄、吉祥物或机器人换皮。
3. 七类岗位仅凭黑白轮廓、服装结构、姿态和道具也可区分。
4. Provider、模型和 Key 只改变 Compute Badge，不改变人物身份。
5. 工作状态同时通过姿态、动作、道具、图标和文字表达，不能只换颜色。
6. 角色在 96px 高度仍可辨认，在 3D Office 中不遮挡任务信息。
7. 所有资产必须原创或权利链明确，不提示模仿在世艺术家。

## 2. 固定视觉语言

### 2.1 媒介

- 当代水墨人物设计。
- 克制的干笔墨线，边缘有自然飞白。
- 透明水彩叠染与有限矿物色。
- 可见但不过度的宣纸颗粒、颜料水痕和手绘不规则边缘。
- 体积清楚、重心稳定，避免平面贴纸感和塑料 3D 感。

### 2.2 颜色

| 用途 | 颜色 | 建议色值 |
|---|---|---|
| 主墨色 | 炭黑 | `#202321` |
| 次墨色 | 暖灰 | `#74736D` |
| 研究 | 石青 | `#2E7685` |
| 策划 | 朱砂 | `#B94D3E` |
| 写作 | 靛蓝 | `#355A85` |
| 设计 | 洋红 + 松石 | `#A64D6A` + `#3A8C88` |
| 开发 | 深蓝 + 竹青 | `#304C6C` + `#4D7866` |
| 审查测试 | 藤黄 + 墨黑 | `#C08B2F` + `#242725` |
| 运维 | 松绿 | `#477A5C` |
| 审批强调 | 朱印红 | `#C23B32` |

颜色占比必须克制：墨与中性色约 70%，岗位色约 20%，状态强调约 10%。不得形成单一米黄、紫蓝渐变或霓虹蓝主题。

### 2.3 人体与构图

- 约 6.5 头身，轻动漫但不过度幼态。
- 全身、三分之四正面、中性镜头高度。
- 完整显示头、双手、双脚和岗位道具。
- 人物四周保留 12% 至 16% 安全边距。
- 不依赖地面投影表达站立；透明切图版禁止接触阴影。

## 3. 全局约束块

以下英文约束附加到每一个生成提示词末尾：

```text
Original character design for CaoGen, a professional desktop AI work operating system.
Modern Chinese ink wash and transparent watercolor, restrained dry-brush linework,
subtle xuan-paper grain, controlled mineral pigments, readable volume and silhouette.
Professional, quiet, humane, precise, contemporary.

No robots, mecha, cyborgs, cyberpunk, historical robes, hanfu, wuxia, xianxia,
fantasy armor, chibi proportions, oversized anime eyes, photorealism, plastic 3D,
toy figurines, glossy game-card rendering, neon effects, decorative UI overlays,
logos, trademarks, captions, letters, numbers, signatures, or watermarks.
No cropped head, hands, feet, or tools. No malformed hands, duplicate limbs,
duplicate props, floating props, or extra characters.
```

## 4. 风格探索提示词

### STYLE-A：矿物色数字水墨，推荐主方向

```text
Use case: stylized-concept
Asset type: CaoGen watercolor digital-worker style board
Primary request: Create a coherent art-direction board for a modern AI work operating system.
Subject: three original professional digital workers shown as full-body character studies,
plus small close-up studies of ink edges, fabric, tools, and restrained state accents.
Style/medium: contemporary Chinese ink wash with transparent watercolor and sparse mineral pigment;
controlled dry-brush contours, soft color blooms, visible xuan-paper grain, clear modern volume.
Composition/framing: landscape editorial style board, generous spacing, no labels or text.
Lighting/mood: soft neutral studio light, calm, capable, trustworthy.
Color palette: charcoal ink and warm gray as the base; mineral teal, cinnabar, indigo,
bamboo green and muted yellow used sparingly.
Constraints: modern workwear, distinct silhouettes, professional desktop-product tone,
no scenery, no UI mockup, no text. Append the global CaoGen constraint block.
```

### STYLE-B：都市淡彩水墨

```text
Use case: stylized-concept
Asset type: CaoGen watercolor digital-worker style board
Primary request: Explore a lighter urban watercolor direction for CaoGen digital workers.
Subject: three modern knowledge workers with different occupational silhouettes and tools,
shown as full-body studies with a few brush-and-pigment detail samples.
Style/medium: contemporary ink drawing softened by transparent urban watercolor washes;
cleaner white space, lighter paper grain, precise facial shorthand, restrained color blocking.
Composition/framing: landscape style board with balanced negative space, no labels.
Lighting/mood: clear overcast daylight, focused and approachable, not cute.
Color palette: charcoal, cool gray, mineral blue, pine green, one restrained cinnabar accent.
Constraints: optimized for readability at small UI sizes; no office scene, no text.
Append the global CaoGen constraint block.
```

### STYLE-C：分层 2.5D 水墨剪影

```text
Use case: stylized-concept
Asset type: CaoGen 2.5D character production style board
Primary request: Design a production-friendly layered watercolor character language
for use as 2.5D figures inside a Three.js office scene.
Subject: three professional digital workers built from visually separable head, torso,
forearm, hand, tool, coat-tail and leg regions while still reading as hand-painted people.
Style/medium: Chinese ink wash and transparent watercolor with clean silhouette boundaries;
limited internal detail, controlled dry brush, paper texture contained inside each figure.
Composition/framing: landscape production study, full-body neutral poses, no labels or rig diagrams.
Lighting/mood: neutral and functional, refined rather than technical.
Color palette: charcoal base with distinct mineral role colors.
Constraints: preserve painterly character while making limb and prop shapes separable;
no visible joints, no puppet look, no scene, no text. Append the global CaoGen constraint block.
```

### STYLE-D：深色办公室高对比水墨

```text
Use case: stylized-concept
Asset type: CaoGen dark-interface watercolor character style board
Primary request: Explore watercolor characters specifically designed to remain readable
inside CaoGen's dark three-dimensional office interface.
Subject: three original modern digital workers in full body, with silhouette tests against
deep charcoal backgrounds and small neutral-background material studies.
Style/medium: contemporary ink wash with luminous but restrained mineral watercolor edges;
matte pigment, controlled rim separation, no glow or neon.
Composition/framing: landscape board, uncluttered, no labels or UI elements.
Lighting/mood: quiet dark studio, precise edge separation, trustworthy enterprise tone.
Color palette: charcoal, off-white edge notes, mineral teal, cinnabar, indigo and pine green.
Constraints: readable without halos; no cyberpunk, no neon, no text.
Append the global CaoGen constraint block.
```

## 5. 七人阵容提示词

```text
Use case: stylized-concept
Asset type: CaoGen seven-role cast lineup concept
Primary request: Create one coherent lineup of seven original modern watercolor digital workers:
researcher, planner, writer, designer, developer, review-and-test specialist, and operations specialist.
Subject: seven complete full-body characters standing in a calm neutral lineup.
Each character must have a unique head silhouette, garment structure, body weight distribution,
pose and occupational tool; they must not look like recolors of one template.

Researcher: mineral teal, short shoulder layer, document folio and circular observation lens.
Planner: cinnabar, asymmetric cropped jacket, folded plan map and node cards.
Writer: indigo, long vertical lapel, narrow manuscript sheets and a modern pen.
Designer: muted magenta plus turquoise, broad cuffs, color swatches and a stylus.
Developer: deep blue plus bamboo green, compact jacket, folding keyboard and terminal-shaped slate.
Review-and-test specialist: muted yellow plus ink black, crisp structured silhouette,
inspection board and square magnifier.
Operations specialist: pine green, practical utility vest, status instrument and compact tool case.

Style/medium: follow STYLE-A, contemporary Chinese ink wash and transparent watercolor.
Composition/framing: landscape, evenly spaced, full bodies visible, consistent scale and perspective,
plain warm-gray paper backdrop, no labels or decorative border.
Constraints: role recognition must still work in grayscale; no repeated faces, outfits, poses or props.
Append the global CaoGen constraint block.
```

## 6. 角色母版提示词

所有角色母版使用竖版构图。母版用于锁定身份，不使用透明背景。

### ROLE-RESEARCHER

```text
Use case: stylized-concept
Asset type: CaoGen canonical character anchor
Primary request: Design the canonical CaoGen Researcher digital worker.
Subject: one thoughtful adult professional with an observant, composed expression;
short shoulder-layer modern workwear, document folio held at the side,
one circular observation lens integrated as a practical research tool.
Silhouette: compact upper-body layer, narrow lower silhouette, circular lens clearly visible.
Style/medium: follow STYLE-A.
Composition/framing: single full-body character, three-quarter front view, neutral standing pose,
centered with 14 percent safe margin, plain neutral paper backdrop.
Color palette: charcoal and warm gray with restrained mineral teal.
Constraints: capable rather than academic stereotype; no lab coat, no spectacles as the only identifier.
Append the global CaoGen constraint block.
```

### ROLE-PLANNER

```text
Use case: stylized-concept
Asset type: CaoGen canonical character anchor
Primary request: Design the canonical CaoGen Planner digital worker.
Subject: one decisive adult professional with an attentive, calm expression;
asymmetric cropped modern jacket, folded plan map and a small set of physical node cards.
Silhouette: directional diagonal jacket line, balanced stance, map creates a clear angular shape.
Style/medium: follow STYLE-A.
Composition/framing: single full-body character, three-quarter front view, neutral standing pose,
centered with 14 percent safe margin, plain neutral paper backdrop.
Color palette: charcoal and warm gray with restrained cinnabar.
Constraints: no military commander styling, no floating flowchart, no presentation-stage pose.
Append the global CaoGen constraint block.
```

### ROLE-WRITER

```text
Use case: stylized-concept
Asset type: CaoGen canonical character anchor
Primary request: Design the canonical CaoGen Writer digital worker.
Subject: one articulate adult professional with a focused, humane expression;
modern garment with a long vertical lapel, narrow manuscript sheets and a precise modern pen.
Silhouette: tall vertical rhythm, manuscript forms a slim secondary shape, relaxed stable stance.
Style/medium: follow STYLE-A.
Composition/framing: single full-body character, three-quarter front view, neutral standing pose,
centered with 14 percent safe margin, plain neutral paper backdrop.
Color palette: charcoal and warm gray with restrained indigo.
Constraints: no historical scholar clothing, no feather quill, no romantic author stereotype.
Append the global CaoGen constraint block.
```

### ROLE-DESIGNER

```text
Use case: stylized-concept
Asset type: CaoGen canonical character anchor
Primary request: Design the canonical CaoGen Designer digital worker.
Subject: one perceptive adult professional with a calm creative presence;
modern workwear with broad structured cuffs, physical color swatches and a precise stylus.
Silhouette: wider forearm shapes, asymmetrical swatch fan, grounded open stance.
Style/medium: follow STYLE-A.
Composition/framing: single full-body character, three-quarter front view, neutral standing pose,
centered with 14 percent safe margin, plain neutral paper backdrop.
Color palette: charcoal and warm gray with restrained muted magenta and turquoise.
Constraints: no flamboyant fashion stereotype, no beret, no floating color wheel.
Append the global CaoGen constraint block.
```

### ROLE-DEVELOPER

```text
Use case: stylized-concept
Asset type: CaoGen canonical character anchor
Primary request: Design the canonical CaoGen Developer digital worker.
Subject: one focused adult professional with a patient, analytical expression;
compact modern jacket, folding keyboard and a slim terminal-shaped work slate.
Silhouette: compact torso, rectangular slate and keyboard shapes, slightly forward work-ready stance.
Style/medium: follow STYLE-A.
Composition/framing: single full-body character, three-quarter front view, neutral standing pose,
centered with 14 percent safe margin, plain neutral paper backdrop.
Color palette: charcoal and warm gray with restrained deep blue and bamboo green.
Constraints: no hoodie stereotype, no code text, no holograms, no cyberpunk accessories.
Append the global CaoGen constraint block.
```

### ROLE-REVIEW-TEST

```text
Use case: stylized-concept
Asset type: CaoGen canonical character anchor
Primary request: Design the canonical CaoGen Review-and-Test digital worker.
Subject: one rigorous adult professional with a measured, alert expression;
crisp structured modern workwear, a physical inspection board and square magnifier.
Silhouette: clear angular shoulders, square tool geometry, upright balanced stance.
Style/medium: follow STYLE-A.
Composition/framing: single full-body character, three-quarter front view, neutral standing pose,
centered with 14 percent safe margin, plain neutral paper backdrop.
Color palette: charcoal and warm gray with restrained muted yellow.
Constraints: no police or detective styling, no red pen stereotype, no warning text.
Append the global CaoGen constraint block.
```

### ROLE-OPERATIONS

```text
Use case: stylized-concept
Asset type: CaoGen canonical character anchor
Primary request: Design the canonical CaoGen Operations digital worker.
Subject: one reliable adult professional with a steady, practical expression;
modern utility vest, compact status instrument and a small organized tool case.
Silhouette: layered utility torso, instrument at one side, sturdy stable stance.
Style/medium: follow STYLE-A.
Composition/framing: single full-body character, three-quarter front view, neutral standing pose,
centered with 14 percent safe margin, plain neutral paper backdrop.
Color palette: charcoal and warm gray with restrained pine green.
Constraints: no mechanic overalls, no military gear, no emergency-services uniform.
Append the global CaoGen constraint block.
```

## 7. 身份保持动作提示词模板

动作生成必须把已批准的角色母版作为 Image 1 参考输入。

```text
Use case: identity-preserve
Asset type: CaoGen digital-worker state pose
Input images: Image 1 is the approved canonical character anchor and strict identity reference.
Primary request: Render the same character in the [STATE] work state.
Action: [ACTION DESCRIPTION]
State readability: the state must remain distinguishable at 96 pixels through posture,
hand action and tool relationship, not through color alone.
Style/medium: exactly preserve Image 1's contemporary ink-wash and transparent-watercolor language.
Composition/framing: same three-quarter view, same body scale, complete full body,
same safe margin and neutral paper backdrop.
Identity invariants: preserve the exact face, age, hair, body proportions, outfit construction,
role colors, tool design, line weight, pigment behavior and personality from Image 1.
Constraints: change only pose, hand action and restrained expression required by the state;
do not redesign the character, clothing or prop. Append the global CaoGen constraint block.
```

| State | Action description |
|---|---|
| `idle` | Stable neutral posture; tools held naturally; quiet readiness; no active effect. |
| `thinking` | Slight forward attention; one hand near the role tool; concentrated gaze; contained ink curl near the tool, not a floating UI. |
| `tool-running` | Both hands actively operate the real role tool; short directional ink strokes show motion; stable footing. |
| `awaiting-approval` | Motion paused; character presents one clipped-corner approval slip with one off-center empty cinnabar square frame; no red disc, circular seal or flag-like composition. |
| `blocked` | Lowered center of gravity; interrupted tool action; one broken ink stroke; alert rather than defeated. |
| `repairing` | Character carefully reconnects or reorganizes the work material; active controlled posture; no magical effect. |
| `delivering` | Character presents one finished physical Artifact with both hands; open confident posture; no celebration jump. |

## 8. 水墨办公室概念提示词

```text
Use case: stylized-concept
Asset type: CaoGen watercolor office environment concept
Primary request: Design a modern digital-worker office for CaoGen that can be reconstructed
as a full-bleed interactive Three.js scene.
Scene/backdrop: a contemporary open work floor with research, planning, writing, design,
development, review-and-test, operations, approval and Artifact-delivery zones.
Subject: seven watercolor digital workers performing real role-appropriate work.
Style/medium: contemporary Chinese ink architecture with transparent watercolor materials;
clean modern geometry, controlled xuan-paper texture, restrained mineral accents.
Composition/framing: wide three-quarter overhead view; clear circulation paths;
minimal occlusion; central task-flow space; safe regions for top metrics and right inspector UI.
Lighting/mood: calm working daylight with readable silhouettes; no theatrical fog.
Color palette: charcoal, neutral gray, mineral teal, cinnabar, indigo, muted yellow and pine green.
Constraints: no ancient architecture, garden, teahouse, sci-fi command center, robot,
floating UI, text, labels, logo, watermark, nested cards or decorative clutter.
```

## 9. 降级资产提示词

### Silhouette

```text
Use case: stylized-concept
Asset type: CaoGen low-detail role silhouette sheet
Input images: Image 1 is the approved canonical character anchor.
Primary request: Reduce the same character to a production-ready watercolor silhouette
that remains identifiable at 48 to 96 pixels.
Style/medium: solid charcoal ink silhouette with at most one restrained role-color wash;
preserve the distinctive head, garment, stance and tool outline.
Composition/framing: one full-body silhouette centered on a plain white background.
Constraints: no facial detail, no text, no shadow, no extra decoration; do not change identity.
```

### List portrait

```text
Use case: identity-preserve
Asset type: CaoGen compact list-view portrait
Input images: Image 1 is the approved canonical character anchor.
Primary request: Create a head-and-shoulders portrait of the same character for a compact list row.
Composition/framing: centered bust, direct but calm gaze, clear head silhouette, generous margin.
Identity invariants: preserve exact face, hair, age, outfit collar, role color and watercolor treatment.
Constraints: plain neutral background, no text, no badge, no tool unless visible at shoulder level.
```

## 10. 透明资产生产边界

`gpt-image-2` 不支持原生透明背景。角色母版批准后，生产透明 PNG 有两条路径：

1. 默认路径：生成纯色 chroma-key 背景，使用本地脚本去背并检查 alpha、边缘和污染。
2. 真透明路径：经明确批准后改用 `gpt-image-1.5` 的 `background=transparent`。

水墨人物包含发丝、飞白和半透明颜料边缘，直接 chroma-key 可能损坏笔触。因此在角色方向批准前，不生成最终透明资产；母版和动作先使用中性纸背景进行身份审查。

纸底母版直接离线去背只能作为诊断或候选，不是自动批准路径。2026-08-04 的 21 张候选虽通过尺寸、RGBA、CRC、透明边界和覆盖率门禁，但暗底合成暴露脚下纸色/接触阴影，因此全部保持未登记。正式路径必须把批准状态图编辑到完全均匀的键控背景，禁止阴影、纸纹、地平面和反射，再执行本地去背、暗底/亮底边缘检查与人工批准。

正式背景编辑使用 `docs/visual-prompts/runtime-transparent-derivative-v01.prompt.txt`。该 Prompt 对全部 49 个已批准岗位/状态源图复用：Image 1 锁定人物、动作、道具、构图与水墨内部材质，只允许把背景改为均匀 `#00ff00`，并明确禁止接触阴影、纸纹、地面、反射、光晕和主体内键控色。`npm run test:watercolor-production-preflight` 生成不含凭据值的 49 项作业报告，记录源图、源 SHA-256、Prompt SHA-256、`gpt-image-2 edit / 1024x1536 / high / PNG` 请求合同、键控中间输出和正式运行时输出。

## 11. 文件命名

```text
style-a-mineral-ink-v01.png
style-b-urban-wash-v01.png
style-c-layered-2p5d-v01.png
style-d-dark-office-v01.png
cast-seven-roles-v01.png
role-researcher-anchor-v01.png
role-planner-anchor-v01.png
role-writer-anchor-v01.png
role-designer-anchor-v01.png
role-developer-anchor-v01.png
role-review-test-anchor-v01.png
role-operations-anchor-v01.png
role-<role>-state-<state>-v01.png
role-<role>-silhouette-v01.png
role-<role>-portrait-v01.png
office-watercolor-concept-v01.png
```

## 12. 首批生成清单

| ID | 输出 | 请求尺寸 | 质量 | 用途 |
|---|---|---:|---|---|
| B01 | `style-a-mineral-ink-v01.png` | `1536x1024` | high | 推荐风格板 |
| B02 | `style-b-urban-wash-v01.png` | `1536x1024` | high | 轻量备选 |
| B03 | `style-c-layered-2p5d-v01.png` | `1536x1024` | high | 生产结构备选 |
| B04 | `style-d-dark-office-v01.png` | `1536x1024` | high | 深色场景验证 |
| B05 | `cast-seven-roles-v01.png` | `2048x1152` | high | 七人一致性 |
| B06 | `office-watercolor-concept-v01.png` | `2048x1152` | high | Office 方向 |
| R01 | `cast-seven-roles-v02.png` | `2048x1152` | high | 去战术/游戏化、严格七人、清除伪文字 |
| R02 | `office-watercolor-concept-v02.png` | `2048x1152` | high | 固定七岗位、严格七人、清除伪文字 |

冻结结论：角色以 STYLE-A 为主、STYLE-D 为深色界面辅助参考；R01 已用于生产七个独立角色母版；R02 仅作为 Three.js 空间重建概念参考。首批风格与场景记录见 `docs/CAOGEN-WATERCOLOR-FIRST-BATCH-QC.md`，角色母版、Tool-Running 状态、实际输出尺寸、SHA-256 和 96px 证据见 `docs/CAOGEN-WATERCOLOR-CHARACTER-BATCH-QC.md`。

七个独立角色母版、Tool-Running 与 Awaiting-Approval 动作已批准；七张 Idle 直接使用对应批准母图的字节级副本。`blocked` 与 `delivering` 的 14 份完整 Prompt，以及 `thinking` 与 `repairing` 的 14 份完整 Prompt 均已就绪。2026-08-04 全部 28 个命令已按 `gpt-image-2`、edit、1024x1536、high、PNG 重新 dry-run，28/28 通过。后续仍按 `blocked`、`delivering`、`thinking`、`repairing` 的顺序逐批生成、逐批审查，禁止一次生成全部剩余资产后再统一返工。

运行时合同已先行接线：七岗位与七状态由 `src/shared/watercolor-character.ts` 统一定义；招聘表单把显式岗位身份写入 `DigitalWorker.avatarProfile.watercolorRole`；Office 通过不可变 DigitalWorkerBinding 解析岗位，并从真实 Session 与 canonical repair WorkItem 派生七状态。透明 2.5D Three.js Sprite Rig、full/compact 尺寸、reduced-motion、机器人回退和显式 verified-file 门禁已实现；登记表当前为空，因此不会把不透明纸底 PNG 装进 Three.js。透明资产生产、状态切换合成截图、性能验收和机器人主角色退场仍是后续门禁。

透明资产机械门禁：`npm run test:watercolor-production-preflight` 检查 7 个身份母版、42 份状态 Prompt、49 个透明衍生任务、源图与环境就绪状态；`:state-required` 和 `:runtime-required` 分别对两个生产阶段 fail-closed。`npm run test:watercolor-assets` 输出正式运行时 inventory；`npm run test:watercolor-assets:smoke` 用有效 RGBA 与损坏 CRC 双 fixture 验证 PNG 解码门禁；`npm run test:watercolor-assets:required` 要求 49/49 文件通过规范命名、1024x1536、8-bit RGBA、PNG CRC、透明边角、主体覆盖率、半透明边缘和安全边距检查，并与 `VERIFIED_WATERCOLOR_CHARACTER_FILES` 完全一致。

每次透明候选批次必须运行 `npm run generate:watercolor-qc -- --source <candidate-dir> --out-dir output/imagegen/caogen-watercolor-v1/qc --force`。该命令以固定 7 岗位 x 7 状态顺序生成亮底、暗底、96px 灰度和 48px 灰度四张总览，并写入所有输入和总览的 SHA-256。缺失格保持显式空缺；只有最终 49/49 批次才可加 `--required`。总览用于接触阴影、纸底残留、绿边、身份漂移、状态误判和小尺寸可读性的人工审查，不自动批准资产。

## 13. 每张生成结果的记录

每个资产必须保留：

- Asset ID、文件名和用途。
- 完整最终 Prompt，不只保存摘要。
- 模型、尺寸、质量和生成日期。
- 输入参考图及其 SHA-256。
- 输出文件 SHA-256。
- 审查结果：accept、revise 或 reject。
- 仅包含一个明确变化的后续修订 Prompt。
- 资产来源与权利声明。

## 14. 人工验收

- 七岗位盲测辨识率不低于 80%。
- 灰度和 96px 预览仍可区分角色。
- 角色身份在七种动作中保持一致。
- `awaiting-approval`、`blocked`、`repairing` 和 `delivering` 不依赖颜色即可区分。
- 不出现机器人、古装、赛博朋克、游戏卡牌或儿童插画倾向。
- 水墨材质在深色办公室中有边界但无发光描边。
- 无文字、Logo、水印、畸形手部、重复肢体或漂浮道具。
- 正式资产具有明确的生成记录、Prompt、Digest 和批准人。
