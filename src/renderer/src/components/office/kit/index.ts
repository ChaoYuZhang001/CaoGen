// office/kit 统一出口:重导出全部 kit 模块。
// 说明:多数视觉道具各自 `export interface OfficeProp`(结构一致),此处
// 只从一个规范来源(Floor)重导出 OfficeProp,避免同名类型冲突。

// ---- 共享道具属性(规范来源)----
export type { OfficeProp } from './Floor'

// ---- 建筑外壳 ----
export { default as Floor } from './Floor'
export { default as Walls } from './Walls'
export { default as WindowWall } from './WindowWall'
export { default as Ceiling } from './Ceiling'

// ---- 家具 / 陈设道具 ----
export { default as AreaRug } from './AreaRug'
export { default as LoungeSofa } from './LoungeSofa'
export { default as MeetingTable } from './MeetingTable'
export { default as Bookshelf } from './Bookshelf'
export { default as Whiteboard } from './Whiteboard'
export { default as ServerRack } from './ServerRack'
export { default as CoffeeStation } from './CoffeeStation'
export { default as Plant } from './Plant'

// ---- 工位构件 ----
export { default as Desk } from './Desk'
export { default as OfficeChair } from './OfficeChair'
export { default as MonitorSetup } from './MonitorSetup'
export { default as DeskAccessories } from './DeskAccessories'
export { default as DeskLamp } from './DeskLamp'
export { default as SpeechBubble } from './SpeechBubble'

// ---- Agent 小人 + 动画 ----
export { default as AvatarRig } from './AvatarRig'
export type { AvatarRefs } from './AvatarRig'
export {
  applyIdle,
  applyTyping,
  applyWalking,
  applyTalking,
  applyThinking
} from './AvatarAnimations'
export type { AnimOptions } from './AvatarAnimations'
export { useWalker } from './AvatarWalk'
export type { Walker } from './AvatarWalk'

// ---- 厂商皮肤 ----
export { vendorSkin, VENDOR_SKINS } from './VendorSkins'
export type { VendorSkin } from './VendorSkins'

// ---- 场景 / 灯光 / 相机 / 后处理 / 氛围 ----
export { default as OfficeScene } from './OfficeScene'
export { default as WorkstationPro } from './WorkstationPro'
export type { WorkstationActivity } from './WorkstationPro'
export { default as LightingRig } from './LightingRig'
export type { LightingRigProps } from './LightingRig'
export { default as CameraRig } from './CameraRig'
export { default as PostFX } from './PostFX'
export { default as DustMotes } from './DustMotes'

// ---- 组合根 ----
export { default as OfficeSceneRoot } from './OfficeSceneRoot'
export type { OfficeSceneRootProps, StationSpec } from './OfficeSceneRoot'
