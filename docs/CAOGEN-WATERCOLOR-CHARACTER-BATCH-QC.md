# CaoGen 水墨角色母版与 Tool-Running 状态 QC

> QC 日期：2026-08-03  
> 请求模型：`gpt-image-2`  
> 执行路径：OpenAI-compatible Image API，通过 imagegen CLI 的 edit 路径生成  
> 请求质量：`high`  
> 请求尺寸：`1024x1536`  
> 资产目录：`output/imagegen/caogen-watercolor-v1/`

## 1. 事实边界

- 本地文件完整性、像素尺寸、RGB 格式、字节数与 SHA-256 已重新核验，信心：高。
- 人数、肢体、道具、伪文字、服装漂移与身份一致性由人工目视审查，信心：高。
- 96px 灰度对比已生成，但当前是专家目视检查，不等同于目标用户盲测，信心：中等。
- 调用请求明确指定 `gpt-image-2`，但经过第三方兼容网关，无法独立证明其真实上游模型路由，信心：未知。
- 网关多次重写了请求尺寸；下表只记录实际 PNG 尺寸，不把请求尺寸冒充结果。

## 2. 公共参考资产

| 用途 | 文件 | SHA-256 |
|---|---|---|
| 批准阵容 | `cast-seven-roles-v02.png` | `dab2dcf49b82fb1efe2a70ed97c9396cf9c32c1499289807438a81edafc46424` |
| 主水墨语言 | `style-a-mineral-ink-v01.png` | `b2632007f7961e058471ddf6a01effe5ddf980471ab27bef555829c88ae7e983` |
| 深色可读性 | `style-d-dark-office-v01.png` | `2ff8452d2efbf1a40b8c6989aedeb8e8df2ce05c2b365c9b11d9273ef9d1b878` |

## 3. 身份裁切参考

身份裁切是对批准群像的无重采样像素裁切，只用于把七个身份分别锁定。裁切中的微小相邻边缘片段在 Prompt 中明确要求忽略。

| 角色 | 参考文件 | SHA-256 |
|---|---|---|
| Researcher | `references/cast-v02-researcher-identity-ref-clean.png` | `229e0fb9fd2c75c05600ba6fda4530aeb35b547be7bf72871021fe3e872e5fec` |
| Planner | `references/cast-v02-planner-identity-ref-clean.png` | `e0fefe5991c4c089aac3f9ed0a17cc4022ee72efa430a5aa20946dff208733a9` |
| Writer | `references/cast-v02-writer-identity-ref-clean.png` | `c9d80004ead90188ad0387d7186c7788260d018725aaa0380b5d91901d3a1558` |
| Designer | `references/cast-v02-designer-identity-ref-clean.png` | `5e2e5c9655935125ffb0b14cb076b2a353bc9034cac0855e4a4e41501ecf6142` |
| Developer | `references/cast-v02-developer-identity-ref-clean.png` | `91f646a30636953a5a0de56e15037d41baf49930623f1c7440fc4c66aafbcdaf` |
| Review/Test | `references/cast-v02-review-test-identity-ref-clean.png` | `1bc92e8c18724fb2df61e68cd1c17b426842d622e06552a616c20fd992e58a12` |
| Operations | `references/cast-v02-operations-identity-ref-clean.png` | `62cc1eac98d015db4c9546c1919d5238429085d6b453eb316cfd454a7d3fab6e` |

## 4. 批准角色母版

| 角色 | 批准输出 | 实际尺寸 | 字节 | 输出 SHA-256 | Prompt SHA-256 | 决策 |
|---|---|---:|---:|---|---|---|
| Researcher | `role-researcher-anchor-v01.png` | 922x1706 | 2,236,239 | `d27031c15a15b13ac052eda5b0cf2fb63536aacdc5469c657f3df1e9f02ffe74` | `e42b38d65f4cef6da01702476fd260117ee8f435a7a661752ee5c53568a08b0e` | accept |
| Planner | `role-planner-anchor-v02.png` | 898x1751 | 1,937,293 | `f262bb176bd1419fd2351cef25ec4d2275d0aff39c31c94f852f5724b92fb0da` | `73c690ac9e6f4738dd7b84c558df228c4dbdc7d5e186fd10170422e43c2d2b39` | accept |
| Writer | `role-writer-anchor-v01.png` | 1024x1536 | 2,539,308 | `cde88094d332666692c8f81ba1aea7b1c292274c4367378815f6047544a5897b` | `01a514911802611bae85ec0df5fce0025f68d0dc5522aef96229e5bced0550ba` | accept |
| Designer | `role-designer-anchor-v01.png` | 861x1827 | 2,229,913 | `71abee843b96770039bb062ea9c8aa6e57683dee6ea0fcc30407c59784e7324c` | `52b647c43fe08a249ad2038dd3c71a10aa9dcec272bd36e199a746dd330d18b3` | accept |
| Developer | `role-developer-anchor-v01.png` | 887x1774 | 2,301,504 | `10b3fc02cdb4af4c8a58a8e14c630e962a92e620051ad8c2da9c35235eba43aa` | `9cf03759b876e9cc1a8d6d6ca6d4922e80af15b35e2e33d139a72c2207b502d3` | accept |
| Review/Test | `role-review-test-anchor-v01.png` | 887x1774 | 2,195,149 | `9309d13fa897e3831286237f8757185d3ad4da5371b4eaef690af40d95a748d4` | `2ae553d40825672c14e19a0d3238a361c42c25929352e265364b73e74f8fe0f2` | accept |
| Operations | `role-operations-anchor-v01.png` | 887x1774 | 2,271,747 | `5bcd6aa62e75f2a487ff2f5f7f7c3ae669301fbc3286bf1250e3d01e6b1c29a1` | `7601642533c46b2b9e1da8c3f64ec6e0e43ebc1bc5513283765d1417aa4c4217` | accept |

完整 Prompt 文件与输出同名，位于 `docs/visual-prompts/`。Planner v01 使用的 Prompt SHA-256 为 `3da03ae3e4e3e6c65be75d240437e7a41c38353df3195f9387ad4c9155a0af03`。

### Planner 被替代版本

- `role-planner-anchor-v01.png`：898x1751，2,099,290 字节。
- 输出 SHA-256：`9228b3243219c571360fc9fc024339739dbdecbb98918fac6e7b7fa770aa0404`。
- 决策：`revise`。大计划纸出现了不必要的淡几何线。
- v02 单一变化：只清除纸面图形，保留物理折痕、身份、服装、姿态和其他道具。

## 5. Tool-Running 状态验证

| 角色 | 输出 | 实际尺寸 | 字节 | 输出 SHA-256 | Prompt SHA-256 | 决策 |
|---|---|---:|---:|---|---|---|
| Researcher | `role-researcher-state-tool-running-v01.png` | 922x1706 | 2,213,016 | `1107114a43f6f00f0e9b09b36c9f46a49375bbd275bd913df013f1727063c7ac` | `fe69a2d0a0968581f983efd4b5aac628c63de6722e0755ab3e6f326104c93815` | accept |
| Planner | `role-planner-state-tool-running-v01.png` | 899x1750 | 1,919,616 | `b62c0315a5bd43272c8d99d0e263465441c52a7702fa4f74b44fbe56349b1001` | `6952dd860051eace5d8db120003bb76c2cdef9b33fdd3944113a3d2ca1472cd1` | accept |
| Writer | `role-writer-state-tool-running-v01.png` | 1024x1536 | 2,575,628 | `d669ad911f5a2661713253096ebf35615ca6bde81ab3b4ec3decb57016b95ee9` | `de30d4f1617bed8cae6d7c7cfb2946ca0a87e7ad9b600c5134baa9553f7db111` | accept |
| Designer | `role-designer-state-tool-running-v01.png` | 861x1827 | 2,064,350 | `4fc06698c72dc8674c06f20e0b292de5b2225d749ea56018b00f54f54fc388b8` | `b017c802d6baa92cd2c703a4314fcc59f785d3f2053ed54f9f45017e86da7a30` | accept |
| Developer | `role-developer-state-tool-running-v01.png` | 887x1774 | 2,170,564 | `d7fe97ca71cd690929c88606009592a0b24773236214db12fcf8cf1c01b76488` | `ffd7726b6249859317d842dd8958b1dcd95bc8bb3b3ebc1015c09dc47d95f6ad` | accept |
| Review/Test | `role-review-test-state-tool-running-v01.png` | 887x1774 | 2,061,761 | `d9a3762dd463adcc0defa827ef744e61ad02bc4174f612359738684e33372bbc` | `a1583912026b4471fb1d6b96e5dda8a153707a40772a552fd1232e8de4fb82bd` | accept |
| Operations | `role-operations-state-tool-running-v01.png` | 887x1774 | 2,227,285 | `7052eace4ff17b3595350eecfc2a9b75cbaafa1919bbad91676d0c46461a0e53` | `eb31154794d2d5c646a4ff0d2399e2a726e43fb19f2ea47509d6c24527ed9427` | accept |

### 5.1 Awaiting-Approval 状态验证

| 角色 | 输出 | 实际尺寸 | 字节 | 输出 SHA-256 | Prompt SHA-256 | 决策 |
|---|---|---:|---:|---|---|---|
| Researcher | `role-researcher-state-awaiting-approval-v01.png` | 922x1706 | 2,092,298 | `8e7e8b57a055cb9368082af102048597c59bc18c56cf096a0097a5a788611fa3` | `72fa7e1d9e5fe31bc80f2064ae63fe425646ce781a3b83c90864ff9ce406694f` | accept |
| Planner | `role-planner-state-awaiting-approval-v01.png` | 898x1752 | 1,965,091 | `dd2151a99f9610c4b1bf6371975b342e5aedfe6db3047ae5a9192987e31a4007` | `c6a52d3e0842760bbf3051cbbda37c48f90cd33c6f0ef4fd52d07c0b21fb200b` | accept |
| Writer | `role-writer-state-awaiting-approval-v01.png` | 1024x1536 | 2,390,005 | `8a5a7d85f56e60aaa5bc3401df0c6eb481023dff4ab148e2b3a52b723289cdf0` | `129c66822c2ef1c077564401db54ba45e4254b7d91a3b43d62b9cde9cff0f9dd` | accept |
| Designer | `role-designer-state-awaiting-approval-v01.png` | 861x1827 | 2,149,314 | `11da0011549c78e0851ffaa496206435a4bb76d629bce0d967eef8f0a8bc3559` | `551005303a7ac68f527cbc985df0ce29d871f706da295c5950f6ffea2fe5ccc1` | accept |
| Developer | `role-developer-state-awaiting-approval-v01.png` | 887x1774 | 2,168,656 | `8cf5632376451e2961fd70f0b263e42dbedfbc357630e5ddf31963ff0f85f849` | `9e47f66cecfbf4f31b2ec054d29a22e7deaf528f0a9b1711e5e0f446b197728c` | accept |
| Review/Test | `role-review-test-state-awaiting-approval-v01.png` | 887x1774 | 2,068,061 | `aa7f7f0e67ef794eb9c4044ef5e90e1e8afaf516262d939d838c1cfad775a745` | `716f57ff689f970afd7ef3cf1e991bc68714733f0e2a419a0089c3919265de1a` | accept |
| Operations | `role-operations-state-awaiting-approval-v01.png` | 887x1774 | 2,158,464 | `142f8c52cc9abad99eca7ea3fa83b7d70ee0bbf39559983e0e32a04480aaf624` | `028d00e554103abe19c3e521916ed34fc7a2c03f4d8197ce46956b8db45aed28` | accept |

## 6. 目视验收结论

- 七张母版均为恰好一人，头、双手、双脚和岗位道具完整。
- 七个角色的脸、发型、体型、服装结构、岗位色和道具均保持群像身份，没有互相混合。
- 未发现文字、代码、Logo、水印、伪文字、重复肢体或漂浮道具。
- 未重新漂向机器人、古装、赛博朋克、战术装备或游戏卡牌。
- 七张 Tool-Running 状态均保持母版身份；动作通过手部与真实道具关系表达，不只依赖换色。
- 七张 Awaiting-Approval 状态均保持母版身份；每张恰好一张空白审批卡和一个朱砂印记，动作处于明确暂停与呈递关系。
- Awaiting-Approval 未发现卡片文字、伪文字、代码、额外人物、重复审批卡或岗位道具丢失。
- Developer 把原有键盘与 slate 合为自然折叠工作形态，屏幕和键位无字符；属于允许的物理使用状态，不是新道具。
- Operations 打开小型状态箱后只显示三个琥珀色状态点和一个旋钮，无文字、无线电或战术元素。

## 7. 96px 灰度证据

- 彩色快速总览：`qc/anchors-vs-tool-running-color-contact-sheet.png`
- 彩色总览 SHA-256：`d0ec8e6c08ddfab9d5bd5d697edc0720e70d75b2fa0fa2deb653bf46078cd5d3`
- 对比图：`qc/anchors-vs-tool-running-96px-grayscale.png`
- SHA-256：`22538646bfa53fda62573e0c479c46cf7728b0974f5a4ee83a11c5f65540e766`
- 第一行是批准母版，第二行是 Tool-Running，固定顺序为 Researcher、Planner、Writer、Designer、Developer、Review/Test、Operations。
- Awaiting-Approval 彩色对照：`qc/anchors-vs-awaiting-approval-color-contact-sheet.png`
- Awaiting-Approval 彩色对照 SHA-256：`81101ff9cf420f5d4d0e80b49d1f3ae2b20e1af93a2723229518361d0f83986b`
- Awaiting-Approval 96px 灰度对照：`qc/anchors-vs-awaiting-approval-96px-grayscale.png`
- Awaiting-Approval 灰度对照 SHA-256：`e69f8f4b31f8f836e38c2ab32b2ee9f70ba29b4087513a862e552df90354b567`
- Idle、Tool-Running、Awaiting-Approval 三状态 48px 灰度极限对照：`qc/idle-tool-running-awaiting-approval-48px-grayscale.png`
- 48px 灰度极限对照 SHA-256：`47868bd361adfa894ccd6ef785461c61e48bc16659b39442fa62c6617dd7868e`
- 专家目视下，七个岗位能通过轮廓与道具区分；Tool-Running 与母版 idle 的手部/道具关系也可区分。
- 48px 专家目视下，七岗位轮廓与三种现有状态仍可区分；该结论的信心为中等，不能替代目标用户盲测。
- 正式产品门禁仍要求至少 10 名非项目成员完成无标签盲测，岗位识别率不低于 80%。当前证据不能替代该测试。

## 8. 当前生产门禁

角色身份、Tool-Running 与 Awaiting-Approval 一致性已通过。七张批准母图已机械复制为 `state-idle-v01.png`，源与副本 SHA-256 完全一致。`blocked`、`delivering`、`thinking` 与 `repairing` 的 28 份完整 Prompt 已就绪，但图片尚未生成；2026-08-04 按冻结顺序对全部 28 个 `gpt-image-2 edit` 命令重新执行了 `1024x1536 / high / PNG` dry-run，结果为 28/28 通过。48px 专家目视检查已完成，目标用户盲测尚未完成。合格透明 PNG 尚未生成，不能把当前不透明母版直接作为最终运行时资产。

2026-08-04 使用现有 21 张纸底母版进行了离线透明候选试产。机械门禁对候选报告为 `21/49 verified`，证明尺寸、RGBA、PNG CRC、透明边界、主体覆盖、半透明边缘和安全边距链路可工作；深色界面总览保存在 `qc/runtime-transparent-21-candidate-dark-contact-sheet.png`，SHA-256 为 `37fabebcabb623eae0ece8c5d7117c91877baed9585eb35c638f99a7d14c740c`。人工审查仍发现脚下纸色/接触阴影，违反透明运行时规范，因此这 21 张只保留为候选证据，不复制到正式资源目录、不加入 verified 登记表，也不改变 `VIS-002/VIS-005` 完成状态。

透明衍生 Prompt 已冻结为 `docs/visual-prompts/runtime-transparent-derivative-v01.prompt.txt`。生产预检当前确认 7/7 母版和 42/42 状态 Prompt 有效，并为 49 个透明衍生任务记录源图/输出/请求参数和 digest；报告如实显示 21/49 状态母版存在、28 份待生成，且当前进程未注入 API Key/Base URL。`test:watercolor-production-preflight:state-required` 与 `:runtime-required` 已验证会分别在环境或源图不完整时失败。

代码侧已建立七岗位/七状态共享合同、`DigitalWorker.avatarProfile.watercolorRole` 显式身份、RoleTemplate 语义回退、稳定 ID 回退，以及真实 Session 到七种视觉状态的投影。`repairing` 只由绑定 `workflow-repair:<SHA-256>` canonical WorkItem 的活动 Session 触发，不从错误状态猜测。Office 已接入 DigitalWorkerBinding 身份解析、透明 2.5D Three.js Sprite Rig、机器人回退与显式资产登记门禁；登记表当前为空，因此不会消费任何纸底母图。该基础由 `npm run typecheck`、`npm run build`、`npm run test:office-status-recheck` 23/23、Acceptance repair/retest 和真实 Electron 重启 E2E 覆盖；它不等于最终水墨资产已经完成。

透明运行时准入命令为 `npm run test:watercolor-assets`；发布门禁为 `npm run test:watercolor-assets:required`。门禁要求 7 岗位 x 7 状态共 49 张 1024x1536、8-bit RGBA、透明边角、合理主体覆盖的 PNG，并核对运行时登记清单。正式资产目录当前报告仍为 0/49 incomplete。门禁已修复首张 PNG 触发的 CRC 表初始化顺序缺陷，并由 `npm run test:watercolor-assets:smoke` 同时验证一个合格 RGBA fixture 和一个损坏 IDAT CRC fixture；候选通过不能替代人工边缘验收或 49/49 required 门禁。

## 9. 权利与安全

- 全部 Prompt 均要求原创 CaoGen 角色，不提示模仿在世艺术家，不包含第三方角色或商标。
- API 密钥未写入任何 Prompt、文档、图片清单或 Git 文件。
- 当前正式母版 PNG 均为不透明 RGB；离线透明候选未获准注册。没有获得授权前，不切换到 `gpt-image-1.5` 原生透明路径。
## Runtime delivery update (2026-08-04)

The interim 0/49 statements above are superseded by the completed runtime delivery recorded here:

- All 49 role/state masters were edited with the frozen `runtime-transparent-derivative-v01` prompt through the configured compatible image gateway. No User or Machine credential value was written to the repository.
- The installed runtime set is `src/renderer/src/assets/watercolor-characters/`, with 49 canonical `role-<role>-state-<state>-v01.png` files. Each is normalized, without crop or stretch, to 1024x1536 PNG RGBA with transparent corners.
- `npm run test:watercolor-assets:required` passes: 49/49 verified, 49/49 registered. The required QC contact-sheet run passes with 49/49 present and 0 invalid across light, dark, 96px grayscale and 48px grayscale sheets.
- The remaining product gate is the planned external blind role-recognition review; it is separate from the delivered, registered runtime files and their mechanical package checks.

## Awaiting-approval correction update (2026-08-04)

- The seven awaiting-approval decisions and digests in section 5.1 are superseded. The centered filled red disc was rejected because the white-card composition resembled a national flag.
- Every corrected approval slip now has a clipped upper corner and one off-center empty cinnabar square frame. Filled red discs, circular seals and flag-like compositions are forbidden by the state prompts and production preflight.
- The seven opaque awaiting-approval masters are deterministically composited from the same approved RGBA sources used by the runtime installer. This avoids identity, face, tool and style drift from another generative edit.
- The runtime asset gate now rejects a filled cinnabar circular component surrounded by light approval paper; its smoke test proves both rejection of the former red-disc topology and acceptance of valid RGBA input.
- Final visual evidence is in `output/imagegen/caogen-watercolor-v1/qc-final/`: light background, dark background, 96px grayscale and 48px grayscale contact sheets. Writer `thinking`, `tool-running`, `blocked` and `repairing` remain the weakest distinctions at 48px and should be included in the separate blind-recognition study.
