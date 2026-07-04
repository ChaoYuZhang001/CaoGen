import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3 } from 'three'

export interface Walker {
  /** 当前世界坐标(每帧原地更新的稳定 Vector3;在你自己的 useFrame 里 group.position.copy 它) */
  position: Vector3
  /** 朝向:绕 Y 轴的弧度,使小人的 -Z 前脸指向行进方向(与本项目"朝 -Z 面向桌子"约定一致) */
  facing: number
  /** 是否已抵达终点 */
  arrived: boolean
}

type Vec3 = [number, number, number]

/** 平滑缓动(smoothstep):在起终点处减速,中段匀速,行走更自然 */
function smoothstep(x: number): number {
  const c = x < 0 ? 0 : x > 1 ? 1 : x
  return c * c * (3 - 2 * c)
}

/**
 * 两点间行走工具 hook。
 *
 * 用 useFrame 按 speed(米/秒)沿直线从 from 缓动插值到 to,输出当前坐标、朝向与抵达状态。
 * 纯逻辑 hook:不渲染任何东西,须在 <Canvas> 组件树内调用(依赖 useFrame)。
 * position 是原地更新的稳定 Vector3(不触发 re-render),请在调用方的 useFrame 内读取并 copy。
 *
 * @param from  起点 [x,y,z]
 * @param to    终点 [x,y,z]
 * @param speed 行走速度(米/秒),<=0 时静止
 */
export function useWalker(from: Vec3, to: Vec3, speed: number): Walker {
  // 以数值维度记忆,避免每次渲染传入新数组导致重复计算
  const fromVec = useMemo(() => new Vector3(from[0], from[1], from[2]), [from[0], from[1], from[2]])
  const toVec = useMemo(() => new Vector3(to[0], to[1], to[2]), [to[0], to[1], to[2]])

  const distance = useMemo(() => fromVec.distanceTo(toVec), [fromVec, toVec])

  // 朝向在直线行走中恒定,可记忆(距离为 0 时无方向,回退 0)
  const facing = useMemo(() => {
    const dx = toVec.x - fromVec.x
    const dz = toVec.z - fromVec.z
    if (dx === 0 && dz === 0) return 0
    // -Z 为前脸:令旋转后的 (0,0,-1) 指向 (dx,dz)
    return Math.atan2(-dx, -dz)
  }, [fromVec, toVec])

  // 稳定的输出向量,每帧原地更新
  const position = useMemo(() => fromVec.clone(), [fromVec])
  // 归一化进度 [0,1],用 ref 保存以免每帧 setState
  const progressRef = useRef(0)
  const [arrived, setArrived] = useState(distance === 0)

  // from/to 变化时重置进度与抵达状态,并把当前位置对齐到新起点
  useEffect(() => {
    progressRef.current = 0
    position.copy(fromVec)
    setArrived(distance === 0)
  }, [fromVec, toVec, distance, position])

  useFrame((_, delta) => {
    if (progressRef.current >= 1 || distance === 0) {
      if (progressRef.current < 1) progressRef.current = 1
      position.copy(toVec)
      return
    }
    if (speed > 0) {
      // 按世界距离推进进度,保证 speed 为米/秒
      progressRef.current = Math.min(1, progressRef.current + (speed * delta) / distance)
    }
    const eased = smoothstep(progressRef.current)
    position.copy(fromVec).lerp(toVec, eased)
    if (progressRef.current >= 1 && !arrived) setArrived(true)
  })

  return { position, facing, arrived }
}
