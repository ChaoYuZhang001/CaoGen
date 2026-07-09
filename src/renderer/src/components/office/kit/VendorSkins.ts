/**
 * 厂商 → 外观皮肤映射,供控制室工位/工牌主题化。
 *
 * 纯逻辑,无 JSX、无 three 依赖:只返回颜色字符串与文字标识,渲染层自行消费。
 * 名称是用户自定义自由文本,按关键词大小写不敏感匹配;命中不了给中性灰皮肤。
 * 说明:仅用品牌线索映射出的抽象配色 + 短代码徽记,不内置任何厂商商标图形。
 *
 * 配色遵循办公区规范(主黑副白、克制):
 *  - bodyColor 为机器人外壳主色(非发光),饱和度适中避免刺眼;
 *  - accent 为 visor、胸牌、状态条等强调色。
 */

export interface VendorSkin {
  /** 机器人外壳主色(meshStandardMaterial.color,非发光) */
  bodyColor: string
  /** 机器人护甲/工装面板色,用于区别不同 provider/model 的"衣服" */
  shellColor: string
  /** 发光/强调色(emissive 用,配合 Bloom;渲染侧记得 toneMapped={false}) */
  accent: string
  /** 徽记:短代码或首字母,用于工牌/头顶标识;不是厂商 logo */
  emblem: string
  /** 人类可读厂商标签 */
  label: string
}

/**
 * 已知厂商皮肤表(named 导出,便于外部枚举/测试)。
 * emblem 使用抽象短代码,不使用官方 logo、吉祥物或商标图形。
 */
export const VENDOR_SKINS: Record<string, VendorSkin> = {
  anthropic: { bodyColor: '#a96b54', shellColor: '#e8c6b4', accent: '#ff9d73', emblem: 'AN', label: 'Anthropic' },
  openai: { bodyColor: '#1f6f5c', shellColor: '#c7ece2', accent: '#3fd0a8', emblem: 'OA', label: 'OpenAI' },
  google: { bodyColor: '#3b6fe0', shellColor: '#d2def8', accent: '#6ea8ff', emblem: 'GO', label: 'Google' },
  qwen: { bodyColor: '#6a4fd0', shellColor: '#ded7ff', accent: '#a98fff', emblem: 'QW', label: 'Qwen' },
  deepseek: { bodyColor: '#4d6bfe', shellColor: '#d7ddff', accent: '#7d8dff', emblem: 'DS', label: 'DeepSeek' },
  doubao: { bodyColor: '#2865a8', shellColor: '#d6e9ff', accent: '#5aa8ff', emblem: 'DB', label: 'Doubao' },
  baidu: { bodyColor: '#2f55c8', shellColor: '#d8e2ff', accent: '#4f7dff', emblem: 'BD', label: 'ERNIE' },
  kimi: { bodyColor: '#16b8a6', shellColor: '#caf5ee', accent: '#5fe6d4', emblem: 'KM', label: 'Kimi' },
  zhipu: { bodyColor: '#3859ff', shellColor: '#d3dcff', accent: '#7d95ff', emblem: 'GL', label: '智谱 GLM' },
  minimax: { bodyColor: '#b84272', shellColor: '#ffd8e8', accent: '#ff7db0', emblem: 'MM', label: 'MiniMax' },
  spark: { bodyColor: '#b54840', shellColor: '#ffd8d4', accent: '#ff6b5f', emblem: 'XF', label: '讯飞星火' },
  hunyuan: { bodyColor: '#24769a', shellColor: '#d2f2ff', accent: '#48d1ff', emblem: 'HY', label: '腾讯混元' },
  yi: { bodyColor: '#628c42', shellColor: '#e2f7d5', accent: '#9de36b', emblem: 'YI', label: '零一万物' },
  baichuan: { bodyColor: '#3183a6', shellColor: '#d5f1ff', accent: '#6fd6ff', emblem: 'BC', label: '百川' },
  sensenova: { bodyColor: '#9b7527', shellColor: '#fff0c8', accent: '#ffcf5a', emblem: 'SN', label: '商汤日日新' },
  stepfun: { bodyColor: '#7353bd', shellColor: '#e5d9ff', accent: '#b18cff', emblem: 'SF', label: '阶跃星辰' },
  grok: { bodyColor: '#4a4f57', shellColor: '#d7dbe0', accent: '#b0b6c0', emblem: 'GX', label: 'Grok' },
  meta: { bodyColor: '#0866ff', shellColor: '#d2e5ff', accent: '#5b9dff', emblem: 'MT', label: 'Meta' },
  mistral: { bodyColor: '#b95c25', shellColor: '#ffd8be', accent: '#ff8a52', emblem: 'MS', label: 'Mistral' },
  default: { bodyColor: '#5b6472', shellColor: '#d6e0ea', accent: '#8fe9ff', emblem: 'AG', label: 'Agent' }
}

/** 名称关键词 → 皮肤键;顺序即优先级 */
const RULES: Array<{ match: RegExp; key: keyof typeof VENDOR_SKINS }> = [
  { match: /openai|gpt|o1|o3|o4|chatgpt/i, key: 'openai' },
  { match: /anthropic|claude|opus|sonnet|haiku|官方|official/i, key: 'anthropic' },
  { match: /gemini|google|谷歌|palm|bard/i, key: 'google' },
  { match: /deepseek|深度求索/i, key: 'deepseek' },
  { match: /doubao|豆包|bytedance|byte|volcengine|火山|方舟|ark/i, key: 'doubao' },
  { match: /baidu|ernie|文心|千帆|qianfan/i, key: 'baidu' },
  { match: /moonshot|kimi|月之暗面/i, key: 'kimi' },
  { match: /zhipu|glm|智谱|bigmodel/i, key: 'zhipu' },
  { match: /qwen|通义|千问|alibaba|阿里|bailian|百炼/i, key: 'qwen' },
  { match: /minimax|abab/i, key: 'minimax' },
  { match: /iflytek|xunfei|spark|星火|讯飞/i, key: 'spark' },
  { match: /hunyuan|混元|tencent|腾讯/i, key: 'hunyuan' },
  { match: /01\.?ai|零一|yi-|yi_|yi\b|零一万物/i, key: 'yi' },
  { match: /baichuan|百川/i, key: 'baichuan' },
  { match: /sensenova|sensechat|sensetime|商汤|日日新/i, key: 'sensenova' },
  { match: /stepfun|step-|阶跃|step\b/i, key: 'stepfun' },
  { match: /grok|xai/i, key: 'grok' },
  { match: /llama|meta/i, key: 'meta' },
  { match: /mistral/i, key: 'mistral' }
]

/** 按厂商名称返回皮肤键(deepseek/openai…),供 3D 吉祥物分派;空/未命中=default */
export function vendorKeyFor(name?: string): string {
  const raw = (name ?? '').trim()
  if (!raw) return 'default'
  for (const { match, key } of RULES) {
    if (match.test(raw)) return key
  }
  return 'default'
}

/**
 * 按厂商名称返回外观皮肤。
 * @param name Provider 名称(自由文本);为空/未命中已知厂商时使用中性灰皮肤。
 */
export function vendorSkin(name?: string): VendorSkin {
  const raw = (name ?? '').trim()
  if (!raw) return VENDOR_SKINS.default
  for (const { match, key } of RULES) {
    if (match.test(raw)) return VENDOR_SKINS[key]
  }
  // 未命中:中性皮肤,徽记取名称首字母/首字(去符号,最多 2 字)
  const first = raw.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase()
  return {
    ...VENDOR_SKINS.default,
    emblem: first || VENDOR_SKINS.default.emblem,
    label: raw
  }
}
