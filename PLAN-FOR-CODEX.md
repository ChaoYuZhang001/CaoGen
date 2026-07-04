# CaoGen 执行计划(交给 Codex)

> 本计划基于 2026-07-05 对代码库的 10 路只读审计(真实读码,非推测)。
> 分工:此计划由规划方产出;**Codex 按阶段执行**;完成后由规划方 check。
> 硬约束(每个任务都适用):
> - 每完成一个任务:`npm run typecheck` 必须通过、`npm run build` 必须通过,否则不算完成。
> - 链路完整定义:主进程模块 → `ipc.ts` handler → `preload/index.ts` → `shared/types.ts` 的 `AgentDeskApi` → `store.ts` action → UI 组件,**六环齐全**才算接通。
> - 热点文件(ipc/preload/types/store)串行改,避免互相覆盖。
> - 不引入新的外部网络依赖到 agent 运行路径;安全默认(参数化、路径穿越防护)。
> - 每个任务独立提交,提交信息说明「做了什么 + 怎么验证的」。

## 审计结论:哪些已完成(勿重做)

- ✅ **Routine UI 闭环** done:建/编辑/删/启停/手动运行 + 下次运行显示 + 后台定时执行全通(仅一处非阻塞小改进,见 T7)。
- ✅ **记忆 UI(手动)** done:MemoryPanel 挂载可用,增删查确认全通(自动提议缺,见 T5)。
- ✅ **图片预览** done:previewOps 返回 base64 dataUrl(`previewOps.ts:160`),不再裂图。
- ✅ **PDF 预览** done:PreviewRenderer 用 `<object>+<iframe>` 真渲染(`PreviewRenderer.tsx:305`)。
- ✅ **浏览器切面板隐藏** done:有 `removeChildView` + `setBounds(0,0,0,0)`(`browserView.ts:62,136`)。
- ✅ **Worktree 隔离 + 合并回主干** done:inspect/check/applyPatch 全通(规划方已实测)。

---

## 阶段一:核心工作流闭环(最高优,让日常开发不出 App)

### T1 · 应用内 Git 提交 —— status: **missing**,全新建
证据:全仓无 stage/commit/push 写操作;`worktrees.ts:69` 有 `git(cwd,args)=execFileSync('git',...)` 助手可参照,唯一 git 写是 `worktrees.ts:334` worktree add。
步骤:
1. 新建 `src/main/gitOps.ts`:导出 `gitStatus(cwd)`(porcelain 解析出 staged/unstaged/untracked 文件列表 + 当前分支)、`stageFiles(cwd, paths[])`(`git add --`)、`stageAll(cwd)`、`unstageFiles(cwd,paths[])`、`commit(cwd,message)`(`git commit -m`,返回新 commit sha/error)、`currentBranch(cwd)`。全部 execFile git、cwd 传入、超时 30s、参数数组化(禁字符串拼接防注入)。commit 前校验有暂存内容,空则返回明确 error。
2. `ipc.ts` 注册 `git:status` / `git:stage` / `git:stageAll` / `git:unstage` / `git:commit`,cwd 从 `sessionManager.get(id)?.meta.cwd` 取(隔离会话即 worktree cwd,提交落在 worktree 分支,合理)。
3. `preload/index.ts` 暴露 `gitStatus/stageFiles/stageAll/unstageFiles/gitCommit`。
4. `shared/types.ts` 加 `GitFileStatus`/`GitStatus` 类型 + `AgentDeskApi` 五方法。
5. `store.ts` 加 git 面板状态 + action(refreshGitStatus/stage/commit)。
6. UI:`WorkbenchRoot.tsx` 加「Git」面板(参照 DiffPanel 挂法),或在 DiffPanel 顶部加提交条:文件勾选 → 暂存 → 填 message → 提交。含成功/失败提示。
坑:不做 push(涉及凭据/远端,超范围,本期只本地提交);提交信息为空或无暂存内容要拦。commit 用 `-m` 单参数数组,勿 shell 拼接。

### T2 · 逐块 diff accept/reject —— status: **missing**,DiffPanel 当前纯只读
证据:`DiffPanel.tsx` 只有 refresh/close,hunk 只渲染不可交互;`gitDiff.ts:19` getWorkspaceDiff 纯读。
步骤:
1. `gitDiff.ts` 加 `applyHunk(cwd, filePath, hunkPatch, {reverse})`:把单个 hunk 组装成合法 patch 文本,`git apply --cached`(接受→暂存)或 `git apply -R`(丢弃→还原工作区)。需保留 diff 解析时每个 hunk 的原始 patch 文本(header + 行),供回组。
2. `ipc.ts` 加 `workspace:applyHunk` / `workspace:discardHunk`。
3. preload + types + store action。
4. `DiffPanel.tsx` 每个 hunk 头加 ✓(接受/暂存)/ ✕(丢弃)按钮,操作后 refreshDiffPanel。
坑:hunk patch 必须以换行结尾(参照 `worktrees.ts:415` 注释,否则 corrupt patch);discard 是破坏性操作,加二次确认;二进制 hunk 不提供按钮。

---

## 阶段二:第五支柱补全(长期自主执行)

### T3 · 真子代理编排结果回传 + 3D 真实任务流 —— status: **partial**
证据:派发链路真实贯通(`SubagentPanel.tsx:145`→`store.dispatchSubagents`→`ipc.ts:413`→`sessionManager.ts:119` 真起独立 worktree 子会话),但**子结果不回传父会话、3D MessagePackets 未绑真实父子数据**。
步骤:
1. `sessionManager.ts:190` dispatch 内:当 `event.kind==='turn-result'` 且该会话 `meta.parentSessionId` 存在时,向父会话下发子结果。
2. `shared/types.ts` AgentEvent 加 `subagent-result`(orchestrationId/childTaskId/childRole/status/resultText/costUsd/durationMs);`store.ts` reducer 把子结果聚合到父 SessionState 的 `childResults: Record<taskId,...>`。
3. `SubagentPanel.tsx` 加「编排结果」区,显示每个子 Agent done/error/成本/摘要。
4. 3D:`model.ts` 的 `buildOfficeModel`(:267)接收每会话 `parentSessionId`,为子会话生成 from=父工位 to=子工位的 packet;`MessagePackets.tsx:47` 新增跨工位分支(区别于自环的工具活动),渲染父子编排流。
坑:一次最多 33 子会话,勿再放大并发(代理 API 配额,见规划方记忆);父工位可能不在同屏(activeId 过滤),连边前判父工位缺失;跨会话写父 transcript 注意 seq 顺序。

### T4 · 开工建议接线 —— status: **missing**,helper + 面板都在但零接线
证据:`startSuggestions.ts:100` getStartSuggestions 完整(支持 memory/worktree/history/routine/failure 输入 + git/README/package 扫描);`StartSuggestionsPanel.tsx:52` 面板完整;但 ipc/preload/types/store/WorkbenchRoot 全无接线,仅冒烟测试引用。
步骤:
1. `shared/types.ts`:把 main 的 `StartSuggestion` 提为共享类型(替换面板里独立的 `StartSuggestionPanelItem`,避免双轨);AgentDeskApi 加 `getStartSuggestions(sessionId)`.
2. `ipc.ts` 注册 `startSuggestions:get`:从 session 取 cwd,喂入 `readProjectMemory(cwd).entries`(映射到 StartSuggestionSignal 的 title/body/status/failed 字段)、`getManagedWorktreeSummary(id)`、`listHistory()`、`listRoutines()`。
3. preload + store action `refreshStartSuggestions` + 忽略态(ignore/later)。
4. `WorkbenchRoot.tsx` 挂载 StartSuggestionsPanel,`onSendToAgent`→复用 Composer 发送,会话激活时 refresh。
坑:getStartSuggestions 是同步 spawnSync+readFile(git 超时 2s),放 ipc.handle 可接受但注意别高频调;输入源字段务必映射到 helper 期望的 failed/ok/status,否则失败建议分支不触发;onLater/onIgnore 需本地忽略态。

### T5 · 记忆自动提议 —— status: **missing**(手动记忆已 done)
证据:`memoryInject.ts:63` shouldProposeMemory(关键词表已备)零调用;send 路径无 hook;无 memory-suggestion 事件。
步骤:
1. `ipc.ts:443` `sessions:send` handler 内,payload 就绪后:`if (payload.text && shouldProposeMemory(payload.text)) win.webContents.send('memory:suggestion', {sessionId:id, text:payload.text})`;顶部 import shouldProposeMemory。
2. types 加 `onMemorySuggestion` 事件订阅;preload 加 `ipcRenderer.on('memory:suggestion',...)`(参照 browser/terminal 事件订阅);store 监听写入 `memorySuggestion` state + dismiss/accept action。
3. UI:ChatView/Composer 附近渲染轻量提示条「记住这条约定?」→「记住」打开 MemoryPanel 预填 form(给 MemoryPanel 加可选 initialForm prop)/「忽略」dismiss。
坑:同 session 已有未处理提示要去重/节流;命中关键词只弹提示,勿自动落 draft;关键词表偏中文,英文不触发(已知局限)。

### T6 · 内置浏览器批注截图 —— status: **partial**
证据:`screenshotPath` 类型+持久化就绪(`browserAnnotations.ts:25,81`),但 `browserView.ts:145` captureAnnotation 只取 selection,从不 capturePage,screenshotPath 恒空。
步骤:captureAnnotation 取完 selection 后先 `randomUUID()` 生成 annotationId,`await record.view.webContents.capturePage()`(try/catch,失败不阻断保存),`image.toPNG()` 写 `annotationsRoot()/sessionId/${id}.png`,把 id+screenshotPath 一并传入 annotationInput 复用 saveAnnotation。
坑:view bounds 为 0(不可见)时截图空白,需判可见或先 setBounds;annotationId 须匹配 `[A-Za-z0-9_-]`;失败留空不阻断。

### T7 · Routine 首帧下次运行(非阻塞小改进)—— status: done 的尾巴
`routineStore.ts:118` createRoutine 里,enabled 且未显式传 nextRunAt 时调 `computeNextRun(schedule, now)` seed,消除保存后最长 30s 才显示"下次运行"的滞后。

---

## 阶段三:治理与分发(可信度 + 产品化)

### T8 · 预算闸门 —— status: **missing**,只有字段无逻辑
证据:Routine.budgetUsd(`types.ts:494`)只落盘无消费;Provider 无 budgetUsd 字段;agentSession/scheduler 从不比较 costUsd 与预算。
步骤:
1. `settings.ts` 加全局 `budgetUsdPerSession`(0=不限);Provider 可选加 budgetUsd。
2. `agentSession.ts` send 前:若会话累计 `meta.costUsd` ≥ 生效预算(会话 provider > 全局),拦截并 emit 明确错误"已达预算上限 $X,如需继续请调高预算";routine 触发的会话用 routine.budgetUsd。
3. settings UI + provider 编辑器加预算输入;超限提示可"本次放行/调高"。
坑:costUsd 是上一轮结束后才更新,闸门是"下一轮 send 前"检查(非硬实时);0/未设=不限。

### T9 · 检查点 chat/both 回退 SDK 上下文 —— status: **partial**
证据:`agentSession.ts:471` restoreCheckpoint 对 chat 只截断 CaoGen transcript(`transcript.ts:102`),全程不用 `resumeSessionAt`(sdk.d.ts 有此选项),故回退后 agent 仍记得被删轮次。
步骤:chat/both 应用成功后存 `this.resumeAtId = 目标 uuid`;下次 start() options 注入 `resume: sdkSessionId, resumeSessionAt: this.resumeAtId`,使 SDK 只回放到该 uuid。both 模式注意先校验 chat.ok 再执行文件回退,避免部分状态(现为先文件后 transcript,失败不一致)。
坑:resumeSessionAt 是 SDK 选项,需读 sdk.d.ts:1758 确认精确签名;跨重启会话 code 模式回退本就受限(SDK 文件快照随进程走),UI 应提示历史会话检查点不可回退代码。

### T10 · 打包签名 + 自动更新接线 —— status: **partial**(DMG 打包 done)
证据:`npm run dist:mac` 结构就绪(package.json build 段完整、icon 存在);但无签名/公证字段、electron-updater 未装、无 publish 配置、updater.ts 骨架的 check/download/subscribe 零调用点。
步骤:
1. `npm i electron-updater`(dependencies);package.json build 加 publish 配置(github 或 generic)。
2. build.mac 加 hardenedRuntime/entitlements/notarize(teamId),新建 build/entitlements.mac.plist;签名凭据经环境变量注入不入库。
3. 接更新链路:ipc 加 updater:check/download/quitAndInstall + subscribeUpdater 转发事件到渲染层;preload 暴露 updater.*;types 加 UpdaterEvent + AgentDeskApi.updater;store 订阅 + 设置页加"检查更新"入口(遵守 autoDownload=false,发现才提示,用户点才下载)。
坑:签名/公证需 Apple Developer 证书(高风险外部依赖,凭据不可入库,规划方或用户提供);未签名包 electron-updater mac 校验会失败;mac.target 目前仅 x64,arm64 用户需 Rosetta(可选补 universal)。

---

## 执行顺序(建议)

1. **先阶段一**(T1 Git 提交 → T2 逐块 diff):补齐"编码→审→提交"核心闭环,日常开发不出 App。
2. **再阶段二**(T4 开工建议 → T5 记忆自动提议 → T3 子代理回传 → T6 批注截图 → T7 小改进):第五支柱补全,多为已就位模块接线,风险低。
3. **最后阶段三**(T8 预算闸门 → T9 检查点上下文 → T10 打包签名):治理与分发,T10 依赖外部证书。

每个 T 独立提交。全部完成后交规划方 check(会逐条 E2E 复验,重点查"接线了但运行时坏"的隐患)。

