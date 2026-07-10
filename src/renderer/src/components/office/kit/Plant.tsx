import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { DoubleSide } from 'three'
import type { Group } from 'three'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

type PlantKind = 'tall' | 'desk'

interface LeafSpec {
  /** 叶片挂点(围绕主干的角度) */
  angle: number
  /** 叶片长度 */
  length: number
  /** 叶片基部半径 */
  radius: number
  /** 挂点高度 */
  y: number
  /** 外倾角(从竖直向外张开) */
  tilt: number
  /** 微摆相位偏移 */
  phase: number
}

/**
 * 盆栽:陶盆 + 叶片(cone 主叶簇 + plane 阔叶),叶片随 useFrame 轻微摇摆。
 * kind="tall" 落地大株(约 1.3m),kind="desk" 桌面小株(约 0.28m)。
 * 纯几何体生成,不含发光材质(自然道具无需 Bloom)。
 */
export default function Plant({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  kind = 'tall'
}: OfficeProp & { kind?: PlantKind }): React.JSX.Element {
  const swayRef = useRef<Group>(null)

  const tall = kind === 'tall'

  // tall 与 desk 的基准尺寸(米)
  const dims = useMemo(() => {
    return tall
      ? {
          potH: 0.34,
          potTop: 0.26,
          potBot: 0.2,
          soilY: 0.3,
          soilR: 0.24,
          stemH: 0.42,
          stemR: 0.035,
          leafCount: 9,
          leafLen: 0.72,
          leafRadius: 0.11,
          baseY: 0.32,
          topY: 0.7
        }
      : {
          potH: 0.11,
          potTop: 0.09,
          potBot: 0.07,
          soilY: 0.095,
          soilR: 0.082,
          stemH: 0.1,
          stemR: 0.014,
          leafCount: 7,
          leafLen: 0.2,
          leafRadius: 0.035,
          baseY: 0.1,
          topY: 0.2
        }
  }, [tall])

  // 叶片布局:围绕主干分层张开,顶部更竖、底部更外倾
  const leaves = useMemo<LeafSpec[]>(() => {
    const out: LeafSpec[] = []
    const n = dims.leafCount
    for (let i = 0; i < n; i++) {
      const layer = i / n
      out.push({
        angle: (i / n) * Math.PI * 2 + (i % 2) * 0.4,
        length: dims.leafLen * (0.7 + (1 - layer) * 0.5),
        radius: dims.leafRadius * (0.8 + (1 - layer) * 0.4),
        y: dims.baseY + layer * (dims.topY - dims.baseY),
        tilt: 0.35 + (1 - layer) * 0.7,
        phase: (i * 0.7) % (Math.PI * 2)
      })
    }
    return out
  }, [dims])

  // 阔叶(plane)几处点缀,tall 更多
  const broadLeaves = useMemo<LeafSpec[]>(() => {
    const n = tall ? 4 : 2
    const out: LeafSpec[] = []
    for (let i = 0; i < n; i++) {
      out.push({
        angle: (i / n) * Math.PI * 2 + 0.6,
        length: dims.leafLen * 0.9,
        radius: dims.leafRadius * 1.6,
        y: dims.baseY + (i / n) * (dims.topY - dims.baseY) * 0.8,
        tilt: 0.5 + (i % 2) * 0.35,
        phase: (i * 1.3 + 0.5) % (Math.PI * 2)
      })
    }
    return out
  }, [dims, tall])

  useFrame((state) => {
    const g = swayRef.current
    if (!g) return
    const t = state.clock.getElapsedTime() + position[0] * 0.7 + position[2] * 0.5
    // 整簇轻微摇摆:摆幅随 kind 缩放,tall 更明显
    const amp = tall ? 0.045 : 0.02
    g.rotation.z = Math.sin(t * 0.9) * amp
    g.rotation.x = Math.cos(t * 0.7) * amp * 0.6
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 陶盆 */}
      <mesh position={[0, dims.potH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[dims.potTop, dims.potBot, dims.potH, 24]} />
        <meshStandardMaterial color="#4f5963" roughness={0.78} metalness={0.12} />
      </mesh>
      {/* 盆沿 */}
      <mesh position={[0, dims.potH, 0]} castShadow>
        <cylinderGeometry args={[dims.potTop * 1.08, dims.potTop, dims.potH * 0.12, 24]} />
        <meshStandardMaterial color="#65717d" roughness={0.72} metalness={0.16} />
      </mesh>
      {/* 土壤 */}
      <mesh position={[0, dims.soilY, 0]}>
        <cylinderGeometry args={[dims.soilR, dims.soilR, dims.potH * 0.12, 24]} />
        <meshStandardMaterial color="#161d24" roughness={0.95} />
      </mesh>

      {/* 主干 + 叶片(整簇摇摆) */}
      <group ref={swayRef} position={[0, dims.soilY, 0]}>
        {/* 主干 */}
        <mesh position={[0, dims.stemH / 2, 0]} castShadow>
          <cylinderGeometry args={[dims.stemR * 0.7, dims.stemR, dims.stemH, 12]} />
          <meshStandardMaterial color="#27323a" roughness={0.8} />
        </mesh>

        {/* cone 主叶簇 */}
        {leaves.map((leaf, i) => (
          <group key={`c${i}`} rotation={[0, leaf.angle, 0]}>
            <group rotation={[leaf.tilt, 0, 0]}>
              <mesh position={[0, leaf.y + leaf.length / 2, 0]} castShadow>
                <coneGeometry args={[leaf.radius, leaf.length, 6]} />
                <meshStandardMaterial
                  color={i % 2 === 0 ? '#3d4d58' : '#475a66'}
                  roughness={0.7}
                  metalness={0}
                />
              </mesh>
            </group>
          </group>
        ))}

        {/* plane 阔叶点缀(双面) */}
        {broadLeaves.map((leaf, i) => (
          <group key={`p${i}`} rotation={[0, leaf.angle, 0]}>
            <group rotation={[leaf.tilt, 0, 0]}>
              <mesh position={[0, leaf.y + leaf.length / 2, 0]}>
                <planeGeometry args={[leaf.radius * 2.2, leaf.length]} />
                <meshStandardMaterial color="#506571" roughness={0.7} side={DoubleSide} />
              </mesh>
            </group>
          </group>
        ))}
      </group>
    </group>
  )
}
