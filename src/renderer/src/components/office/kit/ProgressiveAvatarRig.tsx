import { forwardRef, Suspense, useImperativeHandle, useRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import type { Group } from 'three'
import AvatarRig from './AvatarRig'
import type { AvatarRefs } from './AvatarRig'

type Props = ComponentPropsWithoutRef<typeof AvatarRig> & {
  loadModel?: boolean
}

type CompactRobotRigProps = Props & { ready: boolean }

const CompactRobotRig = forwardRef<AvatarRefs, CompactRobotRigProps>(function CompactRobotRig(
  {
    position,
    rotation,
    scale = 1,
    accentColor = '#59dcff',
    detailLevel = 'full',
    sessionId,
    ready
  },
  ref
): React.JSX.Element {
  const rootRef = useRef<Group>(null)
  const headRef = useRef<Group>(null)
  const armLRef = useRef<Group>(null)
  const armRRef = useRef<Group>(null)
  const legLRef = useRef<Group>(null)
  const legRRef = useRef<Group>(null)
  useImperativeHandle(
    ref,
    () => ({
      root: rootRef.current,
      head: headRef.current,
      armL: armLRef.current,
      armR: armRRef.current,
      legL: legLRef.current,
      legR: legRRef.current
    }),
    []
  )

  return (
    <group
      ref={rootRef}
      position={position}
      rotation={rotation}
      scale={scale}
      userData={{
        officeRobotLoading: !ready,
        officeRobotLod: ready ? 'low' : undefined,
        officeRobotAssetLod: ready ? 'low' : undefined,
        officeRobotModelUrl: ready ? 'procedural-low-v1' : undefined,
        officeRobotRequestedLod: detailLevel,
        officeRobotSessionId: sessionId ?? ''
      }}
    >
      <mesh position={[0, 0.62, 0]} castShadow>
        <boxGeometry args={[0.25, 0.15, 0.18]} />
        <meshStandardMaterial color="#16202a" roughness={0.58} metalness={0.2} />
      </mesh>
      <mesh position={[0, 0.86, 0]} castShadow>
        <capsuleGeometry args={[0.14, 0.42, 4, 8]} />
        <meshStandardMaterial color="#9aa6b0" roughness={0.62} metalness={0.18} />
      </mesh>
      <group ref={headRef} position={[0, 1.3, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.17, 12, 8]} />
          <meshStandardMaterial color="#101820" roughness={0.48} metalness={0.24} />
        </mesh>
        <mesh position={[0, -0.01, 0.15]}>
          <boxGeometry args={[0.19, 0.025, 0.018]} />
          <meshBasicMaterial color={accentColor} toneMapped={false} />
        </mesh>
      </group>
      {[-1, 1].map((side) => (
        <group key={side}>
          <group ref={side < 0 ? armLRef : armRRef} position={[side * 0.2, 1.02, 0]}>
            <mesh position={[0, -0.2, 0]} castShadow>
              <capsuleGeometry args={[0.045, 0.34, 4, 6]} />
              <meshStandardMaterial color="#7f8b95" roughness={0.66} metalness={0.14} />
            </mesh>
            <mesh position={[0, -0.42, 0.01]} castShadow>
              <capsuleGeometry args={[0.04, 0.18, 4, 6]} />
              <meshStandardMaterial color="#18212a" roughness={0.62} metalness={0.18} />
            </mesh>
          </group>
          <group ref={side < 0 ? legLRef : legRRef} position={[side * 0.085, 0.58, 0]}>
            <mesh position={[0, -0.28, 0]} castShadow>
              <capsuleGeometry args={[0.06, 0.46, 4, 6]} />
              <meshStandardMaterial color="#8d99a3" roughness={0.66} metalness={0.14} />
            </mesh>
            <mesh position={[0, -0.55, 0.055]} castShadow>
              <boxGeometry args={[0.13, 0.07, 0.25]} />
              <meshStandardMaterial color="#111820" roughness={0.68} metalness={0.1} />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  )
})

const ProgressiveAvatarRig = forwardRef<AvatarRefs, Props>(function ProgressiveAvatarRig(
  { loadModel = true, ...props },
  ref
): React.JSX.Element {
  const loadingProxy = <CompactRobotRig {...props} ref={ref} ready={false} />
  const compactRig = <CompactRobotRig {...props} ref={ref} detailLevel="low" ready />
  if (props.detailLevel !== 'full') return compactRig
  if (!loadModel) return loadingProxy
  return (
    <Suspense fallback={loadingProxy}>
      <AvatarRig {...props} ref={ref} />
    </Suspense>
  )
})

export default ProgressiveAvatarRig
