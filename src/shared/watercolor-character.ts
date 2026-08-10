import type { DigitalWorker, RoleTemplate } from './digital-worker-types'

export const WATERCOLOR_CHARACTER_ROLES = [
  'researcher',
  'planner',
  'writer',
  'designer',
  'developer',
  'review-test',
  'operations'
] as const

export const WATERCOLOR_CHARACTER_STATES = [
  'idle',
  'thinking',
  'tool-running',
  'awaiting-approval',
  'blocked',
  'repairing',
  'delivering'
] as const

export type WatercolorCharacterRole = (typeof WATERCOLOR_CHARACTER_ROLES)[number]
export type WatercolorCharacterState = (typeof WATERCOLOR_CHARACTER_STATES)[number]
export type WatercolorRoleSource = 'avatar-profile' | 'role-template' | 'stable-fallback'

export interface WatercolorRoleResolution {
  role: WatercolorCharacterRole
  source: WatercolorRoleSource
}

const ROLE_ALIASES: Readonly<Record<string, WatercolorCharacterRole>> = {
  research: 'researcher',
  researcher: 'researcher',
  planning: 'planner',
  planner: 'planner',
  writing: 'writer',
  writer: 'writer',
  design: 'designer',
  designer: 'designer',
  development: 'developer',
  developer: 'developer',
  engineering: 'developer',
  engineer: 'developer',
  qa: 'review-test',
  review: 'review-test',
  reviewer: 'review-test',
  test: 'review-test',
  tester: 'review-test',
  'review-test': 'review-test',
  operation: 'operations',
  operations: 'operations',
  ops: 'operations'
}

const ROLE_PATTERNS: ReadonlyArray<readonly [WatercolorCharacterRole, RegExp]> = [
  ['review-test', /(?:\bqa\b|quality|review|test|审查|评审|测试|质检)/iu],
  ['operations', /(?:\bops\b|operation|运营|运维)/iu],
  ['designer', /(?:design|ux|ui|设计)/iu],
  ['developer', /(?:develop|engineer|coding|program|开发|工程|编程)/iu],
  ['writer', /(?:write|writer|editor|content|写作|文案|编辑)/iu],
  ['planner', /(?:plan|planner|product manager|project manager|策划|规划|产品经理|项目经理)/iu],
  ['researcher', /(?:research|search|analyst|调研|研究|检索|分析)/iu]
]

export function resolveWatercolorRole(
  worker: Pick<DigitalWorker, 'id' | 'avatarProfile'>,
  roleTemplate?: Pick<RoleTemplate, 'name' | 'purpose'>
): WatercolorRoleResolution {
  const profileRole = explicitRole(worker.avatarProfile.watercolorRole)
    ?? explicitRole(worker.avatarProfile.watercolourRole)
    ?? explicitRole(worker.avatarProfile.characterRole)
  if (profileRole) return { role: profileRole, source: 'avatar-profile' }

  const semanticRole = roleTemplate ? semanticRoleOf(`${roleTemplate.name} ${roleTemplate.purpose}`) : undefined
  if (semanticRole) return { role: semanticRole, source: 'role-template' }

  return {
    role: WATERCOLOR_CHARACTER_ROLES[stableStringHash(worker.id) % WATERCOLOR_CHARACTER_ROLES.length],
    source: 'stable-fallback'
  }
}

export function watercolorCharacterAssetFilename(
  role: WatercolorCharacterRole,
  state: WatercolorCharacterState
): string {
  return `role-${role}-state-${state}-v01.png`
}

function explicitRole(value: unknown): WatercolorCharacterRole | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replace(/[\s_/]+/gu, '-')
  return ROLE_ALIASES[normalized]
}

function semanticRoleOf(value: string): WatercolorCharacterRole | undefined {
  return ROLE_PATTERNS.find(([, pattern]) => pattern.test(value))?.[0]
}

function stableStringHash(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
