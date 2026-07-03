/**
 * 按 Provider 名称推断厂商品牌色与短标识,用于 3D 办公区小人主题化。
 * 名称是用户自定义自由文本,按关键词大小写不敏感匹配;命中不了给中性色。
 * 说明:仅用品牌"色 + 首标",不内置任何厂商商标图形,规避商标风险。
 */
export interface Brand {
  color: string
  label: string
}

const RULES: Array<{ match: RegExp; brand: Brand }> = [
  { match: /openai|gpt|o1|o3/i, brand: { color: '#10a37f', label: 'AI' } },
  { match: /anthropic|claude|opus|sonnet|haiku|官方|official/i, brand: { color: '#d97757', label: 'A' } },
  { match: /gemini|google|谷歌/i, brand: { color: '#4285f4', label: 'G' } },
  { match: /deepseek|深度求索/i, brand: { color: '#4d6bfe', label: 'DS' } },
  { match: /qwen|通义|千问|alibaba|阿里/i, brand: { color: '#615ced', label: 'Q' } },
  { match: /moonshot|kimi|月之暗面/i, brand: { color: '#16b8a6', label: 'K' } },
  { match: /mistral/i, brand: { color: '#fa5310', label: 'M' } },
  { match: /grok|xai/i, brand: { color: '#8a8f98', label: 'X' } },
  { match: /llama|meta/i, brand: { color: '#0866ff', label: 'L' } }
]

const DEFAULT_BRAND: Brand = { color: '#7a8393', label: '·' }

/** providerName 为空表示官方 Anthropic */
export function brandFor(providerName: string | undefined): Brand {
  const name = (providerName ?? '').trim()
  if (!name) return { color: '#d97757', label: 'A' } // 官方
  for (const { match, brand } of RULES) if (match.test(name)) return brand
  // 未命中已知厂商:用名称首字母 + 中性色
  const first = name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase()
  return { color: DEFAULT_BRAND.color, label: first || DEFAULT_BRAND.label }
}
