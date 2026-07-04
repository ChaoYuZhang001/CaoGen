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
  noSessions: { zh: '暂无会话', en: 'No sessions' },
  cancel: { zh: '取消', en: 'Cancel' },
  save: { zh: '保存', en: 'Save' },
  rename: { zh: '重命名', en: 'Rename' },
  delete: { zh: '删除', en: 'Delete' },
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
  // 设置中心
  settingsTitle: { zh: '设置', en: 'Settings' },
  tabGeneral: { zh: '通用', en: 'General' },
  tabPermissions: { zh: '权限', en: 'Permissions' },
  tabPersona: { zh: '人设', en: 'Persona' },
  tabOffice: { zh: '办公区 / 宠物', en: 'Office / Pet' },
  tabProviders: { zh: '厂商', en: 'Providers' },
  tabPlugins: { zh: '插件 / 技能', en: 'Plugins / Skills' },
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
    zh: '底层引擎使用 Anthropic Messages API 协议。接入 ',
    en: 'The engine speaks the Anthropic Messages API. To use '
  },
  gatewayNoteBold: { zh: 'OpenAI / Gemini / 国产模型', en: 'OpenAI / Gemini / other vendors' },
  gatewayNote2: {
    zh: ' 需经 Anthropic 兼容网关(one-api、new-api、LiteLLM 等)转译,填入网关地址即可。',
    en: ', route through an Anthropic-compatible gateway (one-api, new-api, LiteLLM, …) and enter its URL here.'
  },
  nameLabel: { zh: '名称', en: 'Name' },
  namePlaceholder: { zh: '例如:公司网关 / OpenRouter', en: 'e.g. Company gateway / OpenRouter' },
  baseUrlLabel: { zh: 'Base URL(Anthropic 兼容端点)', en: 'Base URL (Anthropic-compatible endpoint)' },
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
