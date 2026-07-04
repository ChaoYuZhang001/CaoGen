/**
 * 厂商 → 外观皮肤映射,供 3D 办公区小人/工牌主题化。
 *
 * 纯逻辑,无 JSX、无 three 依赖:只返回颜色字符串与文字标识,渲染层自行消费。
 * 名称是用户自定义自由文本,按关键词大小写不敏感匹配;命中不了给中性灰皮肤。
 * 说明:仅用品牌"色 + 单字/emoji 徽记",不内置任何厂商商标图形,规避商标风险。
 *
 * 配色遵循办公区规范(主黑副白、克制):
 *  - bodyColor 为小人身体的实色(非发光),饱和度适中避免刺眼;
 *  - accent 为发光/强调色(工牌 emissive、光环等),偏亮以配合 Bloom。
 */

export interface VendorSkin {
  /** 小人身体实色(meshStandardMaterial.color,非发光) */
  bodyColor: string
  /** 发光/强调色(emissive 用,配合 Bloom;渲染侧记得 toneMapped={false}) */
  accent: string
  /** 徽记:单字或 emoji,用于工牌/头顶标识 */
  emblem: string
  /** 人类可读厂商标签 */
  label: string
}

/**
 * 已知厂商皮肤表(named 导出,便于外部枚举/测试)。
 * emblem 用官方吉祥物/意象 emoji 提升辨识度(仅意象符号,非商标图形,规避风险):
 * DeepSeek=鲸鱼🐳、OpenAI=螺🌀、Anthropic=火花✳️、Google=宝石💎、Qwen=云☁️、
 * Kimi=月🌙、智谱=闪电⚡、Grok=🛸、Meta=♾️、Mistral=风🌬️、默认=🤖。
 */
export const VENDOR_SKINS: Record<string, VendorSkin> = {
  anthropic: { bodyColor: '#d97757', accent: '#ff9d73', emblem: '✳️', label: 'Anthropic' },
  openai: { bodyColor: '#1f6f5c', accent: '#3fd0a8', emblem: '🌀', label: 'OpenAI' },
  google: { bodyColor: '#3b6fe0', accent: '#6ea8ff', emblem: '💎', label: 'Google' },
  qwen: { bodyColor: '#6a4fd0', accent: '#a98fff', emblem: '☁️', label: 'Qwen' },
  deepseek: { bodyColor: '#4d6bfe', accent: '#7d8dff', emblem: '🐳', label: 'DeepSeek' },
  kimi: { bodyColor: '#16b8a6', accent: '#5fe6d4', emblem: '🌙', label: 'Kimi' },
  zhipu: { bodyColor: '#3859ff', accent: '#7d95ff', emblem: '⚡', label: '智谱 GLM' },
  grok: { bodyColor: '#4a4f57', accent: '#b0b6c0', emblem: '🛸', label: 'Grok' },
  meta: { bodyColor: '#0866ff', accent: '#5b9dff', emblem: '♾️', label: 'Meta' },
  mistral: { bodyColor: '#fa5310', accent: '#ff8a52', emblem: '🌬️', label: 'Mistral' },
  default: { bodyColor: '#5b6472', accent: '#8fe9ff', emblem: '🤖', label: 'Agent' }
}

/** 名称关键词 → 皮肤键;顺序即优先级 */
const RULES: Array<{ match: RegExp; key: keyof typeof VENDOR_SKINS }> = [
  { match: /openai|gpt|o1|o3|o4|chatgpt/i, key: 'openai' },
  { match: /anthropic|claude|opus|sonnet|haiku|官方|official/i, key: 'anthropic' },
  { match: /gemini|google|谷歌|palm|bard/i, key: 'google' },
  { match: /deepseek|深度求索/i, key: 'deepseek' },
  { match: /moonshot|kimi|月之暗面/i, key: 'kimi' },
  { match: /zhipu|glm|智谱|bigmodel/i, key: 'zhipu' },
  { match: /qwen|通义|千问|alibaba|阿里|bailian|百炼/i, key: 'qwen' },
  { match: /grok|xai/i, key: 'grok' },
  { match: /llama|meta/i, key: 'meta' },
  { match: /mistral/i, key: 'mistral' }
]

/** 按厂商名称返回皮肤键(deepseek/openai…),供 3D 吉祥物分派;空=官方,未命中=default */
export function vendorKeyFor(name?: string): string {
  const raw = (name ?? '').trim()
  if (!raw) return 'anthropic'
  for (const { match, key } of RULES) {
    if (match.test(raw)) return key
  }
  return 'default'
}

/**
 * 按厂商名称返回外观皮肤。
 * @param name Provider 名称(自由文本);为空/未命中已知厂商时:
 *   - 空:视为官方 Anthropic;
 *   - 非空未命中:中性灰皮肤 + 名称首字(1~2 字)作为徽记。
 */
export function vendorSkin(name?: string): VendorSkin {
  const raw = (name ?? '').trim()
  if (!raw) return VENDOR_SKINS.anthropic // 空 = 官方
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
