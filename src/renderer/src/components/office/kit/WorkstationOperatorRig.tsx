import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group } from 'three'
import type { AvatarRefs } from './AvatarRig'
import { applyMonitoring, applyTalking, applyThinking, applyTyping } from './AvatarAnimations'
import ArticulatedDigitalWorkerRig from './ArticulatedDigitalWorkerRig'
import type { WatercolorCharacterRole } from '../../../../../shared/watercolor-character'

interface WorkstationOperatorRigProps {
  sessionId: string
  role: WatercolorCharacterRole
  providerName?: string
  providerBaseUrl?: string
  modelName?: string
  activity: 'idle' | 'working' | 'awaiting' | 'completed' | 'error'
  liveliness: number
  loadModel: boolean
  detailLevel: 'full' | 'low'
  position: [number, number, number]
  rotation: [number, number, number]
  scale: number
  phase: number
}

export default function WorkstationOperatorRig({
  sessionId,
  role,
  providerName,
  providerBaseUrl,
  modelName,
  activity,
  liveliness,
  loadModel,
  detailLevel,
  position,
  rotation,
  scale,
  phase
}: WorkstationOperatorRigProps): React.JSX.Element {
  const rigRef = useRef<AvatarRefs>(null)
  const leftHandTargetRef = useRef<Group>(null)
  const rightHandTargetRef = useRef<Group>(null)
  const motionScale = Math.min(Math.max(liveliness, 0.2), 1.2)

  useFrame(({ clock }) => {
    const refs = rigRef.current
    if (!refs) return
    const opts = {
      phase,
      liveliness: motionScale,
      deskHandTargets: {
        left: leftHandTargetRef.current,
        right: rightHandTargetRef.current
      }
    }
    const time = clock.getElapsedTime()
    if (activity === 'working') applyTyping(refs, time, opts)
    else if (activity === 'awaiting') applyTalking(refs, time, opts)
    else if (activity === 'error') applyThinking(refs, time, opts)
    else applyMonitoring(refs, time, opts)
  })

  return (
    <>
      <group ref={leftHandTargetRef} name="desk-left-hand-ik-target" position={[-0.18, 0.93, 0.28]} />
      <group ref={rightHandTargetRef} name="desk-right-hand-ik-target" position={[0.18, 0.93, 0.28]} />
      <ArticulatedDigitalWorkerRig
        ref={rigRef}
        sessionId={sessionId}
        role={role}
        providerName={providerName}
        providerBaseUrl={providerBaseUrl}
        modelName={modelName}
        loadModel={loadModel}
        detailLevel={detailLevel}
        position={position}
        rotation={rotation}
        scale={scale}
      />
    </>
  )
}
