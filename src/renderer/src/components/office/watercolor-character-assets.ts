import {
  watercolorCharacterAssetFilename,
  type WatercolorCharacterRole,
  type WatercolorCharacterState
} from '../../../../shared/watercolor-character'

const IMPORTED_WATERCOLOR_ASSETS = import.meta.glob<string>(
  '../../assets/watercolor-characters/*.png',
  { eager: true, import: 'default', query: '?url' }
)

// Add a filename only after alpha-channel, edge-fringe, role, and state QC pass.
export const VERIFIED_WATERCOLOR_CHARACTER_FILES: readonly string[] = [
  'role-researcher-state-idle-v01.png',
  'role-researcher-state-thinking-v01.png',
  'role-researcher-state-tool-running-v01.png',
  'role-researcher-state-awaiting-approval-v01.png',
  'role-researcher-state-blocked-v01.png',
  'role-researcher-state-repairing-v01.png',
  'role-researcher-state-delivering-v01.png',
  'role-planner-state-idle-v01.png',
  'role-planner-state-thinking-v01.png',
  'role-planner-state-tool-running-v01.png',
  'role-planner-state-awaiting-approval-v01.png',
  'role-planner-state-blocked-v01.png',
  'role-planner-state-repairing-v01.png',
  'role-planner-state-delivering-v01.png',
  'role-writer-state-idle-v01.png',
  'role-writer-state-thinking-v01.png',
  'role-writer-state-tool-running-v01.png',
  'role-writer-state-awaiting-approval-v01.png',
  'role-writer-state-blocked-v01.png',
  'role-writer-state-repairing-v01.png',
  'role-writer-state-delivering-v01.png',
  'role-designer-state-idle-v01.png',
  'role-designer-state-thinking-v01.png',
  'role-designer-state-tool-running-v01.png',
  'role-designer-state-awaiting-approval-v01.png',
  'role-designer-state-blocked-v01.png',
  'role-designer-state-repairing-v01.png',
  'role-designer-state-delivering-v01.png',
  'role-developer-state-idle-v01.png',
  'role-developer-state-thinking-v01.png',
  'role-developer-state-tool-running-v01.png',
  'role-developer-state-awaiting-approval-v01.png',
  'role-developer-state-blocked-v01.png',
  'role-developer-state-repairing-v01.png',
  'role-developer-state-delivering-v01.png',
  'role-review-test-state-idle-v01.png',
  'role-review-test-state-thinking-v01.png',
  'role-review-test-state-tool-running-v01.png',
  'role-review-test-state-awaiting-approval-v01.png',
  'role-review-test-state-blocked-v01.png',
  'role-review-test-state-repairing-v01.png',
  'role-review-test-state-delivering-v01.png',
  'role-operations-state-idle-v01.png',
  'role-operations-state-thinking-v01.png',
  'role-operations-state-tool-running-v01.png',
  'role-operations-state-awaiting-approval-v01.png',
  'role-operations-state-blocked-v01.png',
  'role-operations-state-repairing-v01.png',
  'role-operations-state-delivering-v01.png',
]

const VERIFIED_FILE_SET = new Set(VERIFIED_WATERCOLOR_CHARACTER_FILES)
const ASSET_URL_BY_FILENAME = new Map(
  Object.entries(IMPORTED_WATERCOLOR_ASSETS)
    .map(([path, url]) => [path.split('/').at(-1) ?? '', url] as const)
    .filter(([filename]) => VERIFIED_FILE_SET.has(filename))
)

export function watercolorCharacterAssetUrl(
  role: WatercolorCharacterRole,
  state: WatercolorCharacterState
): string | undefined {
  return ASSET_URL_BY_FILENAME.get(watercolorCharacterAssetFilename(role, state))
    ?? ASSET_URL_BY_FILENAME.get(watercolorCharacterAssetFilename(role, 'idle'))
    ?? ASSET_URL_BY_FILENAME.get(watercolorCharacterAssetFilename('researcher', 'idle'))
}

export function hasWatercolorCharacterAsset(
  role: WatercolorCharacterRole | undefined,
  state: WatercolorCharacterState | undefined
): role is WatercolorCharacterRole {
  return Boolean(role && state && watercolorCharacterAssetUrl(role, state))
}
