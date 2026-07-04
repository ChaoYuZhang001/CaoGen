import { useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Object3D } from 'three'
import type { InstancedMesh, Mesh, MeshStandardMaterial, Points } from 'three'

/** 视觉道具通用入参:相对办公桌面摆放。 */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

// ---- 配色(主黑副白,克制;强调用青) ----
const C_KEYBOARD = '#1b1e25'
const C_KEY = '#2b3039'
const C_MOUSE = '#23272f'
const C_MUG = '#f2f2f2'
const C_COFFEE = '#2a1912'
const C_NOTE_COVER = '#20232b'
const C_NOTE_PAPER = '#e9e3d3'
const C_METAL = '#8a909c'
const C_PEN = '#3a4150'
const ACCENT = '#8fe9ff'

// 键盘按键网格
const KEY_COLS = 11
const KEY_ROWS = 4
const KEY_COUNT = KEY_COLS * KEY_ROWS
const KEY_PITCH_X = 0.036
const KEY_PITCH_Z = 0.036
const KEY_SIZE = 0.03

// 咖啡蒸汽粒子
const STEAM_COUNT = 10

/**
 * 桌面小物合集:键盘(实例化按键)、鼠标、马克杯(带蒸汽)、笔记本 + 笔 + 便签。
 * 低多边形、几何体代码生成;发光件配合 Bloom(toneMapped=false)。
 * 摆放基准:自身原点位于桌面上,y=0 即桌面;-Z 为面向屏幕方向。
 */
export default function DeskAccessories({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  const keysRef = useRef<InstancedMesh>(null)
  const ledRef = useRef<Mesh>(null)
  const steamRef = useRef<Points>(null)

  // 闭包外复用,避免 useFrame 内 new
  const dummy = useMemo(() => new Object3D(), [])

  // 键盘按键的初始随机偏移(高度微扰,增强低多边形手感)
  const keyJitter = useMemo(() => {
    const arr = new Float32Array(KEY_COUNT)
    for (let i = 0; i < KEY_COUNT; i++) arr[i] = ((i * 37) % 5) * 0.0008
    return arr
  }, [])

  // 蒸汽粒子:缓冲区 + 每颗相位/速度
  const steamPositions = useMemo(() => new Float32Array(STEAM_COUNT * 3), [])
  const steamData = useMemo(() => {
    const arr: Array<{ x: number; z: number; speed: number; off: number }> = []
    for (let i = 0; i < STEAM_COUNT; i++) {
      arr.push({
        x: (((i * 13) % 7) - 3) * 0.006,
        z: (((i * 29) % 7) - 3) * 0.006,
        speed: 0.3 + (i % 4) * 0.08,
        off: (i * 0.41) % 1
      })
    }
    return arr
  }, [])

  // 一次性写入按键实例矩阵
  useLayoutEffect(() => {
    const inst = keysRef.current
    if (!inst) return
    let i = 0
    for (let r = 0; r < KEY_ROWS; r++) {
      for (let c = 0; c < KEY_COLS; c++) {
        const x = (c - (KEY_COLS - 1) / 2) * KEY_PITCH_X
        const z = (r - (KEY_ROWS - 1) / 2) * KEY_PITCH_Z
        dummy.position.set(x, 0.012 + keyJitter[i], z)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(1, 1, 1)
        dummy.updateMatrix()
        inst.setMatrixAt(i, dummy.matrix)
        i++
      }
    }
    inst.instanceMatrix.needsUpdate = true
  }, [dummy, keyJitter])

  useFrame((state) => {
    const t = state.clock.getElapsedTime()

    // 待机 LED 呼吸(青色发光)
    if (ledRef.current) {
      const mat = ledRef.current.material as MeshStandardMaterial
      mat.emissiveIntensity = 1.4 + Math.sin(t * 2.2) * 0.7
    }

    // 咖啡蒸汽缓缓上升 + 轻微摆动,循环复用
    const steam = steamRef.current
    if (steam) {
      const posAttr = steam.geometry.attributes.position
      for (let i = 0; i < STEAM_COUNT; i++) {
        const d = steamData[i]
        const local = (t * d.speed + d.off) % 1
        const y = 0.11 + local * 0.22
        const sway = Math.sin((t + i) * 1.6) * 0.012 * local
        posAttr.setXYZ(i, d.x + sway, y, d.z + sway * 0.5)
      }
      posAttr.needsUpdate = true
      const pm = steam.material as MeshStandardMaterial & { opacity: number }
      pm.opacity = 0.18 + Math.abs(Math.sin(t * 0.8)) * 0.12
    }
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* ---- 键盘 ---- */}
      <group position={[0, 0, 0.12]}>
        <mesh castShadow receiveShadow position={[0, 0.008, 0]}>
          <boxGeometry args={[0.44, 0.016, 0.17]} />
          <meshStandardMaterial color={C_KEYBOARD} metalness={0.3} roughness={0.7} />
        </mesh>
        <instancedMesh ref={keysRef} args={[undefined, undefined, KEY_COUNT]} castShadow>
          <boxGeometry args={[KEY_SIZE, 0.01, KEY_SIZE]} />
          <meshStandardMaterial color={C_KEY} metalness={0.15} roughness={0.75} />
        </instancedMesh>
        {/* 待机指示灯(青,供 Bloom) */}
        <mesh ref={ledRef} position={[0.19, 0.017, -0.07]}>
          <sphereGeometry args={[0.006, 8, 8]} />
          <meshStandardMaterial
            color={ACCENT}
            emissive={ACCENT}
            emissiveIntensity={1.6}
            toneMapped={false}
          />
        </mesh>
      </group>

      {/* ---- 鼠标 ---- */}
      <group position={[0.31, 0, 0.14]}>
        <mesh castShadow position={[0, 0.014, 0]} scale={[1, 0.6, 1.5]}>
          <sphereGeometry args={[0.028, 16, 16]} />
          <meshStandardMaterial color={C_MOUSE} metalness={0.25} roughness={0.65} />
        </mesh>
        {/* 滚轮缝隙(细发光条) */}
        <mesh position={[0, 0.03, 0.006]}>
          <boxGeometry args={[0.003, 0.003, 0.014]} />
          <meshStandardMaterial
            color={ACCENT}
            emissive={ACCENT}
            emissiveIntensity={1.2}
            toneMapped={false}
          />
        </mesh>
      </group>

      {/* ---- 马克杯 ---- */}
      <group position={[-0.32, 0, 0.06]}>
        <mesh castShadow receiveShadow position={[0, 0.055, 0]}>
          <cylinderGeometry args={[0.05, 0.045, 0.11, 32]} />
          <meshStandardMaterial color={C_MUG} metalness={0.1} roughness={0.5} />
        </mesh>
        {/* 咖啡液面 */}
        <mesh position={[0, 0.104, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.044, 32]} />
          <meshStandardMaterial color={C_COFFEE} metalness={0.2} roughness={0.35} />
        </mesh>
        {/* 把手 */}
        <mesh position={[0.055, 0.055, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.028, 0.008, 12, 24, Math.PI * 1.2]} />
          <meshStandardMaterial color={C_MUG} metalness={0.1} roughness={0.5} />
        </mesh>
        {/* 蒸汽(发光点,供 Bloom) */}
        <points ref={steamRef}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[steamPositions, 3]}
              count={STEAM_COUNT}
            />
          </bufferGeometry>
          <pointsMaterial
            color="#f4f4f4"
            size={0.02}
            sizeAttenuation
            transparent
            opacity={0.25}
            depthWrite={false}
            toneMapped={false}
          />
        </points>
      </group>

      {/* ---- 笔记本 + 笔 + 便签 ---- */}
      <group position={[-0.02, 0, -0.13]} rotation={[0, 0.28, 0]}>
        {/* 封面 */}
        <mesh castShadow receiveShadow position={[0, 0.008, 0]}>
          <boxGeometry args={[0.16, 0.016, 0.21]} />
          <meshStandardMaterial color={C_NOTE_COVER} metalness={0.15} roughness={0.8} />
        </mesh>
        {/* 纸页(略小,露出白边) */}
        <mesh position={[0.004, 0.017, 0]}>
          <boxGeometry args={[0.148, 0.006, 0.198]} />
          <meshStandardMaterial color={C_NOTE_PAPER} metalness={0} roughness={0.9} />
        </mesh>
        {/* 线圈装订 */}
        <mesh position={[-0.082, 0.012, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.006, 0.006, 0.2, 12]} />
          <meshStandardMaterial color={C_METAL} metalness={0.8} roughness={0.3} />
        </mesh>
        {/* 笔 */}
        <mesh position={[0.03, 0.024, 0.02]} rotation={[0, 0.5, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.006, 0.006, 0.14, 12]} />
          <meshStandardMaterial color={C_PEN} metalness={0.4} roughness={0.5} />
        </mesh>
        <mesh position={[0.096, 0.024, -0.017]} rotation={[0, 0.5, Math.PI / 2]}>
          <coneGeometry args={[0.006, 0.02, 12]} />
          <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={0.6} toneMapped={false} />
        </mesh>
      </group>

      {/* ---- 便签纸小堆 ---- */}
      <group position={[0.28, 0, -0.1]} rotation={[0, -0.35, 0]}>
        <mesh castShadow position={[0, 0.006, 0]}>
          <boxGeometry args={[0.08, 0.012, 0.08]} />
          <meshStandardMaterial color={C_NOTE_PAPER} metalness={0} roughness={0.95} />
        </mesh>
        <mesh position={[0.006, 0.014, -0.006]} rotation={[0, 0.15, 0]}>
          <boxGeometry args={[0.078, 0.004, 0.078]} />
          <meshStandardMaterial color="#f4f4f4" metalness={0} roughness={0.95} />
        </mesh>
      </group>
    </group>
  )
}
