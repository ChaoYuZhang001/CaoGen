import { useLayoutEffect, useMemo, useRef } from 'react'
import { BufferAttribute, Color, Object3D, PlaneGeometry } from 'three'
import type { Group, InstancedMesh } from 'three'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

interface WindowWallProps extends OfficeProp {
  /** 展示视角里的侧向窗墙:减少窗框密度,避免像一整面墙挡住工位 */
  minimalFrames?: boolean
}

// 幕墙尺寸(米):宽 × 高。本地空间下底边贴地(y=0),外侧(城市)朝 -Z。
const WALL_W = 12
const WALL_H = 5
const MULLION_GAP = 1.5
const GLASS_Z = 0
const BACKDROP_Z = -6

const FULL_MULLION_XS = Array.from(
  { length: Math.floor(WALL_W / MULLION_GAP) + 1 },
  (_, i) => -WALL_W / 2 + i * MULLION_GAP
)
const MINIMAL_MULLION_XS = [-WALL_W / 2, WALL_W / 2]
const BUILDING_COUNT = 24
const WINDOW_COUNT = 90

// 闭包外复用,避免每帧/每实例 new
const dummy = new Object3D()
const skyTop = new Color('#0a1226')
const skyBottom = new Color('#243a5e')
const horizonGlow = new Color('#8fe9ff')

// 确定性伪随机(避免每次渲染抖动)
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

/**
 * 落地玻璃幕墙:半透明玻璃 + 竖向窗框 + 窗外夜景城市/天空渐变背板。
 * 纯代码几何;渐变用顶点色平面,城市用 instancedMesh 剪影 + 发光窗点。
 */
export default function WindowWall({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  minimalFrames = false
}: WindowWallProps): React.JSX.Element {
  const groupRef = useRef<Group>(null)
  const mullionsRef = useRef<InstancedMesh>(null)
  const buildingsRef = useRef<InstancedMesh>(null)
  const windowsRef = useRef<InstancedMesh>(null)
  const mullionXs = useMemo(() => (minimalFrames ? MINIMAL_MULLION_XS : FULL_MULLION_XS), [minimalFrames])

  // 天空渐变几何:按顶点 y 生成竖向渐变 + 近地平线青色辉光
  const skyGeo = useMemo(() => {
    const skyWidth = minimalFrames ? WALL_W + 2.4 : WALL_W + 8
    const skyHeight = minimalFrames ? 1.35 : WALL_H + 6
    const g = new PlaneGeometry(skyWidth, skyHeight, 1, minimalFrames ? 24 : 48)
    const pos = g.attributes.position
    const colors = new Float32Array(pos.count * 3)
    const c = new Color()
    const half = skyHeight / 2
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      const t = (y + half) / skyHeight
      c.copy(skyBottom).lerp(skyTop, t)
      const horizon = Math.max(0, 1 - Math.abs(t - 0.1) / 0.14)
      c.lerp(horizonGlow, horizon * (minimalFrames ? 0.14 : 0.35))
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    g.setAttribute('color', new BufferAttribute(colors, 3))
    return g
  }, [minimalFrames])

  // 城市楼群 + 窗户光点的实例数据
  const cityData = useMemo(() => {
    const buildings: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = []
    const windows: Array<{ x: number; y: number; z: number; s: number }> = []
    const heightScale = minimalFrames ? 0.3 : 1
    const backdropPush = minimalFrames ? -2.2 : 0
    for (let i = 0; i < BUILDING_COUNT; i++) {
      const w = 0.5 + hash(i) * 0.9
      const h = (1.2 + hash(i * 2.3) * (WALL_H - 0.6)) * heightScale
      const d = 0.4 + hash(i * 3.7) * 0.6
      const x = -WALL_W / 2 - 2 + (i / (BUILDING_COUNT - 1)) * (WALL_W + 4) + (hash(i * 5.1) - 0.5) * 0.6
      const z = BACKDROP_Z + backdropPush + 0.6 + hash(i * 7.9) * 2.2
      buildings.push({ x, y: h / 2, z, w, h, d: d })
      // 每栋楼贴若干发光窗
      const rows = Math.floor(h / 0.55)
      for (let r = 0; r < rows && windows.length < WINDOW_COUNT; r++) {
        if (hash(i * 13.3 + r * 2.1) < (minimalFrames ? 0.72 : 0.55)) continue
        windows.push({
          x: x + (hash(i + r) - 0.5) * w * 0.7,
          y: 0.35 + r * 0.55,
          z: z + d / 2 + 0.01,
          s: (0.1 + hash(i * 2 + r) * 0.06) * (minimalFrames ? 0.82 : 1)
        })
      }
    }
    return { buildings, windows }
  }, [minimalFrames])

  // 竖向窗框实例
  useLayoutEffect(() => {
    const inst = mullionsRef.current
    if (!inst) return
    for (let i = 0; i < mullionXs.length; i++) {
      const x = mullionXs[i]
      dummy.position.set(x, WALL_H / 2, GLASS_Z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      inst.setMatrixAt(i, dummy.matrix)
    }
    inst.instanceMatrix.needsUpdate = true
  }, [mullionXs])

  // 城市楼群实例
  useLayoutEffect(() => {
    const inst = buildingsRef.current
    if (!inst) return
    cityData.buildings.forEach((b, i) => {
      dummy.position.set(b.x, b.y, b.z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(b.w, b.h, b.d)
      dummy.updateMatrix()
      inst.setMatrixAt(i, dummy.matrix)
    })
    inst.instanceMatrix.needsUpdate = true
  }, [cityData])

  // 发光窗点实例
  useLayoutEffect(() => {
    const inst = windowsRef.current
    if (!inst) return
    cityData.windows.forEach((wnd, i) => {
      dummy.position.set(wnd.x, wnd.y, wnd.z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(wnd.s, wnd.s, wnd.s)
      dummy.updateMatrix()
      inst.setMatrixAt(i, dummy.matrix)
    })
    inst.instanceMatrix.needsUpdate = true
  }, [cityData])

  return (
    <group ref={groupRef} position={position} rotation={rotation} scale={scale}>
      {/* 展示视角只保留远景氛围,不再画成一整面压住工位的墙。 */}
      <mesh geometry={skyGeo} position={[0, minimalFrames ? 1.28 : WALL_H / 2, BACKDROP_Z + (minimalFrames ? -1.45 : 0)]}>
        <meshBasicMaterial
          vertexColors
          toneMapped={false}
          transparent={minimalFrames}
          opacity={minimalFrames ? 0.18 : 1}
          depthWrite={!minimalFrames}
        />
      </mesh>

      {/* 城市楼群剪影 */}
      <instancedMesh
        ref={buildingsRef}
        args={[undefined, undefined, BUILDING_COUNT]}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          color={minimalFrames ? '#101c2e' : '#0b1120'}
          roughness={0.9}
          metalness={0.1}
          transparent={minimalFrames}
          opacity={minimalFrames ? 0.28 : 1}
          depthWrite={!minimalFrames}
        />
      </instancedMesh>

      {/* 城市发光窗点(供 Bloom) */}
      <instancedMesh ref={windowsRef} args={[undefined, undefined, Math.max(1, cityData.windows.length)]}>
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial
          color="#ffd98f"
          emissive="#ffd98f"
          emissiveIntensity={minimalFrames ? 0.72 : 1.8}
          transparent={minimalFrames}
          opacity={minimalFrames ? 0.46 : 1}
          toneMapped={false}
        />
      </instancedMesh>

      {/* 半透明玻璃幕墙(整面) */}
      {!minimalFrames && (
        <>
          <mesh position={[0, WALL_H / 2, GLASS_Z]}>
            <planeGeometry args={[WALL_W, WALL_H]} />
            <meshStandardMaterial
              color="#9fd8e6"
              transparent
              opacity={0.12}
              metalness={0.6}
              roughness={0.15}
              depthWrite={false}
            />
          </mesh>

          {/* 顶/底横向窗框 */}
          <mesh position={[0, WALL_H - 0.06, GLASS_Z]}>
            <boxGeometry args={[WALL_W + 0.2, 0.14, 0.16]} />
            <meshStandardMaterial color="#20242c" metalness={0.7} roughness={0.4} />
          </mesh>
          <mesh position={[0, 0.06, GLASS_Z]}>
            <boxGeometry args={[WALL_W + 0.2, 0.14, 0.16]} />
            <meshStandardMaterial color="#20242c" metalness={0.7} roughness={0.4} />
          </mesh>

          {/* 竖向窗框(instancedMesh 复用) */}
          <instancedMesh
            ref={mullionsRef}
            args={[undefined, undefined, mullionXs.length]}
          >
            <boxGeometry args={[0.08, WALL_H, 0.14]} />
            <meshStandardMaterial color="#20242c" metalness={0.7} roughness={0.4} />
          </instancedMesh>
        </>
      )}

      {/* 底部青色氛围灯带(点缀,发光) */}
      <mesh position={[0, 0.11, GLASS_Z + 0.02]}>
        <boxGeometry args={[minimalFrames ? WALL_W * 0.55 : WALL_W, minimalFrames ? 0.014 : 0.03, 0.02]} />
        <meshStandardMaterial
          color="#8fe9ff"
          emissive="#8fe9ff"
          emissiveIntensity={minimalFrames ? 0.32 : 2.2}
          transparent={minimalFrames}
          opacity={minimalFrames ? 0.28 : 1}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}
