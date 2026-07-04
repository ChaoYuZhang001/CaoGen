import { useStore } from './store'
import type { AppLanguage } from '../../shared/types'

/**
 * 轻量 i18n:按当前语言查字典,缺失回退中文再回退 key。
 * 当前覆盖设置中心 + 主要导航 chrome;其余文案逐步接入。
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
  // 欢迎页
  welcomeSub: { zh: '多会话并行的桌面 AI 编码 Agent', en: 'Parallel multi-session desktop AI coding agent' },
  welcomeCta: { zh: '选择项目目录,开始工作', en: 'Pick a project folder to start' },
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
  addProvider: { zh: '+ 添加', en: '+ Add' }
}

export function translate(lang: AppLanguage, key: string): string {
  const entry = DICT[key]
  if (!entry) return key
  return entry[lang] ?? entry.zh ?? key
}

/** 组件里用:const t = useT(); t('save') */
export function useT(): (key: string) => string {
  const lang = useStore((s) => s.settings.language)
  return (key: string) => translate(lang, key)
}
