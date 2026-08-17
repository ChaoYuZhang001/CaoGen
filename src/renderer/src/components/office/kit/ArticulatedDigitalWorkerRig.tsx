import { forwardRef, useMemo } from 'react'
import type { AvatarRefs } from './AvatarRig'
import LowPolyDigitalWorkerRig from './LowPolyDigitalWorkerRig'
import { providerLogoFor } from './ProviderLogos'
import type { WatercolorCharacterRole } from '../../../../../shared/watercolor-character'

interface ArticulatedDigitalWorkerRigProps {
  sessionId: string
  role: WatercolorCharacterRole
  providerName?: string
  providerBaseUrl?: string
  modelName?: string
  loadModel?: boolean
  detailLevel?: 'full' | 'low'
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

const ROLE_ACCENTS: Record<WatercolorCharacterRole, string> = {
  researcher: '#59dcff',
  planner: '#7fc7a1',
  writer: '#d6b36a',
  designer: '#d38aa0',
  developer: '#74a8df',
  'review-test': '#d18078',
  operations: '#9aa8b5'
}

const ArticulatedDigitalWorkerRig = forwardRef<AvatarRefs, ArticulatedDigitalWorkerRigProps>(
  function ArticulatedDigitalWorkerRig(
    {
      sessionId,
      role,
      providerName,
      providerBaseUrl,
      modelName,
      detailLevel = 'full',
      position,
      rotation,
      scale = 1
    },
    ref
  ): React.JSX.Element {
    const providerLogo = useMemo(
      () => providerLogoFor([providerName, modelName, providerBaseUrl]),
      [providerName, modelName, providerBaseUrl]
    )

    return (
      <group
        name="articulated-digital-worker"
        userData={{
          officeCharacterRenderer: 'articulated-3d',
          officeCharacterGrounded: true,
          officeCharacterRole: role,
          officeCharacterSessionId: sessionId
        }}
      >
        <LowPolyDigitalWorkerRig
          ref={ref}
          sessionId={sessionId}
          role={role}
          detailLevel={detailLevel}
          position={position}
          rotation={rotation}
          scale={scale}
          accentColor={ROLE_ACCENTS[role]}
          providerLogo={providerLogo}
        />
      </group>
    )
  }
)

export default ArticulatedDigitalWorkerRig
