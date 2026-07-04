import { useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Object3D } from 'three'
import type { Group, InstancedMesh } from 'three'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

const SPOKES = 5
// 五爪的方位角(XZ 平面),均匀分布
const SPOKE_ANGLES = Array.from({ length: SPOKES }, (_, i) => (i / SPOKES) * Math.PI * 2)

// 闭包外复用,避免 useFrame / 布局阶段内 new
const tmpObj = new Object3D()

/**
 * 人体工学转椅:座垫 + 靠背 + 五爪轮 base + 扶手,深色写实。
 * 朝 -Z 面向桌子(靠背在 +Z 侧)。座椅上半部有极轻微的怠速回摆,
 * 幅度很小以保持"面向桌子"的朝向。
 * 五爪脚与滚轮用 instancedMesh 批量绘制;无发光材质。
 */
export default function OfficeChair({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  const upperRef = useRef<Group>(null)
  const legsRef = useRef<InstancedMesh>(null)
  const castersRef = useRef<InstancedMesh>(null)

  // 相位:让多把椅子的怠速回摆错开
  const phase = useMemo(() => (position[0] * 1.3 + position[2] * 0.7) % (Math.PI * 2), [position])

  // 五爪脚:一根从中心向外的锥形横梁;滚轮:爪端的小球
  useLayoutEffect(() => {
    const legs = legsRef.current
    const casters = castersRef.current
    for (let i = 0; i < SPOKES; i++) {
      const a = SPOKE_ANGLES[i]
      const dx = Math.cos(a)
      const dz = Math.sin(a)

      // 横梁:本地 +X 为长度方向,rotation.y = -a 使其指向方位角 a
      if (legs) {
        tmpObj.position.set(dx * 0.22, 0.05, dz * 0.22)
        tmpObj.rotation.set(0, -a, 0)
        tmpObj.scale.set(1, 1, 1)
        tmpObj.updateMatrix()
        legs.setMatrixAt(i, tmpObj.matrix)
      }

      // 滚轮:横梁末端
      if (casters) {
        tmpObj.position.set(dx * 0.42, 0.035, dz * 0.42)
        tmpObj.rotation.set(0, 0, 0)
        tmpObj.scale.set(1, 1, 1)
        tmpObj.updateMatrix()
        casters.setMatrixAt(i, tmpObj.matrix)
      }
    }
    if (legs) legs.instanceMatrix.needsUpdate = true
    if (casters) casters.instanceMatrix.needsUpdate = true
  }, [])

  useFrame((state) => {
    const upper = upperRef.current
    if (!upper) return
    const t = state.clock.getElapsedTime() + phase
    // 极轻微怠速回摆(≈±2.3°),保持面向桌子
    upper.rotation.y = Math.sin(t * 0.6) * 0.04
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* ---- 底盘:五爪脚 + 滚轮(instancedMesh) ---- */}
      <instancedMesh ref={legsRef} args={[undefined, undefined, SPOKES]} castShadow>
        {/* 中心略高、向外收窄的横梁;本地 X 为长度 */}
        <boxGeometry args={[0.42, 0.05, 0.09]} />
        <meshStandardMaterial color="#22262e" metalness={0.5} roughness={0.5} />
      </instancedMesh>
      <instancedMesh ref={castersRef} args={[undefined, undefined, SPOKES]} castShadow>
        <sphereGeometry args={[0.045, 16, 16]} />
        <meshStandardMaterial color="#101216" metalness={0.3} roughness={0.6} />
      </instancedMesh>

      {/* 中心气压柱套筒 */}
      <mesh position={[0, 0.1, 0]}>
        <cylinderGeometry args={[0.055, 0.07, 0.12, 32]} />
        <meshStandardMaterial color="#2c313c" metalness={0.6} roughness={0.4} />
      </mesh>
      {/* 气压升降柱 */}
      <mesh position={[0, 0.27, 0]} castShadow>
        <cylinderGeometry args={[0.035, 0.035, 0.3, 32]} />
        <meshStandardMaterial color="#3a4150" metalness={0.75} roughness={0.3} />
      </mesh>

      {/* ---- 座椅上半部:座垫 + 靠背 + 扶手(随怠速回摆) ---- */}
      <group ref={upperRef} position={[0, 0.42, 0]}>
        {/* 座垫底托 */}
        <mesh position={[0, -0.02, 0]}>
          <boxGeometry args={[0.46, 0.05, 0.44]} />
          <meshStandardMaterial color="#2c313c" metalness={0.5} roughness={0.45} />
        </mesh>
        {/* 座垫 */}
        <mesh position={[0, 0.045, 0]} castShadow>
          <boxGeometry args={[0.48, 0.09, 0.46]} />
          <meshStandardMaterial color="#1b1e25" metalness={0.15} roughness={0.85} />
        </mesh>

        {/* 靠背支撑臂(座垫后端上翘接靠背) */}
        <mesh position={[0, 0.12, 0.22]} rotation={[0.28, 0, 0]}>
          <boxGeometry args={[0.1, 0.28, 0.06]} />
          <meshStandardMaterial color="#2c313c" metalness={0.6} roughness={0.4} />
        </mesh>
        {/* 靠背(略后倾) */}
        <mesh position={[0, 0.34, 0.25]} rotation={[0.14, 0, 0]} castShadow>
          <boxGeometry args={[0.46, 0.5, 0.07]} />
          <meshStandardMaterial color="#1b1e25" metalness={0.15} roughness={0.85} />
        </mesh>
        {/* 头枕 */}
        <mesh position={[0, 0.62, 0.22]} rotation={[0.1, 0, 0]}>
          <boxGeometry args={[0.28, 0.14, 0.06]} />
          <meshStandardMaterial color="#22262e" metalness={0.2} roughness={0.8} />
        </mesh>

        {/* 扶手:立柱 + 顶垫,左右各一 */}
        {[-1, 1].map((s) => (
          <group key={s} position={[s * 0.28, 0, 0]}>
            <mesh position={[0, 0.12, 0.02]}>
              <boxGeometry args={[0.045, 0.2, 0.045]} />
              <meshStandardMaterial color="#2c313c" metalness={0.6} roughness={0.4} />
            </mesh>
            <mesh position={[0, 0.23, 0.02]}>
              <boxGeometry args={[0.07, 0.04, 0.22]} />
              <meshStandardMaterial color="#15181e" metalness={0.2} roughness={0.8} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  )
}
