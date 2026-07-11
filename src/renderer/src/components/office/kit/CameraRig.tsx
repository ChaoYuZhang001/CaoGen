import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Vector3 } from 'three'
import type { ComponentRef } from 'react'

interface Props {
  /** 相机位置(世界坐标);传入后随预设平滑移动 */
  position?: [number, number, number]
  /** 相机聚焦点(世界坐标);默认舞台中心略高 */
  target?: [number, number, number]
  /** 是否缓慢自动环绕 */
  auto?: boolean
  /** 允许近景预设靠近目标；总览仍可传入更保守的距离 */
  minDistance?: number
  /** 用户缩放的最远距离 */
  maxDistance?: number
}

/**
 * 电影感相机:封装 OrbitControls + 缓慢自动环绕 + 平滑聚焦 target。
 * 目标点每帧向传入 target 做 lerp,切换聚焦对象时相机平顺过渡,不生硬跳切。
 */
export default function CameraRig({
  position,
  target,
  auto = true,
  minDistance = 5.5,
  maxDistance = 22
}: Props): React.JSX.Element {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)

  // 闭包外复用:期望聚焦点 + 临时向量,避免 useFrame 内 new 对象
  const desired = useMemo(() => new Vector3(0, 0.6, 0), [])
  const desiredPosition = useMemo(() => new Vector3(0.28, 4.58, 9.28), [])

  // 传入 target 变化时,只更新期望向量;实际过渡在 useFrame 中平滑完成
  useMemo(() => {
    if (target) desired.set(target[0], target[1], target[2])
    else desired.set(0, 0.6, 0)
  }, [target, desired])
  useMemo(() => {
    if (position) desiredPosition.set(position[0], position[1], position[2])
    else desiredPosition.set(0.28, 4.58, 9.28)
  }, [position, desiredPosition])

  useFrame((_, delta) => {
    const controls = controlsRef.current
    if (!controls) return
    // 帧率无关的平滑逼近:每帧向期望点 lerp
    const a = 1 - Math.pow(0.001, delta)
    controls.object.position.lerp(desiredPosition, a)
    controls.target.lerp(desired, a)
    controls.update()
  })

  return (
    <OrbitControls
      ref={controlsRef}
      enablePan={false}
      minDistance={minDistance}
      maxDistance={maxDistance}
      maxPolarAngle={Math.PI / 2.2}
      enableDamping
      dampingFactor={0.08}
      autoRotate={auto}
      autoRotateSpeed={0.35}
    />
  )
}
