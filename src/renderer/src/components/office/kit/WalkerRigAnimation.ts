import type { Object3D } from 'three'
import type { AvatarRefs } from './AvatarRig'
import { applyIdle, applyStandingTalking, applyWalking } from './AvatarAnimations'

export function animateWalkerRig(
  refs: AvatarRefs | null,
  clock: number,
  approvalReason: boolean,
  walking: boolean,
  local: number,
  stage: 'toTarget' | 'target' | 'toHome' | 'home',
  travelSeconds: number,
  backEnd: number,
  phase: number,
  gaitPhase: number,
  gaitMotion: number,
  leftFootTarget: Object3D | null,
  rightFootTarget: Object3D | null
): void {
  if (!refs) return
  const secondsToStop = stage === 'toTarget' ? travelSeconds - local : stage === 'toHome' ? backEnd - local : 0
  const arrivalEase = walking ? smoothstep(clamp(secondsToStop / 0.9, 0, 1)) : 0
  const animOpts = { phase: phase * 0.17, liveliness: walking ? 0.2 + arrivalEase * 0.72 : 0.62 }
  if (walking) {
    applyWalking(refs, clock, {
      ...animOpts,
      gaitPhase,
      gaitSpeed: gaitMotion,
      walkFootTargets: { left: leftFootTarget, right: rightFootTarget }
    })
  } else if (stage === 'target' && approvalReason) {
    applyStandingTalking(refs, clock, animOpts)
  } else {
    applyIdle(refs, clock, animOpts)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function smoothstep(value: number): number {
  const c = clamp(value, 0, 1)
  return c * c * (3 - 2 * c)
}
