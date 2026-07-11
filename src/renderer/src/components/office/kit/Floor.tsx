import { useMemo } from 'react'
import { Color } from 'three'

/** 视觉道具通用入参:位置/旋转/缩放 */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

interface FloorProps extends OfficeProp {
  /** 地板边长(米),默认 40 */
  size?: number
  /** 是否绘制浅色接缝网格,默认 true */
  seams?: boolean
  /** 基础地板色,默认深灰 */
  color?: string
  /** 主/次接缝颜色,用于白天与夜间主题分别保持可读对比。 */
  seamMainColor?: string
  seamSubColor?: string
}

const DEFAULT_SIZE = 40
const DEFAULT_COLOR = '#181818'
const SEAM_MAIN = '#2a2a2a'
const SEAM_SUB = '#1c1c1c'

/**
 * 大地面:略带反射/磨砂质感的深灰地板。
 * meshStandardMaterial(metalness 偏低 + roughness 偏高)营造写实磨砂反射,
 * 可选浅色接缝网格用 gridHelper 生成(纯代码,无外部 asset)。
 * 接收地面阴影(receiveShadow),配合 OfficeView 的接触阴影/辉光整体统一。
 */
export default function Floor({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  size = DEFAULT_SIZE,
  seams = true,
  color = DEFAULT_COLOR,
  seamMainColor = SEAM_MAIN,
  seamSubColor = SEAM_SUB
}: FloorProps): React.JSX.Element {
  // 每米一格接缝;闭包外复用 Color,避免每帧/每次渲染 new
  const divisions = useMemo(() => Math.max(1, Math.round(size)), [size])
  const seamMain = useMemo(() => new Color(seamMainColor), [seamMainColor])
  const seamSub = useMemo(() => new Color(seamSubColor), [seamSubColor])

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 地板本体:平铺于 XZ 平面,朝上接收阴影 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color={color} metalness={0.35} roughness={0.72} />
      </mesh>

      {/* 浅色接缝网格(略微抬高避免 z-fighting) */}
      {seams && (
        <gridHelper args={[size, divisions, seamMain, seamSub]} position={[0, 0.002, 0]} />
      )}
    </group>
  )
}
