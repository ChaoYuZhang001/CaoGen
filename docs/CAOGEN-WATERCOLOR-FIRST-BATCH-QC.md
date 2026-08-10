# CaoGen 水墨视觉首批资产 QC 与追溯清单

> QC 日期：2026-08-03  
> 请求模型：`gpt-image-2`  
> 执行路径：OpenAI-compatible Image API，通过 imagegen CLI 生成  
> 首批目录：`output/imagegen/caogen-watercolor-v1/`  
> 提示词记录：`docs/visual-prompts/caogen-watercolor-first-batch.gpt-image-2.jsonl`

## 1. 事实边界

- 文件完整性、像素尺寸、颜色格式与 SHA-256 均在本地重新核验，信心：高。
- 视觉判断由人工目视完成，信心：高。
- 请求参数指定了 `gpt-image-2`，但调用经过第三方兼容网关；若网关不提供可验证的上游路由证明，无法独立证明最终上游模型。信心：未知。
- B05、B06 的实际输出尺寸与请求尺寸不一致，说明兼容网关或其下游服务对尺寸进行了重写。不得把请求尺寸当作实际资产尺寸。

## 2. 文件清单

| ID | 文件 | 请求尺寸 | 实际尺寸 | 格式 | 字节 | SHA-256 |
|---|---|---:|---:|---|---:|---|
| B01 | `style-a-mineral-ink-v01.png` | 1536x1024 | 1536x1024 | PNG RGB24 | 3,017,625 | `b2632007f7961e058471ddf6a01effe5ddf980471ab27bef555829c88ae7e983` |
| B02 | `style-b-urban-wash-v01.png` | 1536x1024 | 1536x1024 | PNG RGB24 | 2,988,807 | `230cd163d506eadf89bee3c6f46138ac0babfcdcc59ea370ddb270194f46f87a` |
| B03 | `style-c-layered-2p5d-v01.png` | 1536x1024 | 1536x1024 | PNG RGB24 | 2,529,804 | `594a5962c042e16cfafcacb06a46cf9369a302990940147e66ebc32c39ab1f63` |
| B04 | `style-d-dark-office-v01.png` | 1536x1024 | 1536x1024 | PNG RGB24 | 2,377,517 | `2ff8452d2efbf1a40b8c6989aedeb8e8df2ce05c2b365c9b11d9273ef9d1b878` |
| B05 | `cast-seven-roles-v01.png` | 2048x1152 | 1693x929 | PNG RGB24 | 2,750,183 | `b8c2d9a767e4a3c5b03a28507c093e4bf371033b0d537bea068e82f43b2dc7ae` |
| B06 | `office-watercolor-concept-v01.png` | 2048x1152 | 1536x1024 | PNG RGB24 | 2,768,691 | `be63918bf0f25c96e022dba4e1d3ef10cadcb6fdfcfe9bc56e464969c5887351` |

## 3. 审查决策

| ID | 决策 | 可保留内容 | 不通过项 | 下一步 |
|---|---|---|---|---|
| B01 | accept-reference | 当代水墨人物、纸张与颜料质感、专业克制、角色完整度 | 人物职业区分仍弱，不是最终角色母版 | 作为角色主风格参考 |
| B02 | reject-direction | 小尺寸轮廓较清楚、轻量水彩 | 过于通用的都市插画，CaoGen 识别度弱 | 仅归档，不进入主生产链 |
| B03 | reject-proof | 人体比例和留白可参考 | 没有真正证明头、躯干、前臂、手、道具和衣摆可拆层，不能作为 2.5D 生产验收 | 后续必须以实际分层文件和动画测试验收 |
| B04 | accept-reference | 深色背景边界、哑光矿物色、无霓虹的可读性 | 仍是风格板，不是实际 96px/48px UI 验收 | 作为深色界面辅助参考 |
| B05 | revise | 七人数量正确，角色颜色与大类道具有区分 | 开发/运维明显战术化和游戏化；部分服装接近长袍；道具出现伪文字；整体像游戏角色阵容 | 使用 v02 提示词返工 |
| B06 | revise | 办公室空间清晰，现代水彩建筑适合 Three.js 重建 | 实际出现 10 人而非 7 人；屏幕、白板和文档出现伪文字；角色岗位映射不够固定 | 使用 v02 提示词返工 |

## 4. 冻结方向

正式角色生产采用 B01 的人物与材质语言，并吸收 B04 的深色界面轮廓可读性。B02 不进入主方向；B03 不作为 2.5D 可生产性的证据。七角色母版、状态动作、透明切图和 Three.js 场景不得在 B05/B06 v02 验收前批量生产。

## 5. v02 单一修订目标

- `cast-seven-roles-v02.png`：只修正角色阵容的当代职业感、战术/游戏化漂移与伪文字，保持“恰好七人”的结构。
- `office-watercolor-concept-v02.png`：只修正为固定七岗位、恰好七人并清除伪文字，保持现代水彩开放办公室的空间方向。

完整提示词：

- `docs/visual-prompts/cast-seven-roles-v02.prompt.txt`
- `docs/visual-prompts/office-watercolor-concept-v02.prompt.txt`

## 6. 权利与安全记录

- 提示词要求原创 CaoGen 角色，不指定模仿在世艺术家，不包含第三方商标或角色。
- API 密钥不属于视觉资产，不得写入提示词、清单、代码、日志归档或 Git。
- 当前 PNG 为不透明 RGB 概念稿。`gpt-image-2` 不支持原生透明背景；透明生产资产必须另走经批准的色键去背或 `gpt-image-1.5` 原生透明流程。

## 7. v02 生成记录

生成日期：2026-08-03。两张图均使用 `gpt-image-2`、`quality=high` 和三张输入参考图，通过 Image API edit 路径生成。请求尺寸均为 2048x1152；兼容网关返回了不同但接近 16:9 的实际尺寸。

### R01：七角色群像 v02

- 输出：`output/imagegen/caogen-watercolor-v1/cast-seven-roles-v02.png`
- 实际尺寸：1693x929，PNG RGB24，2,510,172 字节
- 输出 SHA-256：`dab2dcf49b82fb1efe2a70ed97c9396cf9c32c1499289807438a81edafc46424`
- 完整 Prompt：`docs/visual-prompts/cast-seven-roles-v02.prompt.txt`
- Prompt SHA-256：`6616bcfd00777b12058d7f39f1c443b7859b8c07c647ce4d31e7fea1a6580f48`
- Image 1：`cast-seven-roles-v01.png`，SHA-256 `b8c2d9a767e4a3c5b03a28507c093e4bf371033b0d537bea068e82f43b2dc7ae`
- Image 2：`style-a-mineral-ink-v01.png`，SHA-256 `b2632007f7961e058471ddf6a01effe5ddf980471ab27bef555829c88ae7e983`
- Image 3：`style-d-dark-office-v01.png`，SHA-256 `2ff8452d2efbf1a40b8c6989aedeb8e8df2ce05c2b365c9b11d9273ef9d1b878`
- 决策：`accept-direction`
- 通过项：恰好七人；左到右七岗位映射清晰；现代民用工作服；完整头、手、脚和道具；无可见文字、代码或伪文字；开发和运维不再是战术/赛博朋克造型；整体保持 STYLE-A 水墨语言。
- 非生产项：这是一张群像方向稿，不是七个独立身份母版；角色在 96px 的盲测识别率、动作身份一致性、透明边缘和实际深色 UI 对比度尚未验证。
- 下一步单一变化：以该群像为阵容约束，逐个生成七张独立角色母版，不同时生成状态动作。

### R02：办公场景 v02

- 输出：`output/imagegen/caogen-watercolor-v1/office-watercolor-concept-v02.png`
- 实际尺寸：1672x941，PNG RGB24，2,707,801 字节
- 输出 SHA-256：`54391243435d79ef6ed503a0256b4c29f020d228c18d56a7f3bcf4c9202ea705`
- 完整 Prompt：`docs/visual-prompts/office-watercolor-concept-v02.prompt.txt`
- Prompt SHA-256：`49bc612312235d380fded10d76eaac8e05b01b6250f3135a1058a6658e03b410`
- Image 1：`office-watercolor-concept-v01.png`，SHA-256 `be63918bf0f25c96e022dba4e1d3ef10cadcb6fdfcfe9bc56e464969c5887351`
- Image 2：`style-a-mineral-ink-v01.png`，SHA-256 `b2632007f7961e058471ddf6a01effe5ddf980471ab27bef555829c88ae7e983`
- Image 3：`style-d-dark-office-v01.png`，SHA-256 `2ff8452d2efbf1a40b8c6989aedeb8e8df2ce05c2b365c9b11d9273ef9d1b878`
- 决策：`accept-concept-with-layout-constraint`
- 通过项：恰好七人且每个岗位区一人；现代开放办公室；中央流转路径清晰；审批台和交付架无人值守；屏幕为纯色或三状态点；纸面没有伪文字；无机器人、古建筑、赛博朋克或浮动 UI。
- 布局约束：右下运维区会与全高右侧 Inspector 叠加。Three.js 重建必须在响应式布局中把 Inspector 作为受约束的 UI 占位，缩放或左移办公室可交互区，不能直接把此位图当最终背景。
- 下一步单一变化：先建立不含人物的 Three.js 空间灰盒并验证桌面与移动端 Inspector 安全区，再把批准角色实例放入七个固定锚点。

## 8. 当前冻结结论

首批视觉方向已经足够进入“七个独立角色母版”阶段，但还不足以直接生产七角色乘七状态的 49 张动作资产。继续批量生成前必须逐个批准角色身份，否则局部脸型、服装结构和道具设计会在 49 张资产中放大漂移与返工成本。
