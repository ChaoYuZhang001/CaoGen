#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8')
const roles = ['researcher', 'planner', 'writer', 'designer', 'developer', 'review-test', 'operations']
const states = ['idle', 'thinking', 'tool-running', 'awaiting-approval', 'blocked', 'repairing', 'delivering']
const expectedAssets = roles.flatMap((role) => states.map((state) => `role-${role}-state-${state}-v01.png`))

const office = read('src/renderer/src/components/office/OfficeView.tsx')
const workstation = read('src/renderer/src/components/office/kit/WorkstationPro.tsx')
const walkers = read('src/renderer/src/components/office/kit/AgentWalkers.tsx')
const rig = read('src/renderer/src/components/office/kit/WatercolorCharacterRig.tsx')
const registry = read('src/renderer/src/components/office/watercolor-character-assets.ts')
const shared = read('src/shared/watercolor-character.ts')
const assetDir = path.join(root, 'src/renderer/src/assets/watercolor-characters')

assert(existsSync(assetDir), 'watercolor runtime asset directory is missing')
const actualAssets = readdirSync(assetDir).filter((name) => name.endsWith('.png')).sort()
assert.deepEqual(actualAssets, [...expectedAssets].sort(), 'runtime must contain exactly the registered 7x7 watercolor asset matrix')

for (const role of roles) assert(shared.includes(`'${role}'`), `shared watercolor role is missing: ${role}`)
for (const state of states) assert(shared.includes(`'${state}'`), `shared watercolor state is missing: ${state}`)
for (const filename of expectedAssets) assert(registry.includes(`'${filename}'`), `runtime asset is not registered: ${filename}`)

assert(office.includes("import WatercolorCharacterRig from './kit/WatercolorCharacterRig'"), 'Office boot scene must use the watercolor rig')
assert(office.includes('data-office-watercolor-characters={visibleIds.length}'), 'Office must expose the filtered watercolor character count')
assert(office.includes('data-office-one-watercolor-character-per-agent='), 'Office must expose one-character-per-agent evidence')
assert(office.includes('data-office-visible-robots={0}'), 'Office must report zero visible robots')
assert(office.includes('data-office-industrial-robots={0}'), 'Office must report zero industrial robots')
assert(office.includes('data-office-humanoid-robot-silhouettes={0}'), 'Office must report zero humanoid robot silhouettes')
assert(office.includes('frameloop="never"'), 'Office must use the bounded manual frame loop')
assert(office.includes('<OfficeFrameDriver active={renderQuality.renderActive}'), 'Office must pause rendering when inactive')

assert(workstation.includes('<WatercolorCharacterRig'), 'desk workers must render through WatercolorCharacterRig')
assert(walkers.includes('<WatercolorCharacterRig'), 'walking workers must render through WatercolorCharacterRig')
assert(rig.includes('name="watercolor-digital-worker"'), 'watercolor sprite must expose a stable scene identity')
assert(rig.includes("window.matchMedia('(prefers-reduced-motion: reduce)')"), 'watercolor motion must honor reduced motion')
assert(registry.includes("watercolorCharacterAssetFilename(role, 'idle')"), 'missing states must fall back to the same role idle asset')
assert(registry.includes("watercolorCharacterAssetFilename('researcher', 'idle')"), 'missing roles must use the neutral watercolor fallback')

for (const [label, source] of [['OfficeView', office], ['WorkstationPro', workstation], ['AgentWalkers', walkers]]) {
  assert(!source.includes('<AvatarRig'), `${label} must not render the legacy robot AvatarRig`)
  assert(!source.includes('<CompactRobotVisual'), `${label} must not render the legacy compact robot`)
  assert(!source.includes('<ProgressiveAvatarRig'), `${label} must not render the legacy progressive robot`)
  assert(!source.includes('<RobotModelAsset'), `${label} must not render the legacy robot GLB`)
}

console.log(`office watercolor status recheck: PASS (${expectedAssets.length}/${expectedAssets.length} runtime assets, zero robot render paths)`)
