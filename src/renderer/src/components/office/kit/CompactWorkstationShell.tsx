import { useEffect, useMemo } from 'react'
import {
  BoxGeometry,
  Color,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type ColorRepresentation
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { OfficeSessionActivity } from '../model'
import type { ProviderLogoSpec } from './ProviderLogos'

type VectorTuple = [number, number, number]

interface BoxPart {
  size: VectorTuple
  position: VectorTuple
  color: ColorRepresentation
  rotation?: VectorTuple
}

export interface CompactWorkstationShellProps {
  activity: OfficeSessionActivity
  screenColor: string
  progress: number
  showOperator: boolean
  showBadge: boolean
  providerLogo: ProviderLogoSpec
}

const OFFICE_STRUCTURE_TRIM = '#697680'
const FAULT_COLOR = '#a94842'
const unitScale = new Vector3(1, 1, 1)

function boxGeometryFor(part: BoxPart): BoxGeometry {
  const geometry = new BoxGeometry(...part.size)
  const matrix = new Matrix4().compose(
    new Vector3(...part.position),
    new Quaternion().setFromEuler(new Euler(...(part.rotation ?? [0, 0, 0]))),
    unitScale
  )
  geometry.applyMatrix4(matrix)

  const vertexColor = new Color(part.color)
  const positions = geometry.getAttribute('position')
  const colors = new Float32BufferAttribute(positions.count * 3, 3)
  for (let index = 0; index < positions.count; index += 1) {
    colors.setXYZ(index, vertexColor.r, vertexColor.g, vertexColor.b)
  }
  geometry.setAttribute('color', colors)
  return geometry
}

function mergedBoxes(parts: BoxPart[]): BufferGeometry {
  const sources = parts.map(boxGeometryFor)
  const merged = mergeGeometries(sources)
  sources.forEach((geometry) => geometry.dispose())
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}

function monitorPosition(side: -1 | 1, zOffset: number): VectorTuple {
  const yaw = -side * 0.24
  return [side * 0.39 + Math.sin(yaw) * zOffset, 1.18, -0.54 + Math.cos(yaw) * zOffset]
}

/** Two vertex-colored geometry batches replace the repeated far-station prop tree. */
export default function CompactWorkstationShell({
  activity,
  screenColor,
  progress,
  showOperator,
  showBadge,
  providerLogo
}: CompactWorkstationShellProps): React.JSX.Element {
  const structureGeometry = useMemo(() => {
    const parts: BoxPart[] = [
      { size: [2.1, 0.05, 1.72], position: [0, 0.025, 0.08], color: '#14181f' },
      { size: [2.02, 0.04, 0.11], position: [0, 0.07, 0.92], color: OFFICE_STRUCTURE_TRIM },
      { size: [1.4, 0.055, 0.7], position: [0, 0.72, -0.32], color: '#707b85' },
      { size: [1.22, 0.64, 0.055], position: [0, 0.38, -0.59], color: '#39424d' },
      { size: [0.075, 0.5, 0.075], position: [0, 0.98, -0.55], color: '#2c313c' },
      { size: [0.56, 0.36, 0.05], position: [-0.39, 1.18, -0.54], rotation: [0, 0.24, 0], color: '#171b22' },
      { size: [0.56, 0.36, 0.05], position: [0.39, 1.18, -0.54], rotation: [0, -0.24, 0], color: '#171b22' },
      { size: [0.74, 0.04, 0.28], position: [0, 0.84, 0.14], rotation: [-0.08, 0, 0], color: '#18232d' }
    ]

    if (showOperator) {
      parts.push(
        { size: [0.46, 0.1, 0.44], position: [0, 0.44, 0.66], color: '#1b1e25' },
        { size: [0.46, 0.5, 0.07], position: [0, 0.7, 0.85], rotation: [0.14, 0, 0], color: '#1b1e25' }
      )
    }
    if (showBadge) {
      parts.push({
        size: [0.32, 0.09, 0.018],
        position: [0.49, 0.79, -0.1],
        rotation: [0, -0.35, 0],
        color: providerLogo.plateColor
      })
    }
    return mergedBoxes(parts)
  }, [providerLogo.plateColor, showBadge, showOperator])

  const signalGeometry = useMemo(() => {
    const signal = new Color(screenColor).multiplyScalar(activity === 'idle' ? 0.58 : 0.82)
    const parts: BoxPart[] = [
      {
        size: [1.72 * progress, 0.018, 0.056],
        position: [-(1.72 * (1 - progress)) / 2, 0.096, 0.92],
        color: signal
      },
      { size: [0.5, 0.3, 0.012], position: monitorPosition(-1, 0.031), rotation: [0, 0.24, 0], color: signal },
      { size: [0.5, 0.3, 0.012], position: monitorPosition(1, 0.031), rotation: [0, -0.24, 0], color: signal }
    ]
    if (showBadge) {
      parts.push({
        size: [0.22, 0.018, 0.008],
        position: [0.486, 0.79, -0.086],
        rotation: [0, -0.35, 0],
        color: providerLogo.brandColor
      })
    }
    if (activity === 'error') {
      parts.push({ size: [0.28, 0.045, 0.08], position: [0.72, 0.12, 0.82], color: FAULT_COLOR })
    }
    return mergedBoxes(parts)
  }, [activity, progress, providerLogo.brandColor, screenColor, showBadge])

  useEffect(() => () => structureGeometry.dispose(), [structureGeometry])
  useEffect(() => () => signalGeometry.dispose(), [signalGeometry])

  return (
    <group name="office-workstation-compact-shell">
      <mesh
        name="compact-workstation-structure-batch"
        userData={{ officeWorkstationBatch: 'structure' }}
        geometry={structureGeometry}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial vertexColors metalness={0.32} roughness={0.68} />
      </mesh>
      <mesh
        name="compact-workstation-signal-batch"
        userData={{ officeWorkstationBatch: 'signal' }}
        geometry={signalGeometry}
      >
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>
    </group>
  )
}
