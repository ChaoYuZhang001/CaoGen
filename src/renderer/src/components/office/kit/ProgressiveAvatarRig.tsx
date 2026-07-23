import { forwardRef, Suspense, useImperativeHandle, useRef } from 'react'
import type { ComponentPropsWithoutRef, Ref } from 'react'
import {
  BoxGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  TorusGeometry
} from 'three'
import type { Group, Material } from 'three'
import AvatarRig from './AvatarRig'
import type { AvatarRefs } from './AvatarRig'

type Props = ComponentPropsWithoutRef<typeof AvatarRig> & {
  loadModel?: boolean
}

type CompactRobotMaterialMode = 'basic' | 'lit'
type CompactRobotVariant = 'boot' | 'low'

export interface CompactRobotVisualProps {
  variant?: CompactRobotVariant
  materialMode?: CompactRobotMaterialMode
  accentColor?: string
  castShadow?: boolean
  headRef?: Ref<Group>
  armLRef?: Ref<Group>
  armRRef?: Ref<Group>
  legLRef?: Ref<Group>
  legRRef?: Ref<Group>
}

const COMPACT_HELMET = '#070b10'
const COMPACT_SILVER = '#c8d0d7'
const COMPACT_SILVER_HIGHLIGHT = '#e8edf1'
const COMPACT_SILVER_SHADOW = '#8f9aa4'
const COMPACT_JOINT = '#111820'
const COMPACT_SOLE = '#05080c'

const COMPACT_GEOMETRIES = {
  waist: new CylinderGeometry(0.085, 0.1, 0.12, 8),
  pelvis: new CylinderGeometry(0.13, 0.15, 0.13, 8),
  torso: new CylinderGeometry(0.22, 0.16, 0.46, 8),
  helmetBoot: new CapsuleGeometry(0.13, 0.05, 4, 8),
  helmetLow: new CapsuleGeometry(0.13, 0.05, 5, 12),
  visorBoot: new TorusGeometry(0.105, 0.01, 5, 18, Math.PI * 1.5),
  visorLow: new TorusGeometry(0.105, 0.01, 8, 28, Math.PI * 1.5),
  sensorSlit: new BoxGeometry(0.12, 0.014, 0.01),
  shoulder: new CylinderGeometry(0.07, 0.062, 0.08, 8),
  upperArm: new CapsuleGeometry(0.043, 0.21, 4, 7),
  elbow: new CylinderGeometry(0.048, 0.048, 0.045, 8),
  lowerArm: new CapsuleGeometry(0.038, 0.18, 4, 7),
  hand: new BoxGeometry(0.075, 0.065, 0.1),
  hip: new CylinderGeometry(0.062, 0.062, 0.05, 8),
  upperLeg: new CapsuleGeometry(0.055, 0.22, 4, 7),
  knee: new CylinderGeometry(0.055, 0.055, 0.045, 8),
  lowerLeg: new CapsuleGeometry(0.05, 0.2, 4, 7),
  foot: new BoxGeometry(0.14, 0.08, 0.25)
}

interface CompactMaterialOptions {
  color: string
  mode: CompactRobotMaterialMode
  glow?: boolean
  roughness?: number
  metalness?: number
}

interface CompactMaterialPalette {
  waist: Material
  pelvis: Material
  torso: Material
  helmet: Material
  accent: Material
  shoulder: Material
  upperArm: Material
  joint: Material
  lowerArm: Material
  hand: Material
  upperLeg: Material
  lowerLeg: Material
  sole: Material
}

const compactMaterialCache = new Map<string, Material>()
const compactPaletteCache = new Map<string, CompactMaterialPalette>()

function compactMaterial({
  color,
  mode,
  glow = false,
  roughness = 0.48,
  metalness = 0.36
}: CompactMaterialOptions): Material {
  const key = mode === 'basic' ? `${mode}|${color}|${glow}` : `${mode}|${color}|${glow}|${roughness}|${metalness}`
  const cached = compactMaterialCache.get(key)
  if (cached) return cached

  let material: Material
  if (mode === 'basic') {
    material = new MeshBasicMaterial({ color, toneMapped: !glow })
  } else if (glow) {
    material = new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.12,
      roughness: 0.24,
      metalness: 0.18,
      toneMapped: false
    })
  } else {
    material = new MeshStandardMaterial({ color, roughness, metalness })
  }
  compactMaterialCache.set(key, material)
  return material
}

function compactPalette(mode: CompactRobotMaterialMode, accentColor: string): CompactMaterialPalette {
  const key = `${mode}|${accentColor}`
  const cached = compactPaletteCache.get(key)
  if (cached) return cached
  const palette: CompactMaterialPalette = {
    waist: compactMaterial({ color: COMPACT_JOINT, mode, roughness: 0.54, metalness: 0.28 }),
    pelvis: compactMaterial({ color: COMPACT_SILVER_SHADOW, mode, roughness: 0.4, metalness: 0.46 }),
    torso: compactMaterial({ color: COMPACT_SILVER, mode, roughness: 0.4, metalness: 0.46 }),
    helmet: compactMaterial({ color: COMPACT_HELMET, mode, roughness: 0.24, metalness: 0.62 }),
    accent: compactMaterial({ color: accentColor, mode, glow: true }),
    shoulder: compactMaterial({ color: COMPACT_SILVER_HIGHLIGHT, mode, roughness: 0.34, metalness: 0.48 }),
    upperArm: compactMaterial({ color: COMPACT_SILVER, mode, roughness: 0.4, metalness: 0.44 }),
    joint: compactMaterial({ color: COMPACT_JOINT, mode, roughness: 0.46, metalness: 0.34 }),
    lowerArm: compactMaterial({ color: COMPACT_SILVER_SHADOW, mode, roughness: 0.42, metalness: 0.4 }),
    hand: compactMaterial({ color: COMPACT_JOINT, mode, roughness: 0.5, metalness: 0.28 }),
    upperLeg: compactMaterial({ color: COMPACT_SILVER, mode, roughness: 0.38, metalness: 0.48 }),
    lowerLeg: compactMaterial({ color: COMPACT_SILVER_HIGHLIGHT, mode, roughness: 0.36, metalness: 0.5 }),
    sole: compactMaterial({ color: COMPACT_SOLE, mode, roughness: 0.58, metalness: 0.2 })
  }
  compactPaletteCache.set(key, palette)
  return palette
}

export function CompactRobotVisual({
  variant = 'low',
  materialMode = 'lit',
  accentColor = '#59dcff',
  castShadow = materialMode === 'lit',
  headRef,
  armLRef,
  armRRef,
  legLRef,
  legRRef
}: CompactRobotVisualProps): React.JSX.Element {
  const lowDetail = variant === 'low'
  const palette = compactPalette(materialMode, accentColor)
  return (
    <group name={`compact-reference-robot-${variant}`} dispose={null}>
      <mesh geometry={COMPACT_GEOMETRIES.waist} material={palette.waist} position={[0, 0.65, 0]} castShadow={castShadow} />
      <mesh
        geometry={COMPACT_GEOMETRIES.pelvis}
        material={palette.pelvis}
        position={[0, 0.57, 0]}
        scale={[1, 1, 0.78]}
        castShadow={castShadow}
      />
      <mesh
        geometry={COMPACT_GEOMETRIES.torso}
        material={palette.torso}
        position={[0, 0.91, 0.01]}
        scale={[1, 1, 0.72]}
        castShadow={castShadow}
      />

      <group ref={headRef} position={[0, 1.18, 0]}>
        <mesh
          name="compact-reference-helmet-shell"
          geometry={lowDetail ? COMPACT_GEOMETRIES.helmetLow : COMPACT_GEOMETRIES.helmetBoot}
          material={palette.helmet}
          position={[0, 0.13, -0.045]}
          scale={[1, 1, 1.15]}
          castShadow={castShadow}
        />
        <mesh
          name="compact-reference-helmet-visor"
          geometry={lowDetail ? COMPACT_GEOMETRIES.visorLow : COMPACT_GEOMETRIES.visorBoot}
          material={palette.accent}
          position={[0, 0.12, 0.108]}
          rotation={[0, 0, Math.PI * 0.75]}
          scale={[0.88, 1.05, 0.12]}
        />
        <mesh
          name="compact-reference-sensor-slit"
          geometry={COMPACT_GEOMETRIES.sensorSlit}
          material={palette.accent}
          position={[0, 0.19, 0.122]}
        />
      </group>

      {lowDetail &&
        ([-1, 1] as const).map((side) => (
          <group
            key={`compact-arm-${side}`}
            ref={side < 0 ? armLRef : armRRef}
            position={[side * 0.215, 1.03, 0]}
          >
            <mesh
              geometry={COMPACT_GEOMETRIES.shoulder}
              material={palette.shoulder}
              rotation={[0, 0, Math.PI / 2]}
              castShadow={castShadow}
            />
            <mesh
              geometry={COMPACT_GEOMETRIES.upperArm}
              material={palette.upperArm}
              position={[0, -0.145, 0]}
              castShadow={castShadow}
            />
            <mesh
              geometry={COMPACT_GEOMETRIES.elbow}
              material={palette.joint}
              position={[0, -0.3, 0]}
              rotation={[0, 0, Math.PI / 2]}
              castShadow={castShadow}
            />
            <mesh
              geometry={COMPACT_GEOMETRIES.lowerArm}
              material={palette.lowerArm}
              position={[0, -0.42, 0.012]}
              castShadow={castShadow}
            />
            <mesh
              geometry={COMPACT_GEOMETRIES.hand}
              material={palette.hand}
              position={[0, -0.56, 0.035]}
              castShadow={castShadow}
            />
          </group>
        ))}

      {lowDetail &&
        ([-1, 1] as const).map((side) => (
          <group
            key={`compact-leg-${side}`}
            ref={side < 0 ? legLRef : legRRef}
            position={[side * 0.09, 0.55, 0]}
          >
            <mesh
              geometry={COMPACT_GEOMETRIES.hip}
              material={palette.joint}
              rotation={[0, 0, Math.PI / 2]}
              castShadow={castShadow}
            />
            <mesh
              geometry={COMPACT_GEOMETRIES.upperLeg}
              material={palette.upperLeg}
              position={[0, -0.15, 0]}
              castShadow={castShadow}
            />
            <mesh
              geometry={COMPACT_GEOMETRIES.knee}
              material={palette.joint}
              position={[0, -0.34, 0]}
              rotation={[0, 0, Math.PI / 2]}
              castShadow={castShadow}
            />
            <mesh
              geometry={COMPACT_GEOMETRIES.lowerLeg}
              material={palette.lowerLeg}
              position={[0, -0.4, 0.01]}
              castShadow={castShadow}
            />
            <mesh
              geometry={COMPACT_GEOMETRIES.foot}
              material={palette.sole}
              position={[0, -0.49, 0.075]}
              castShadow={castShadow}
            />
          </group>
        ))}
    </group>
  )
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
        officeRobotModelUrl: ready ? 'procedural-low-v2' : undefined,
        officeRobotVisualFamily: 'reference-unitree-v2',
        officeRobotRequestedLod: detailLevel,
        officeRobotSessionId: sessionId ?? ''
      }}
    >
      <CompactRobotVisual
        variant="low"
        accentColor={accentColor}
        headRef={headRef}
        armLRef={armLRef}
        armRRef={armRRef}
        legLRef={legLRef}
        legRRef={legRRef}
      />
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
