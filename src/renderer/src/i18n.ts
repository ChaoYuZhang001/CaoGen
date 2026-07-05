import { useStore } from './store'
import type { AppLanguage } from '../../shared/types'

/**
 * 轻量 i18n:按当前语言查字典,缺失回退中文再回退 key。
 * 支持 {name} 占位符插值:t('key', { name: 'x' })。
 */
type Dict = Record<string, { zh: string; en: string }>

const DICT: Dict = {
  // 导航 / 通用
  newSession: { zh: '+ 新建会话', en: '+ New Session' },
  office3d: { zh: '🏢 3D 办公区', en: '🏢 3D Office' },
  settings: { zh: '⚙ 设置', en: '⚙ Settings' },
  listView: { zh: '列表视图', en: 'List View' },
  ongoing: { zh: '进行中', en: 'Active' },
  projects: { zh: '项目', en: 'Projects' },
  newSessionHere: { zh: '在此项目新建会话', en: 'New session here' },
  recent: { zh: '最近会话', en: 'Recent' },
  pinned: { zh: '置顶', en: 'Pinned' },
  archived: { zh: '归档', en: 'Archived' },
  sidebarSearchPlaceholder: { zh: '搜索标题、项目或路径', en: 'Search title, project or path' },
  noRecentSessions: { zh: '暂无最近会话', en: 'No recent sessions' },
  noArchivedSessions: { zh: '暂无归档会话', en: 'No archived sessions' },
  noMatchingSessions: { zh: '没有匹配的会话', en: 'No matching sessions' },
  sidebarEmptyHeroTitle: { zh: '还没有会话', en: 'No sessions yet' },
  moreActions: { zh: '更多操作', en: 'More actions' },
  pinSession: { zh: '置顶', en: 'Pin' },
  unpinSession: { zh: '取消置顶', en: 'Unpin' },
  archiveSession: { zh: '归档', en: 'Archive' },
  unarchiveSession: { zh: '取消归档', en: 'Unarchive' },
  copyPath: { zh: '复制路径', en: 'Copy path' },
  noSessions: { zh: '暂无会话', en: 'No sessions' },
  cancel: { zh: '取消', en: 'Cancel' },
  save: { zh: '保存', en: 'Save' },
  rename: { zh: '重命名', en: 'Rename' },
  delete: { zh: '删除', en: 'Delete' },
  closeSessionConfirm: { zh: '关闭会话「{title}」?', en: 'Close session "{title}"?' },
  deleteHistoryConfirm: {
    zh: '删除历史会话「{title}」? 该操作不可撤销。',
    en: 'Delete history session "{title}"? This cannot be undone.'
  },
  awaitingApproval: { zh: '等待授权', en: 'Awaiting approval' },
  resumeSessionTitle: { zh: '恢复会话:{cwd}', en: 'Resume session: {cwd}' },
  // 会话状态
  statusStarting: { zh: '启动中', en: 'Starting' },
  statusRunning: { zh: '运行中', en: 'Running' },
  statusIdle: { zh: '空闲', en: 'Idle' },
  statusError: { zh: '错误', en: 'Error' },
  statusClosed: { zh: '已关闭', en: 'Closed' },
  // 聊天视图
  switchModel: { zh: '切换模型', en: 'Switch model' },
  permissionMode: { zh: '权限模式', en: 'Permission mode' },
  stop: { zh: '⏹ 停止', en: '⏹ Stop' },
  closeSession: { zh: '关闭会话', en: 'Close session' },
  providerOfficial: { zh: '官方', en: 'Official' },
  unknownProvider: { zh: '未知 Provider', en: 'Unknown provider' },
  provider: { zh: '厂商', en: 'Provider' },
  model: { zh: '模型', en: 'Model' },
  statusContext: { zh: '上下文', en: 'Context' },
  thinkingLive: { zh: '思考中…', en: 'Thinking…' },
  agentWorking: { zh: 'Agent 工作中…', en: 'Agent working…' },
  // 消息项
  you: { zh: '你', en: 'You' },
  thinkingProcess: { zh: '思考过程', en: 'Thinking' },
  turnDone: { zh: '本轮完成', en: 'Turn completed' },
  turnErrorTag: { zh: '本轮异常({subtype})', en: 'Turn error ({subtype})' },
  cumulative: { zh: '累计', en: 'Total' },
  routingTitle: { zh: '智能调度决策', en: 'Smart routing decision' },
  failoverTitle: { zh: '厂商故障自动切换', en: 'Automatic provider failover' },
  failoverText: {
    zh: '{from} 故障({reason}),已切换 → {to},自动重试中',
    en: '{from} failed ({reason}), switched → {to}, retrying automatically'
  },
  // 输入区
  composerQueuedPlaceholder: {
    zh: '继续输入,消息将排队处理…',
    en: 'Keep typing — messages will queue…'
  },
  composerPlaceholder: {
    zh: '让 Agent 做点什么…(Enter 发送,Shift+Enter 换行)',
    en: 'Ask the Agent to do something… (Enter to send, Shift+Enter for newline)'
  },
  send: { zh: '发送', en: 'Send' },
  // 权限条
  permissionRequest: { zh: '请求使用工具', en: 'Requests permission to use' },
  allow: { zh: '允许', en: 'Allow' },
  deny: { zh: '拒绝', en: 'Deny' },
  // 欢迎页
  welcomeSub: { zh: '多会话并行的桌面 AI 编码 Agent', en: 'Parallel multi-session desktop AI coding agent' },
  welcomeCta: { zh: '选择项目目录,开始工作', en: 'Pick a project folder to start' },
  welcomeAsk: { zh: '今天想做点什么?', en: 'What should we build today?' },
  welcomeInputPlaceholder: { zh: '随心输入,回车即开始新会话…', en: 'Type anything, Enter to start…' },
  welcomePickProject: { zh: '选择项目', en: 'Choose project' },
  welcomeNeedProject: { zh: '请先选择项目目录', en: 'Pick a project folder first' },
  welcomeBrowse: { zh: '浏览…', en: 'Browse…' },
  featParallel: { zh: '多会话并行', en: 'Parallel sessions' },
  featParallelDesc: {
    zh: '同时在多个项目上运行 Agent,互不阻塞',
    en: 'Run agents on multiple projects at once, nothing blocks'
  },
  featTools: { zh: '工具调用可视化', en: 'Visible tool calls' },
  featToolsDesc: {
    zh: 'Bash / 编辑 / 搜索每一步都看得见',
    en: 'Every Bash, edit and search step in plain sight'
  },
  featDiff: { zh: 'Diff 审查', en: 'Diff review' },
  featDiffDesc: {
    zh: '文件修改以差异视图呈现,一目了然',
    en: 'File changes rendered as diffs, clear at a glance'
  },
  featPerm: { zh: '权限掌控', en: 'Permission control' },
  featPermDesc: {
    zh: '敏感操作逐条审批,或一键切换模式',
    en: 'Approve sensitive actions one by one, or switch modes in a click'
  },
  featCost: { zh: '成本仪表盘', en: 'Cost dashboard' },
  featCostDesc: {
    zh: '每轮对话的 token 与费用实时统计',
    en: 'Live token and cost stats for every turn'
  },
  featResume: { zh: '会话恢复', en: 'Session resume' },
  featResumeDesc: {
    zh: '历史会话随时恢复上下文继续工作',
    en: 'Pick up past sessions with full context anytime'
  },
  // 新建会话
  newSessionTitle: { zh: '新建会话', en: 'New Session' },
  recentProjects: { zh: '最近项目', en: 'Recent projects' },
  projectDir: { zh: '项目目录', en: 'Project directory' },
  browse: { zh: '浏览…', en: 'Browse…' },
  providerLabel: { zh: '厂商 / Provider', en: 'Provider' },
  engineLabel: { zh: 'Agent 引擎', en: 'Agent engine' },
  officialAnthropicDefault: { zh: '官方 Anthropic(默认登录)', en: 'Official Anthropic (default login)' },
  noKeyConfigured: { zh: '未配置密钥', en: 'No API key' },
  autoRoute: { zh: '🧭 自动调度', en: '🧭 Auto route' },
  errNeedProjectDir: { zh: '请选择项目目录', en: 'Please pick a project directory' },
  creating: { zh: '创建中…', en: 'Creating…' },
  create: { zh: '创建', en: 'Create' },
  // 3D 办公区
  officeTitle: { zh: '🏢 办公区', en: '🏢 Office' },
  officeHint: {
    zh: '拖拽旋转 · 滚轮缩放 · 点击工位进入会话',
    en: 'Drag to rotate · scroll to zoom · click a desk to open the session'
  },
  newShort: { zh: '+ 新建', en: '+ New' },
  officeEmpty: {
    zh: '办公区还没有工位。新建一个会话,看它入职开工。',
    en: 'No desks yet. Start a session and watch it clock in.'
  },
  activityWorking: { zh: '工作中', en: 'Working' },
  activityAwaiting: { zh: '待授权', en: 'Needs approval' },
  activityError: { zh: '异常', en: 'Error' },
  // 工具卡片
  updateTodoList: { zh: '更新任务清单', en: 'Update todo list' },
  toolDone: { zh: '完成', en: 'Done' },
  toolFailed: { zh: '失败', en: 'Failed' },
  toolPending: { zh: '等待', en: 'Pending' },
  errorOutput: { zh: '错误输出', en: 'Error output' },
  output: { zh: '输出', en: 'Output' },
  noOutput: { zh: '(无输出)', en: '(no output)' },
  showAllChars: { zh: '显示全部({n} 字符)', en: 'Show all ({n} chars)' },
  openWorkspaceDiff: { zh: '查看工作区 Diff', en: 'Open workspace diff' },
  workspaceDiff: { zh: '工作区 Diff', en: 'Workspace diff' },
  diffTruncated: { zh: '内容过大,已截断', en: 'Large diff truncated' },
  loadingDiff: { zh: '加载中…', en: 'Loading…' },
  refresh: { zh: '刷新', en: 'Refresh' },
  close: { zh: '关闭', en: 'Close' },
  noWorkspaceChanges: { zh: '当前工作区暂无改动', en: 'No workspace changes' },
  rewindPanelTitle: { zh: '回溯检查点', en: 'Rewind checkpoint' },
  rewindPanelSub: {
    zh: '先预览将恢复的代码/对话范围,确认后回到此轮之前。',
    en: 'Preview affected code/chat scope first, then restore to before this turn.'
  },
  rewindMode: { zh: '回溯模式', en: 'Rewind mode' },
  rewindCode: { zh: '代码', en: 'Code' },
  rewindChat: { zh: '对话', en: 'Chat' },
  rewindBoth: { zh: '两者', en: 'Both' },
  rewindComingSoon: {
    zh: '对话回溯将恢复 CaoGen 聊天转录',
    en: 'Chat rewind restores the CaoGen transcript'
  },
  rewindPreviewing: { zh: '正在预览回退范围…', en: 'Previewing rewind scope…' },
  rewindApplying: { zh: '回退中…', en: 'Rewinding…' },
  rewindApplyCode: { zh: '回退代码', en: 'Rewind code' },
  rewindApplyChat: { zh: '回退对话', en: 'Rewind chat' },
  rewindApplyBoth: { zh: '回退两者', en: 'Rewind both' },
  noCheckpointAvailable: {
    zh: '当前会话还没有可回退的检查点',
    en: 'No rewindable checkpoint in this session yet'
  },
  nothingToRewind: {
    zh: '此检查点没有可恢复的文件改动',
    en: 'No file changes can be restored at this checkpoint'
  },
  moreFiles: { zh: '另有 {n} 个文件…', en: '{n} more files…' },
  slashHint: { zh: '/ 命令 · ↑↓ 选择 · Enter 执行', en: '/ commands · ↑↓ choose · Enter run' },
  slashRewindHint: { zh: '打开最近检查点回溯面板', en: 'Open latest checkpoint rewind panel' },
  slashDiffHint: { zh: '打开当前工作区 Diff', en: 'Open current workspace diff' },
  slashBrowserHint: { zh: '打开内置浏览器并批注网页', en: 'Open built-in browser and annotate pages' },
  slashFilesHint: { zh: '打开内置文件编辑器', en: 'Open built-in file editor' },
  slashPluginsHint: { zh: '扫描 Skills / Agents / MCP 插件生态', en: 'Scan Skills / Agents / MCP plugins' },
  slashSubagentsHint: { zh: '派发最多 33 个真实子 Agent', en: 'Dispatch up to 33 real subagents' },
  slashRoutineHint: { zh: '打开本地 Routines 面板', en: 'Open local Routines panel' },
  slashMemoryHint: { zh: '打开当前项目记忆面板', en: 'Open project memory panel' },
  slashWorktreeHint: { zh: '查看隔离工作区,检查合并、导出 patch 或丢弃', en: 'Inspect isolated worktree, check merge, export patch, or discard' },
  slashTerminalHint: { zh: '打开当前会话目录的内置终端', en: 'Open built-in terminal for this session' },
  slashThemeHint: { zh: '切换白天/夜晚/系统主题', en: 'Cycle light/dark/system theme' },
  slashModelAutoHint: { zh: '切换为智能自动调度', en: 'Switch to smart auto routing' },
  slashModelHint: { zh: '切换模型为 {model}', en: 'Switch model to {model}' },
  commandPaletteTitle: { zh: '命令面板', en: 'Command Palette' },
  commandPalettePlaceholder: { zh: '搜索命令或会话…', en: 'Search commands or sessions…' },
  commandNoResults: { zh: '没有匹配结果', en: 'No matches' },
  commandNewSession: { zh: '新建会话', en: 'New Session' },
  commandSettings: { zh: '设置', en: 'Settings' },
  commandSearchSessions: { zh: '搜索会话', en: 'Search Sessions' },
  commandSectionCommand: { zh: '命令', en: 'Command' },
  commandSectionSession: { zh: '会话', en: 'Session' },
  commandSectionHistory: { zh: '历史', en: 'History' },
  commandSectionPlugin: { zh: '插件', en: 'Plugin' },
  worktreeShort: { zh: '⎇ Worktree', en: '⎇ Worktree' },
  worktreePanelTitle: { zh: '隔离工作区', en: 'Isolated worktree' },
  worktreeNotIsolated: { zh: '当前会话未使用 CaoGen 管理的 Git worktree。', en: 'This session is not using a CaoGen-managed Git worktree.' },
  worktreeBranch: { zh: '分支', en: 'Branch' },
  worktreeBase: { zh: '基点', en: 'Base' },
  worktreeChangedFiles: { zh: '改动', en: 'Changes' },
  worktreeState: { zh: '状态', en: 'State' },
  worktreeSource: { zh: '原目录', en: 'Source' },
  worktreePath: { zh: '隔离副本', en: 'Worktree' },
  worktreeOpenDiff: { zh: '查看 Diff', en: 'Open diff' },
  worktreeExportPatch: { zh: '导出 Patch', en: 'Export patch' },
  worktreeMergeTitle: { zh: '合并验收', en: 'Merge review' },
  worktreeMergeSubtitle: { zh: '检查隔离副本是否能干净应用到主工作区。', en: 'Check whether the isolated copy can apply cleanly to the main workspace.' },
  worktreeInspectMerge: { zh: '检查合并', en: 'Inspect merge' },
  worktreeInspectingMerge: { zh: '检查中…', en: 'Inspecting…' },
  worktreeApplyPatch: { zh: '应用到主工作区', en: 'Apply to main workspace' },
  worktreeApplyingPatch: { zh: '应用中…', en: 'Applying…' },
  worktreeCreatePr: { zh: '创建 PR', en: 'Create PR' },
  worktreeCreatingPr: { zh: '创建 PR 中…', en: 'Creating PR…' },
  worktreeMergeSummary: { zh: '摘要', en: 'Summary' },
  worktreeMergePatch: { zh: 'Patch 预览', en: 'Patch preview' },
  worktreeApplyCheck: { zh: '应用检查', en: 'Apply check' },
  worktreeEmptySummary: { zh: '尚未检查合并摘要。', en: 'No merge summary yet.' },
  worktreeEmptyPatch: { zh: '尚未生成 patch 预览。', en: 'No patch preview yet.' },
  worktreeEmptyApplyCheck: { zh: '尚未运行 apply-check。', en: 'No apply-check yet.' },
  worktreeApplyConfirm: {
    zh: '确定把这个隔离 worktree 的 patch 应用到主工作区吗? 应用前会再次做 git apply --check。',
    en: 'Apply this isolated worktree patch to the main workspace? CaoGen will run git apply --check again first.'
  },
  worktreeRemove: { zh: '丢弃隔离副本', en: 'Discard worktree' },
  worktreeRemoveConfirm: {
    zh: '确定丢弃这个隔离 worktree 并删除分支吗? 请先导出 patch 或确认不需要这些改动。',
    en: 'Discard this isolated worktree and delete its branch? Export a patch first if you need the changes.'
  },
  exportingPatch: { zh: '导出中…', en: 'Exporting…' },
  removingWorktree: { zh: '丢弃中…', en: 'Discarding…' },
  terminalShort: { zh: '❯ 终端', en: '❯ Terminal' },
  terminalPanelTitle: { zh: '内置终端', en: 'Terminal' },
  terminalNotStarted: { zh: '尚未启动', en: 'Not started' },
  terminalRestart: { zh: '启动/复用', en: 'Start/reuse' },
  terminalStop: { zh: '关闭终端', en: 'Close terminal' },
  terminalStarting: { zh: '终端启动中…', en: 'Starting terminal…' },
  terminalEmpty: { zh: '终端已就绪。输入命令后按 Enter。', en: 'Terminal ready. Type a command and press Enter.' },
  terminalExited: { zh: '终端已退出', en: 'Terminal exited' },
  terminalCommandPlaceholder: { zh: '输入命令,例如 npm test', en: 'Type a command, e.g. npm test' },
  terminalRun: { zh: '运行', en: 'Run' },
  preview: { zh: '预览', en: 'Preview' },
  previewPanelTitle: { zh: '产物预览', en: 'Preview' },
  previewLoading: { zh: '正在准备预览…', en: 'Preparing preview…' },
  previewEmpty: { zh: '从文件面板选择一个文件进行预览。', en: 'Choose a file from Files to preview.' },
  sendToAgent: { zh: '发给 Agent', en: 'Send to Agent' },
  browserShort: { zh: '◉ 浏览器', en: '◉ Browser' },
  browserPanelTitle: { zh: '内置浏览器', en: 'Browser' },
  browserUrlPlaceholder: { zh: '输入 URL 或域名', en: 'Enter URL or domain' },
  browserGo: { zh: '打开', en: 'Open' },
  browserStarting: { zh: '浏览器视图启动中…', en: 'Starting browser view…' },
  browserNotePlaceholder: { zh: '批注说明。先在网页中选中文本或区域附近内容。', en: 'Annotation note. Select text in the page first.' },
  browserCapture: { zh: '保存批注', en: 'Save annotation' },
  browserPickElement: { zh: '圈选元素', en: 'Pick element' },
  browserPicking: { zh: '圈选中…', en: 'Picking…' },
  browserPickHint: {
    zh: '在页面上悬停高亮并点击目标元素,自动截图保存批注(Esc 取消)',
    en: 'Hover to highlight, click to pick an element; screenshot saved automatically (Esc to cancel)'
  },
  browserObserve: { zh: '发观测给 Agent', en: 'Observe → Agent' },
  browserObserveHint: {
    zh: '把当前页面快照(文本摘要+控制台错误+网络失败)只读发给 Agent 复验',
    en: 'Send a read-only page snapshot (text, console errors, network failures) to the agent'
  },
  browserNoAnnotations: { zh: '暂无网页批注', en: 'No browser annotations yet' },
  filesShort: { zh: '▣ 文件', en: '▣ Files' },
  subagentsShort: { zh: '子 Agent', en: 'Subagents' },
  pluginsShort: { zh: '插件', en: 'Plugins' },
  routinesShort: { zh: 'Routines', en: 'Routines' },
  memoryShort: { zh: '记忆', en: 'Memory' },
  filePanelTitle: { zh: '文件编辑器', en: 'File editor' },
  filesTruncated: { zh: '文件过多,已截断', en: 'File list truncated' },
  fileSearchPlaceholder: { zh: '搜索文件…', en: 'Search files…' },
  filesEmpty: { zh: '没有匹配文件', en: 'No matching files' },
  fileNoSelection: { zh: '未选择文件', en: 'No file selected' },
  fileLoading: { zh: '正在打开文件…', en: 'Opening file…' },
  filePickHint: { zh: '从左侧选择一个文本文件。保存会写入当前会话目录或隔离 worktree。', en: 'Pick a text file on the left. Saves write to this session cwd or isolated worktree.' },
  // 设置中心
  settingsTitle: { zh: '设置', en: 'Settings' },
  tabGeneral: { zh: '通用', en: 'General' },
  tabPermissions: { zh: '权限', en: 'Permissions' },
  tabPersona: { zh: '人设', en: 'Persona' },
  tabOffice: { zh: '办公区 / 宠物', en: 'Office / Pet' },
  tabProviders: { zh: '厂商', en: 'Providers' },
  tabPlugins: { zh: '插件 / 技能', en: 'Plugins / Skills' },
  tabMigrate: { zh: '迁移', en: 'Migrate' },
  migrateTitle: { zh: '从其他 Agent 一键搬家', en: 'Migrate from other agents' },
  migrateHint: {
    zh: '扫描 Cursor / Codex / Windsurf / Cline / Aider / Copilot / Gemini 等的规则与 MCP 配置。规则注入项目 CLAUDE.md(带来源标注,原文件不动,已有 CLAUDE.md 先备份);MCP 合并进 .mcp.json(同名跳过)。',
    en: 'Scan rules & MCP configs from Cursor / Codex / Windsurf / Cline / Aider / Copilot / Gemini. Rules are injected into the project CLAUDE.md (source-tagged, originals untouched, existing CLAUDE.md backed up); MCP merges into .mcp.json (name conflicts skipped).'
  },
  migrateScan: { zh: '扫描', en: 'Scan' },
  migrateScanning: { zh: '扫描中…', en: 'Scanning…' },
  migrateClaudeNative: {
    zh: '检测到 Claude Code 原生资产(CLAUDE.md / .claude),CaoGen 直接继承,无需导入',
    en: 'Claude Code native assets detected (CLAUDE.md / .claude) — inherited directly, no import needed'
  },
  migrateNothing: {
    zh: '未检测到其他 Agent 的配置资产。',
    en: 'No assets from other agents detected.'
  },
  migrateKindRules: { zh: '规则', en: 'rules' },
  migrateKindConfig: { zh: '配置', en: 'config' },
  migrateImport: { zh: '导入所选({n} 项)', en: 'Import selected ({n})' },
  migrateImporting: { zh: '导入中…', en: 'Importing…' },
  language: { zh: '界面语言', en: 'Language' },
  theme: { zh: '主题', en: 'Theme' },
  themeLight: { zh: '白天(主白副黑)', en: 'Light' },
  themeDark: { zh: '夜晚(主黑副白)', en: 'Dark' },
  themeSystem: { zh: '跟随系统', en: 'System' },
  defaultProvider: { zh: '默认 Provider', en: 'Default Provider' },
  defaultModel: { zh: '默认模型', en: 'Default Model' },
  schedulerStrategy: { zh: '自动调度策略', en: 'Scheduler Strategy' },
  failoverEnabled: { zh: '厂商故障自动切换(任务不中断)', en: 'Auto failover across providers' },
  failoverHint: {
    zh: '当前厂商余额不足/限流/宕机时,自动切到健康厂商重试本轮任务。',
    en: 'On credit/rate-limit/outage errors, retry the turn on a healthy provider.'
  },
  notificationsEnabled: { zh: '桌面通知', en: 'Desktop notifications' },
  notificationsHint: {
    zh: '任务完成、等待权限、任务失败时弹系统通知;关闭后全部静默。',
    en: 'Notify on task completion, permission prompts, and failures; off = silent.'
  },
  preventDisplaySleep: { zh: '运行时防止显示器休眠', en: 'Prevent display sleep while running' },
  preventDisplaySleepHint: {
    zh: '会话运行期间阻止屏幕休眠,长任务不中断;关闭后遵循系统电源设置。',
    en: 'Keep the display awake while a session runs; off = follow system power settings.'
  },
  defaultPermMode: { zh: '默认权限模式', en: 'Default Permission Mode' },
  allowedTools: { zh: '工具白名单(每行一个,空=不限制)', en: 'Allowed tools (one per line, empty = all)' },
  disallowedTools: { zh: '工具黑名单(每行一个)', en: 'Disallowed tools (one per line)' },
  personaLabel: { zh: '自定义人设 / 系统提示词追加', en: 'Custom persona / system prompt append' },
  personaHint: {
    zh: '追加到内置提示词之后,用于设定语气、约束、专长等。',
    en: 'Appended after the built-in prompt — set tone, constraints, expertise.'
  },
  personaPlaceholder: {
    zh: '例如:你是一位严谨的 Rust 专家,回答简洁,总用中文。',
    en: 'e.g. You are a rigorous Rust expert; be concise; always reply in English.'
  },
  officeShowBadges: { zh: '显示桌上厂商工牌', en: 'Show vendor badge on desk' },
  officeLiveliness: { zh: '小人活跃度', en: 'Avatar liveliness' },
  officeCatEars: { zh: '宠物化:给小人加猫耳 🐱', en: 'Pet mode: cat ears 🐱' },
  pluginsInfo: {
    zh: '技能 / 插件 / MCP 服务器 / 子代理会自动从 ~/.claude 与项目 .claude 继承。把开源或自定义包放到那里即可被会话发现调用。',
    en: 'Skills / plugins / MCP servers / subagents are inherited from ~/.claude and project .claude. Drop open-source or custom packages there to use them.'
  },
  addProvider: { zh: '+ 添加', en: '+ Add' },
  officialAnthropic: { zh: '官方 Anthropic', en: 'Official Anthropic' },
  providerEmpty: {
    zh: '尚未配置额外 Provider,当前使用官方 Anthropic 登录。',
    en: 'No extra providers yet — using the official Anthropic login.'
  },
  healthOkTip: { zh: '健康 · 成功 {s} 失败 {f}', en: 'Healthy · {s} succeeded, {f} failed' },
  healthBadTip: { zh: '异常 · 连续失败 {n}', en: 'Unhealthy · {n} consecutive failures' },
  officialEndpoint: { zh: '官方端点', en: 'Official endpoint' },
  modelsCount: { zh: '{n} 个模型', en: '{n} models' },
  // Provider 编辑器
  providerEditTitle: { zh: '编辑 Provider', en: 'Edit Provider' },
  providerAddTitle: { zh: '添加 Provider', en: 'Add Provider' },
  quickTemplate: { zh: '快速模板', en: 'Quick templates' },
  pickTemplate: { zh: '选择一个模板…', en: 'Pick a template…' },
  gatewayNote1: {
    zh: 'OpenAI 可选 Responses API 引擎直连;Claude 引擎接入 ',
    en: 'OpenAI can connect directly through the Responses API engine. With the Claude engine, '
  },
  gatewayNoteBold: { zh: 'OpenAI / Gemini / 国产模型', en: 'OpenAI / Gemini / other vendors' },
  gatewayNote2: {
    zh: ' 仍需经 Anthropic 兼容网关(one-api、new-api、LiteLLM 等)转译。',
    en: ' still needs an Anthropic-compatible gateway (one-api, new-api, LiteLLM, …).'
  },
  nameLabel: { zh: '名称', en: 'Name' },
  namePlaceholder: { zh: '例如:公司网关 / OpenRouter', en: 'e.g. Company gateway / OpenRouter' },
  baseUrlLabel: { zh: 'Base URL(按所选引擎)', en: 'Base URL (matches selected engine)' },
  apiKeyLabel: { zh: 'API 密钥', en: 'API key' },
  savedKeepEmpty: { zh: '(已保存,留空不改)', en: '(saved — leave blank to keep)' },
  tokenPlaceholderSaved: { zh: '••••••••(不改动请留空)', en: '•••••••• (leave blank to keep)' },
  modelListLabel: { zh: '模型列表(每行一个)', en: 'Models (one per line)' },
  fetchModelsTitle: {
    zh: '用上面的 Base URL + 密钥调用 /v1/models 自动获取',
    en: 'Fetch from /v1/models using the Base URL + key above'
  },
  fetching: { zh: '获取中…', en: 'Fetching…' },
  fetchWithKey: { zh: '⤓ 用密钥获取', en: '⤓ Fetch with key' },
  fetchedModels: { zh: '已获取 {n} 个模型', en: 'Fetched {n} models' },
  customHeadersLabel: { zh: '自定义请求头', en: 'Custom headers' },
  customHeadersHint: { zh: '(可选,每行 Name: value)', en: '(optional, one "Name: value" per line)' },
  openaiProtocolLabel: { zh: 'OpenAI 引擎协议', en: 'OpenAI engine protocol' },
  openaiProtocolHint: {
    zh: '(仅 OpenAI 引擎会话生效;Claude 引擎忽略)',
    en: '(only used by OpenAI-engine sessions; ignored by the Claude engine)'
  },
  openaiProtocolResponses: {
    zh: 'Responses(OpenAI 官方)',
    en: 'Responses (OpenAI official)'
  },
  openaiProtocolChat: {
    zh: 'Chat Completions(DeepSeek/Qwen/网关/自部署通用)',
    en: 'Chat Completions (DeepSeek/Qwen/gateways/self-hosted)'
  },
  noteOptional: { zh: '备注(可选)', en: 'Note (optional)' },
  errNameRequired: { zh: '请填写名称', en: 'Please enter a name' },
  saving: { zh: '保存中…', en: 'Saving…' }
}

/** 可选参数:{name} 占位符替换,值为 string | number */
export type TParams = Record<string, string | number>

export function translate(lang: AppLanguage, key: string, params?: TParams): string {
  const entry = DICT[key]
  const raw = entry ? entry[lang] ?? entry.zh ?? key : key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

/** 组件里用:const t = useT(); t('save') 或 t('fetchedModels', { n: 3 }) */
export function useT(): (key: string, params?: TParams) => string {
  const lang = useStore((s) => s.settings.language)
  return (key: string, params?: TParams) => translate(lang, key, params)
}
