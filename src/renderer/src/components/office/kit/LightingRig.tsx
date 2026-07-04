import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color } from 'three'
import type { DirectionalLight } from 'three'

export interface LightingRigProps {
  /** day:冷白高对比日光;night:低照度暖橙 + 强边缘光 */
  mode?: 'day' | 'night'
}

interface Preset {
  ambientColor: string
  ambientIntensity: number
  keyColor: string
  keyIntensity: number
  keyPos: [number, number, number]
  fillColor: string
  fillIntensity: number
  fillPos: [number, number, number]
  rimColor: string
  rimIntensity: number
  rimPos: [number, number, number]
}

const PRESETS: Record<'day' | 'night', Preset> = {
  day: {
    // 冷白高照度、硬阴影
    ambientColor: '#dfe7f0',
    ambientIntensity: 0.65,
    keyColor: '#fff6ea',
    keyIntensity: 1.35,
    keyPos: [7, 13, 6],
    fillColor: '#bcd0ff',
    fillIntensity: 0.4,
    fillPos: [-8, 6, -5],
    rimColor: '#8fe9ff',
    rimIntensity: 0.55,
    rimPos: [-3, 7, -9]
  },
  night: {
    // 低照度暖橙、青色边缘光强化轮廓
    ambientColor: '#2a3346',
    ambientIntensity: 0.32,
    keyColor: '#ffd6a3',
    keyIntensity: 0.85,
    keyPos: [6, 11, 5],
    fillColor: '#4a5a80',
    fillIntensity: 0.3,
    fillPos: [-7, 5, -5],
    rimColor: '#8fe9ff',
    rimIntensity: 1.1,
    rimPos: [-3, 6, -9]
  }
}

/**
 * 整套办公区灯光:环境光 + 带阴影的主平行光(key)+ 冷补光(fill)+ 边缘光(rim)。
 * day/night 两套强度与色温,切换时平滑过渡(useFrame 内 lerp,避免生硬跳变)。
 * 需渲染在 <Canvas> 内。
 */
export default function LightingRig({ mode = 'night' }: LightingRigProps): React.JSX.Element {
  const preset = PRESETS[mode]

  const keyRef = useRef<DirectionalLight>(null)
  const fillRef = useRef<DirectionalLight>(null)
  const rimRef = useRef<DirectionalLight>(null)

  // 目标色/强度(闭包外复用,不在 useFrame 内 new)
  const targetKey = useMemo(() => new Color(preset.keyColor), [preset.keyColor])
  const targetFill = useMemo(() => new Color(preset.fillColor), [preset.fillColor])
  const targetRim = useMemo(() => new Color(preset.rimColor), [preset.rimColor])

  useFrame(() => {
    const key = keyRef.current
    if (key) {
      key.color.lerp(targetKey, 0.06)
      key.intensity += (preset.keyIntensity - key.intensity) * 0.06
    }
    const fill = fillRef.current
    if (fill) {
      fill.color.lerp(targetFill, 0.06)
      fill.intensity += (preset.fillIntensity - fill.intensity) * 0.06
    }
    const rim = rimRef.current
    if (rim) {
      rim.color.lerp(targetRim, 0.06)
      rim.intensity += (preset.rimIntensity - rim.intensity) * 0.06
    }
  })

  return (
    <group>
      {/* 环境光:整体底照,day/night 直接切换(无阴影,平滑度不敏感) */}
      <ambientLight color={preset.ambientColor} intensity={preset.ambientIntensity} />

      {/* 主平行光(key):唯一投射阴影的灯 */}
      <directionalLight
        ref={keyRef}
        color={preset.keyColor}
        intensity={preset.keyIntensity}
        position={preset.keyPos}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-camera-near={0.5}
        shadow-camera-far={40}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
      />

      {/* 冷补光(fill):抬起阴影侧,消解死黑 */}
      <directionalLight
        ref={fillRef}
        color={preset.fillColor}
        intensity={preset.fillIntensity}
        position={preset.fillPos}
      />

      {/* 边缘光(rim):从后侧勾勒轮廓,night 下更强以突出剪影 */}
      <directionalLight
        ref={rimRef}
        color={preset.rimColor}
        intensity={preset.rimIntensity}
        position={preset.rimPos}
      />
    </group>
  )
}
