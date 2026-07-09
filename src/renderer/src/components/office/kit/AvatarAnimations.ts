import type { Object3D } from 'three'

/**
 * Avatar 骨架引用:与 AvatarRig 组件保持一致的关节集合。
 * 全部允许 null/undefined —— 挂载前/条件渲染时 ref 尚未就绪。
 */
export interface AvatarRefs {
  root?: Object3D | null
  head?: Object3D | null
  armL?: Object3D | null
  armR?: Object3D | null
  legL?: Object3D | null
  legR?: Object3D | null
}

/** 动作可选参数:强度/速度倍率与相位偏移(供多个 avatar 错峰) */
export interface AnimOptions {
  /** 活跃度倍率:整体幅度与频率随之缩放(默认 1) */
  liveliness?: number
  /** 相位偏移(秒):让同类 avatar 动作不同步(默认 0) */
  phase?: number
  /** 机器人本地 +Z 正面朝向(弧度),叠加到 root.rotation.y(默认 0) */
  facing?: number
}

/**
 * 纯函数动画库:接收 AvatarRefs 与时间 t,直接写 rotation/position 产生动作。
 * 无 JSX / 无组件 / 无 hooks —— 仅在调用方的 useFrame 内被调用。
 * 每次调用会为涉及的关节设置一个完整姿态(而非增量累加),因此可安全逐帧重复调用。
 *
 * 约定:root.position.y 为离地高度(y=0 为站立基准),head/arm/leg 均为相对局部旋转。
 */

// —— 复用常量,避免闭包内分配 —— //
const TAU = Math.PI * 2
const JOINT_LERP = 0.1

function amp(opts: AnimOptions | undefined): number {
  return opts?.liveliness ?? 1
}

function time(t: number, opts: AnimOptions | undefined): number {
  return t + (opts?.phase ?? 0)
}

/** 复位关节到中性姿态的辅助(仅对存在的关节写入) */
function neutralLimbs(refs: AvatarRefs): void {
  if (refs.armL) refs.armL.rotation.set(0, 0, 0)
  if (refs.armR) refs.armR.rotation.set(0, 0, 0)
  if (refs.legL) refs.legL.rotation.set(0, 0, 0)
  if (refs.legR) refs.legR.rotation.set(0, 0, 0)
}

function applyFacing(refs: AvatarRefs, opts: AnimOptions | undefined): void {
  const root = refs.root
  if (root && opts?.facing !== undefined) root.rotation.y = lerpAngle(root.rotation.y, opts.facing)
}

function lerpValue(current: number, target: number, factor = JOINT_LERP): number {
  return current + (target - current) * factor
}

function lerpAngle(current: number, target: number, factor = JOINT_LERP): number {
  let delta = target - current
  while (delta > Math.PI) delta -= TAU
  while (delta < -Math.PI) delta += TAU
  return current + delta * factor
}

function lerpRotation(obj: Object3D | null | undefined, x: number, y: number, z: number): void {
  if (!obj) return
  obj.rotation.x = lerpAngle(obj.rotation.x, x)
  obj.rotation.y = lerpAngle(obj.rotation.y, y)
  obj.rotation.z = lerpAngle(obj.rotation.z, z)
}

/**
 * 待机:轻微呼吸起伏 + 头部缓慢摆动,手臂自然垂放。
 */
export function applyIdle(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  const root = refs.root
  if (root) {
    root.position.y = lerpValue(root.position.y, Math.sin(tt * 1.6 * L) * 0.012)
    root.rotation.z = lerpAngle(root.rotation.z, 0)
  }
  lerpRotation(refs.head, 0.04 + Math.sin(tt * 1.2 * L) * 0.03, Math.sin(tt * 0.5 * L) * 0.12, Math.sin(tt * 0.8 * L) * 0.05)
  lerpRotation(refs.armL, Math.sin(tt * 1.6 * L) * 0.04, 0, 0.06)
  lerpRotation(refs.armR, Math.sin(tt * 1.6 * L + Math.PI) * 0.04, 0, -0.06)
  lerpRotation(refs.legL, 0, 0, 0)
  lerpRotation(refs.legR, 0, 0, 0)
  applyFacing(refs, opts)
}

/**
 * 值守控制台:适合 idle 工位。机器人不是休息,而是面向屏幕持续监控,
 * 双臂停在操作面板附近,头部做很小幅的扫描。
 */
export function applyMonitoring(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  const root = refs.root
  if (root) {
    root.position.y = lerpValue(root.position.y, Math.sin(tt * 1.25 * L) * 0.006)
    root.rotation.z = lerpAngle(root.rotation.z, Math.sin(tt * 0.7 * L) * 0.008)
  }
  lerpRotation(
    refs.head,
    0.16 + Math.sin(tt * 0.9 * L) * 0.018,
    Math.sin(tt * 0.45 * L) * 0.075,
    Math.sin(tt * 0.6 * L) * 0.015
  )
  lerpRotation(refs.armL, -0.68 + Math.sin(tt * 1.4 * L) * 0.035, 0, 0.1)
  lerpRotation(refs.armR, -0.72 + Math.cos(tt * 1.25 * L) * 0.035, 0, -0.1)
  lerpRotation(refs.legL, 0.02, 0, 0)
  lerpRotation(refs.legR, -0.02, 0, 0)
  applyFacing(refs, opts)
}

/**
 * 打字:双手在桌前快速交替敲击,身体微前倾并轻颤,头随节奏点动。
 */
export function applyTyping(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  const beat = tt * 16 * L
  const root = refs.root
  if (root) {
    root.position.y = lerpValue(root.position.y, Math.abs(Math.sin(tt * 8 * L)) * 0.02)
    root.rotation.z = lerpAngle(root.rotation.z, 0)
  }
  lerpRotation(refs.head, 0.22 + Math.sin(beat) * 0.05, Math.sin(tt * 2 * L) * 0.06, 0)
  // 手臂前伸至桌面(rotation.x 负值抬向前方),小幅交替敲击
  lerpRotation(refs.armL, -1.15 + Math.sin(beat) * 0.28, 0, 0.12)
  lerpRotation(refs.armR, -1.15 + Math.cos(beat) * 0.28, 0, -0.12)
  lerpRotation(refs.legL, 0, 0, 0)
  lerpRotation(refs.legR, 0, 0, 0)
  applyFacing(refs, opts)
}

/**
 * 行走:四肢对角摆动 + 身体上下起伏,root 仅做原地步态(位移由调用方控制)。
 */
export function applyWalking(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  const stride = tt * 6 * L
  const swing = Math.sin(stride)
  const root = refs.root
  if (root) {
    // 步伐落点时的双峰起伏
    root.position.y = lerpValue(root.position.y, Math.abs(Math.sin(stride)) * 0.06)
    root.rotation.z = lerpAngle(root.rotation.z, Math.sin(stride) * 0.03)
  }
  lerpRotation(refs.head, 0.06, 0, Math.sin(stride) * 0.04)
  // 对角摆动:左臂与右腿同相,右臂与左腿同相
  lerpRotation(refs.armL, swing * 0.6, 0, 0)
  lerpRotation(refs.armR, -swing * 0.6, 0, 0)
  lerpRotation(refs.legL, -swing * 0.7, 0, 0)
  lerpRotation(refs.legR, swing * 0.7, 0, 0)
  applyFacing(refs, opts)
}

/**
 * 说话:头部活跃点动 + 单手偶尔抬起比划,身体轻微起伏。
 */
export function applyTalking(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  const root = refs.root
  if (root) {
    root.position.y = lerpValue(root.position.y, Math.sin(tt * 2.4 * L) * 0.015)
    root.rotation.z = lerpAngle(root.rotation.z, 0)
  }
  // 叠加两个频率模拟说话时的自然点头/侧偏
  lerpRotation(refs.head, 0.05 + Math.sin(tt * 6 * L) * 0.05 + Math.sin(tt * 11 * L) * 0.02, Math.sin(tt * 3 * L) * 0.14, Math.sin(tt * 2 * L) * 0.04)
  // 右手抬起比划(以正弦门控成"偶尔"的手势)
  const gesture = Math.max(0, Math.sin(tt * 1.3 * L))
  lerpRotation(refs.armR, -0.5 - gesture * 0.7, 0, -0.2 - gesture * 0.25)
  lerpRotation(refs.armL, -0.1, 0, 0.08)
  lerpRotation(refs.legL, 0, 0, 0)
  lerpRotation(refs.legR, 0, 0, 0)
  applyFacing(refs, opts)
}

/**
 * 思考:头微仰并侧倾,一手托腮(抬近头部),身体几乎静止,偶尔缓慢重心转移。
 */
export function applyThinking(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  const root = refs.root
  if (root) {
    root.position.y = lerpValue(root.position.y, Math.sin(tt * 0.9 * L) * 0.008)
    root.rotation.z = lerpAngle(root.rotation.z, Math.sin(tt * 0.4 * L) * 0.02)
  }
  lerpRotation(refs.head, -0.12 + Math.sin(tt * 0.7 * L) * 0.03, 0.1 + Math.sin(tt * 0.5 * L) * 0.05, 0.18)
  // 右手托腮:大幅抬起并内收
  lerpRotation(refs.armR, -2.3, 0, -0.55)
  lerpRotation(refs.armL, -0.08, 0, 0.05)
  lerpRotation(refs.legL, 0, 0, 0)
  lerpRotation(refs.legR, 0, 0, 0)
  applyFacing(refs, opts)
}

// 保留导出供调用方在切换活动时显式复位(非清单要求,但无副作用且类型安全)
export { neutralLimbs, TAU }
