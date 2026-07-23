import LightingRig from './LightingRig'
import OfficeScene from './OfficeScene'
import WorkstationPro from './WorkstationPro'
import CameraRig from './CameraRig'
import PostFX from './PostFX'
import type { WorkstationActivity } from './WorkstationPro'

/** 单个工位的完整描述:位置 + 状态 + 展示信息 */
export interface StationSpec {
  id: string
  position: [number, number, number]
  active: boolean
  activity: WorkstationActivity
  title: string
  costUsd: number
  brandName?: string
  onSelect: () => void
}

export interface OfficeSceneRootProps {
  /** 铺开的工位清单(位置由调用方按网格计算) */
  stations: StationSpec[]
  /** true=白天冷白日光,false=夜间低照度氛围 */
  light: boolean
}

/**
 * 办公区场景组合根:把布景、工位、灯光、相机与后处理一次性拼装。
 * 必须在外层 <Canvas> 内渲染(本组件不含 Canvas)。
 *
 * 组成:
 * - LightingRig(day/night 由 light 决定)
 * - OfficeScene 布景层(墙/地/家具,中央留空给工位网格)
 * - stations.map -> WorkstationPro(逐个工位)
 * - CameraRig 自动环绕相机(封装 OrbitControls)
 * - PostFX 后处理栈(Bloom/Vignette/SMAA)
 */
export default function OfficeSceneRoot({
  stations,
  light
}: OfficeSceneRootProps): React.JSX.Element {
  return (
    <>
      <LightingRig mode={light ? 'day' : 'night'} />

      <OfficeScene />

      {stations.map((s) => (
        <WorkstationPro
          key={s.id}
          sessionId={s.id}
          position={s.position}
          active={s.active}
          activity={s.activity}
          title={s.title}
          costUsd={s.costUsd}
          brandName={s.brandName}
          onSelect={s.onSelect}
        />
      ))}

      <CameraRig auto />

      <PostFX light={light} />
    </>
  )
}
