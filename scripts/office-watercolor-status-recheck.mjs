#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (relativePath) => readFileSync(path.join(process.cwd(), relativePath), 'utf8')
const roles = ['researcher', 'planner', 'writer', 'designer', 'developer', 'review-test', 'operations']
const officeBootView = read('src/renderer/src/components/office/OfficeView.tsx')
const office = read('src/renderer/src/components/office/OfficeRuntime.tsx')
const boot = read('src/renderer/src/components/office/kit/OfficeBootCharacter.tsx')
const workstation = read('src/renderer/src/components/office/kit/WorkstationPro.tsx')
const workstationOperator = read('src/renderer/src/components/office/kit/WorkstationOperatorRig.tsx')
const walkers = read('src/renderer/src/components/office/kit/AgentWalkers.tsx')
const walkerAnimation = read('src/renderer/src/components/office/kit/WalkerRigAnimation.ts')
const articulatedRig = read('src/renderer/src/components/office/kit/ArticulatedDigitalWorkerRig.tsx')
const lowPolyRig = read('src/renderer/src/components/office/kit/LowPolyDigitalWorkerRig.tsx')

assert(office.includes("import OfficeBootCharacter from './kit/OfficeBootCharacter'"), 'Office boot must use the 3D worker visual')
assert(officeBootView.includes('const OFFICE_MAX_VISIBLE_SESSIONS = 9'), 'lightweight Office boot must cap the floor at 9')
assert(office.includes('const OFFICE_MAX_VISIBLE_SESSIONS = 9'), 'Office runtime must cap the floor at 9')
assert(officeBootView.includes('boot.selectSession(id)'), 'lightweight Office overflow must select the canonical session')
assert(office.includes('data-office-articulated-characters={visibleIds.length}'), 'Office must expose the articulated character count')
assert(office.includes('data-office-grounded-character-rigs={visibleIds.length}'), 'Office must expose the grounded character count')
assert(office.includes('data-office-low-poly-digital-workers={visibleIds.length}'), 'Office must expose the low-poly worker count')
assert(office.includes('data-office-camera-facing-character-sprites={0}'), 'Office must expose zero camera-facing character sprites')
assert(boot.includes('name="office-boot-articulated-worker"') && boot.includes('<LowPolyDigitalWorkerRig'), 'boot workers must render the same low-poly worker family')
assert(boot.includes("officeCharacterRenderer: 'articulated-3d'") && boot.includes('officeCharacterGrounded: true'), 'boot workers must expose 3D grounding evidence')

assert(workstation.includes('<WorkstationOperatorRig'), 'desk workers must use the workstation 3D rig')
assert(workstationOperator.includes('<ArticulatedDigitalWorkerRig'), 'workstation operator must render the articulated rig')
assert(workstationOperator.includes('applyTyping(refs, time, opts)'), 'desk workers must retain joint-driven task animation')
assert(workstationOperator.includes('desk-left-hand-ik-target') && workstationOperator.includes('desk-right-hand-ik-target'), 'desk workers must retain both hand targets')
assert(walkers.includes('<ArticulatedDigitalWorkerRig') && walkers.includes('animateWalkerRig('), 'walking workers must use the articulated rig driver')
assert(walkers.includes('detailLevel="full"'), 'walking workers must use the full joint hierarchy')
assert(walkerAnimation.includes('applyWalking(refs, clock') && walkerAnimation.includes('walkFootTargets'), 'walking workers must pass both ground targets into gait IK')

assert(articulatedRig.includes('<LowPolyDigitalWorkerRig'), 'articulated worker wrapper must use the low-poly human rig')
assert(articulatedRig.includes("officeCharacterRenderer: 'articulated-3d'") && articulatedRig.includes('officeCharacterGrounded: true'), '3D rig must expose its grounding contract')
assert(lowPolyRig.includes('low-poly-human-v1'), 'worker rig must expose its visual family')
assert(lowPolyRig.includes('footL: footLRef.current') && lowPolyRig.includes('footR: footRRef.current'), 'worker rig must expose both foot contacts')
assert(lowPolyRig.includes('<WorkerHead') && lowPolyRig.includes('<WorkerArm') && lowPolyRig.includes('<WorkerLeg'), 'worker rig must retain a human-proportion articulated hierarchy')
for (const role of roles) {
  assert(articulatedRig.includes(`${role}:`) || articulatedRig.includes(`'${role}':`), `3D role accent is missing: ${role}`)
}
for (const [label, source] of [['OfficeView', office], ['WorkstationPro', workstation], ['AgentWalkers', walkers]]) {
  assert(!source.includes('<WatercolorCharacterRig'), `${label} must not render a camera-facing paper Sprite`)
}

console.log('office articulated character status recheck: PASS (low-poly human rigs, grounded feet, zero Office sprites)')
