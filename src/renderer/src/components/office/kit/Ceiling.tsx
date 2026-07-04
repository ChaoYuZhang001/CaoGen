import { useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Object3D } from 'three'
import type { InstancedMesh, MeshStandardMaterial } from 'three'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

// 吊顶高度与铺设区域(单位≈米);工位分布在 ±6 左右,吊顶略大以完整覆盖
const CEILING_Y = 6.2
const AREA_X = 16
const AREA_Z = 16

// 条形灯盘规则网格:X 方向 3 段 × Z 方向 4 排
const NX = 3
const NZ = 4
const PANEL_COUNT = NX * NZ

// 单个灯盘尺寸(长条沿 X)
const STRIP_LEN = (AREA_X / NX) * 0.82
const STRIP_WIDTH = 0.55
const STRIP_DROP = 0.06 // 嵌入式灯盘略低于吊顶面

// 灯盘发光色:偏冷白,克制(主黑副白,青调点缀)
const LIGHT_COLOR = '#eaf6ff'
// 吊顶中性深灰
const CEILING_COLOR = '#1b1b1b'
// 灯槽边框(比吊顶更深)
const TROUGH_COLOR = '#111111'

/**
 * 吊顶 + 嵌入式条形灯盘。
 * 吊顶为朝下的中性深灰面;灯盘用 instancedMesh 规则排布的发光面(emissive,
 * 配合 Bloom 产生辉光),整体做轻微的呼吸脉动,保持克制。
 */
export default function Ceiling({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  const troughRef = useRef<InstancedMesh>(null)
  const lightRef = useRef<InstancedMesh>(null)
  const lightMatRef = useRef<MeshStandardMaterial>(null)

  // 闭包外复用的临时对象,避免每帧/每实例 new
  const dummy = useMemo(() => new Object3D(), [])

  // 灯盘世界坐标(相对本组),规则网格
  const layout = useMemo(() => {
    const out: Array<[number, number]> = []
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const x = (i - (NX - 1) / 2) * (AREA_X / NX)
        const z = (j - (NZ - 1) / 2) * (AREA_Z / NZ)
        out.push([x, z])
      }
    }
    return out
  }, [])

  // 写入两组 instancedMesh 的实例矩阵(静态,布局后一次)
  useLayoutEffect(() => {
    const light = lightRef.current
    const trough = troughRef.current
    for (let k = 0; k < PANEL_COUNT; k++) {
      const [x, z] = layout[k]
      // 灯槽边框:略大、略高
      dummy.position.set(x, CEILING_Y - 0.01, z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      trough?.setMatrixAt(k, dummy.matrix)
      // 发光灯面:嵌入槽内,略低于吊顶
      dummy.position.set(x, CEILING_Y - STRIP_DROP, z)
      dummy.updateMatrix()
      light?.setMatrixAt(k, dummy.matrix)
    }
    if (trough) trough.instanceMatrix.needsUpdate = true
    if (light) light.instanceMatrix.needsUpdate = true
  }, [dummy, layout])

  // 灯盘整体轻微呼吸(共享材质,统一脉动,保持克制)
  useFrame((state) => {
    const mat = lightMatRef.current
    if (mat) {
      const t = state.clock.getElapsedTime()
      mat.emissiveIntensity = 1.15 + Math.sin(t * 0.9) * 0.15
    }
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 吊顶主面:朝下(法线 -Y) */}
      <mesh position={[0, CEILING_Y, 0]} rotation={[Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[AREA_X + 4, AREA_Z + 4]} />
        <meshStandardMaterial color={CEILING_COLOR} metalness={0.1} roughness={0.95} />
      </mesh>

      {/* 灯槽边框(深色框,衬托灯盘) */}
      <instancedMesh ref={troughRef} args={[undefined, undefined, PANEL_COUNT]}>
        <boxGeometry args={[STRIP_LEN + 0.14, 0.06, STRIP_WIDTH + 0.14]} />
        <meshStandardMaterial color={TROUGH_COLOR} metalness={0.2} roughness={0.8} />
      </instancedMesh>

      {/* 嵌入式条形灯盘:发光面(emissive + toneMapped=false 供 Bloom) */}
      <instancedMesh ref={lightRef} args={[undefined, undefined, PANEL_COUNT]}>
        <boxGeometry args={[STRIP_LEN, 0.04, STRIP_WIDTH]} />
        <meshStandardMaterial
          ref={lightMatRef}
          color={LIGHT_COLOR}
          emissive={LIGHT_COLOR}
          emissiveIntensity={1.15}
          toneMapped={false}
        />
      </instancedMesh>
    </group>
  )
}
