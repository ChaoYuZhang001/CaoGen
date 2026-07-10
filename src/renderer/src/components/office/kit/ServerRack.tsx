import { useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import { Color, Matrix4, Vector3 } from 'three'
import type { InstancedMesh, WebGLProgramParametersWithUniforms } from 'three'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

// LED 阵列:每层一排,共 SHELVES 层 × LEDS_PER_ROW 个
const SHELVES = 5
const LEDS_PER_ROW = 6
const LED_COUNT = SHELVES * LEDS_PER_ROW

// 机柜尺寸(米)
const RACK_W = 0.8
const RACK_H = 1.9
const RACK_D = 0.7

// 设备层竖直区间
const SHELF_TOP = 1.72
const SHELF_BOTTOM = 0.2
const SHELF_STEP = (SHELF_TOP - SHELF_BOTTOM) / (SHELVES - 1)

interface LedParam {
  speed: number
  off: number
  base: number
  hue: number
}

/**
 * three 把 instancedMesh 的实例色接到 vColor,默认只乘 diffuse(color_fragment)。
 * 这里用 onBeforeCompile 把 vColor 追加乘进 totalEmissiveRadiance,让每颗 LED 的
 * 实例色直接驱动 emissive,从而配合 Bloom 产生逐颗随机明灭的辉光。
 * 用 #ifdef USE_COLOR 包裹:首帧 instanceColor 尚未创建(USE_COLOR 未定义)时跳过该行,
 * 避免引用未声明的 vColor 导致 GLSL 编译失败;实例色创建后 three 会自动重编译并生效。
 */
function emissiveFromInstanceColor(shader: WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    ['#include <emissivemap_fragment>', '#ifdef USE_COLOR', '\ttotalEmissiveRadiance *= vColor;', '#endif'].join('\n')
  )
}

/**
 * 服务器机架:黑色机柜 + 多层设备 + 一排随机明灭的发光 LED。
 * LED 用 instancedMesh 复用几何体,useFrame 每帧改写实例色驱动 emissive 强度做随机闪烁。
 * 发光材质 toneMapped={false} 以配合 Bloom。
 */
export default function ServerRack({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  const ledsRef = useRef<InstancedMesh>(null)

  const ledParams = useMemo<LedParam[]>(() => {
    const arr: LedParam[] = []
    for (let i = 0; i < LED_COUNT; i++) {
      arr.push({
        speed: 2.4 + ((i * 1.37) % 4),
        off: (i * 0.61) % 1,
        base: 0.25 + ((i * 0.29) % 1) * 0.4,
        // 冷灰青状态灯,避免绿色/暖色在办公区抢视觉。
        hue: i % 7 === 0 ? 0 : i % 5 === 0 ? 1 : 2
      })
    }
    return arr
  }, [])

  // LED 静态局部位置(每层一排)
  const ledPositions = useMemo<Vector3[]>(() => {
    const out: Vector3[] = []
    for (let s = 0; s < SHELVES; s++) {
      const y = SHELF_BOTTOM + s * SHELF_STEP + 0.03
      for (let c = 0; c < LEDS_PER_ROW; c++) {
        const x = -0.28 + (c / (LEDS_PER_ROW - 1)) * 0.56
        out.push(new Vector3(x, y, RACK_D / 2 + 0.006))
      }
    }
    return out
  }, [])

  const shelfYs = useMemo<number[]>(() => {
    const ys: number[] = []
    for (let s = 0; s < SHELVES; s++) ys.push(SHELF_BOTTOM + s * SHELF_STEP)
    return ys
  }, [])

  // 复用对象(闭包外),避免 useFrame 内 new
  const tmpMatrix = useMemo(() => new Matrix4(), [])
  const tmpColor = useMemo(() => new Color(), [])
  const cyan = useMemo(() => new Color('#8fe9ff'), [])
  const slate = useMemo(() => new Color('#6f8fa0'), [])
  const dim = useMemo(() => new Color('#516071'), [])

  // 实例矩阵一次性写入(位置固定);同时预置实例色以提前触发 USE_COLOR 分支
  useLayoutEffect(() => {
    const mesh = ledsRef.current
    if (!mesh) return
    for (let i = 0; i < LED_COUNT; i++) {
      const p = ledPositions[i]
      tmpMatrix.makeTranslation(p.x, p.y, p.z)
      mesh.setMatrixAt(i, tmpMatrix)
      mesh.setColorAt(i, tmpColor.copy(cyan).multiplyScalar(0.3))
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [ledPositions, tmpMatrix, tmpColor, cyan])

  useFrame((state) => {
    const mesh = ledsRef.current
    if (!mesh) return
    const t = state.clock.getElapsedTime()
    for (let i = 0; i < LED_COUNT; i++) {
      const p = ledParams[i]
      // 双正弦叠加取阈值:产生断续的"明灭"观感
      const wave = Math.sin(t * p.speed + p.off * Math.PI * 2)
      const flick = Math.sin(t * (p.speed * 2.3) + p.off * 5.1)
      const on = wave + flick * 0.5 > -0.2
      const k = on ? p.base + (0.5 + wave * 0.5) * 1.6 : 0.06
      const src = p.hue === 0 ? slate : p.hue === 1 ? cyan : dim
      mesh.setColorAt(i, tmpColor.copy(src).multiplyScalar(k))
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 机柜主体外壳(黑) */}
      <RoundedBox args={[RACK_W, RACK_H, RACK_D]} radius={0.045} smoothness={4} position={[0, RACK_H / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#141414" metalness={0.55} roughness={0.5} />
      </RoundedBox>

      {/* 内腔凹陷设备井 */}
      <mesh position={[0, RACK_H / 2, RACK_D / 2 - 0.02]}>
        <boxGeometry args={[RACK_W - 0.12, RACK_H - 0.14, 0.04]} />
        <meshStandardMaterial color="#0c0c0c" metalness={0.3} roughness={0.8} />
      </mesh>

      {/* 底座 */}
      <RoundedBox args={[RACK_W + 0.06, 0.06, RACK_D + 0.06]} radius={0.025} smoothness={3} position={[0, 0.03, 0]} receiveShadow>
        <meshStandardMaterial color="#1c1c1c" metalness={0.4} roughness={0.6} />
      </RoundedBox>

      {/* 多层设备:金属面板 + 冷灰高光条 + 通风缝 */}
      {shelfYs.map((y, s) => (
        <group key={s} position={[0, y, RACK_D / 2 - 0.01]}>
          <RoundedBox args={[RACK_W - 0.1, SHELF_STEP * 0.62, 0.06]} radius={0.018} smoothness={3} castShadow>
            <meshStandardMaterial color="#22262c" metalness={0.6} roughness={0.4} />
          </RoundedBox>
          <mesh position={[0.24, 0, 0.032]}>
            <boxGeometry args={[0.06, SHELF_STEP * 0.4, 0.01]} />
            <meshStandardMaterial color="#8fa0ac" metalness={0.28} roughness={0.42} />
          </mesh>
          <mesh position={[-0.08, 0, 0.032]}>
            <boxGeometry args={[0.26, SHELF_STEP * 0.16, 0.008]} />
            <meshStandardMaterial color="#0a0a0a" roughness={0.9} />
          </mesh>
        </group>
      ))}

      {/* 一排闪烁 LED(instancedMesh,实例色驱动 emissive,供 Bloom) */}
      <instancedMesh ref={ledsRef} args={[undefined, undefined, LED_COUNT]}>
        <boxGeometry args={[0.028, 0.014, 0.012]} />
        <meshStandardMaterial
          color="#111111"
          emissive="#8fe9ff"
          emissiveIntensity={1.6}
          toneMapped={false}
          onBeforeCompile={emissiveFromInstanceColor}
        />
      </instancedMesh>
    </group>
  )
}
