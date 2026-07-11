import { Quaternion, Vector3 } from 'three'
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
  elbowL?: Object3D | null
  elbowR?: Object3D | null
  wristL?: Object3D | null
  wristR?: Object3D | null
  handL?: Object3D | null
  handR?: Object3D | null
  legL?: Object3D | null
  legR?: Object3D | null
  kneeL?: Object3D | null
  kneeR?: Object3D | null
}

/** 动作可选参数:强度/速度倍率与相位偏移(供多个 avatar 错峰) */
export interface AnimOptions {
  /** 活跃度倍率:整体幅度与频率随之缩放(默认 1) */
  liveliness?: number
  /** 相位偏移(秒):让同类 avatar 动作不同步(默认 0) */
  phase?: number
  /** 机器人本地 +Z 正面朝向(弧度),叠加到 root.rotation.y(默认 0) */
  facing?: number
  /** 工位左右手的实际输入目标,供双骨骼 IK 解算肩肘姿态。 */
  deskHandTargets?: {
    left?: Object3D | null
    right?: Object3D | null
  }
}

/**
 * 纯函数动画库:接收 AvatarRefs 与时间 t,直接写 rotation/position 产生动作。
 * 无 JSX / 无组件 / 无 hooks —— 仅在调用方的 useFrame 内被调用。
 * 每次调用会为涉及的关节设置一个完整姿态(而非增量累加),因此可安全逐帧重复调用。
 *
 * 约定:root.position.y 为离地高度(y=0 为站立基准),其余关节均为相对局部旋转。
 */

// —— 复用常量,避免闭包内分配 —— //
const TAU = Math.PI * 2
const JOINT_LERP = 0.1
const DESK_SEATED_ROOT_Y = -0.24
const DESK_SHOULDER_X = -0.862
const DESK_SHOULDER_Y = 0.581
const DESK_SHOULDER_Z = -0.608
const DESK_ELBOW_X = -0.883
const DESK_ELBOW_Y = -0.209
const DESK_ELBOW_Z = 0.373
const DESK_WRIST_X = -0.066
const DESK_WRIST_Y = 0.007
const DESK_WRIST_Z = 1.876
const DESK_WRIST_PRONATION = 1.52
const ARM_IK_LERP = 0.22
const ARM_IK_EPSILON = 0.0001

const ikShoulder = new Vector3()
const ikElbow = new Vector3()
const ikHand = new Vector3()
const ikTarget = new Vector3()
const ikDirection = new Vector3()
const ikPole = new Vector3()
const ikElbowTarget = new Vector3()
const ikRoot = new Vector3()
const ikOutward = new Vector3()
const ikBack = new Vector3()
const ikFrom = new Vector3()
const ikTo = new Vector3()
const ikDelta = new Quaternion()
const ikJointWorld = new Quaternion()
const ikParentWorld = new Quaternion()
const ikDesiredWorld = new Quaternion()
const ikDesiredLocal = new Quaternion()
const ikRootWorld = new Quaternion()

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
  if (refs.elbowL) refs.elbowL.rotation.set(0, 0, 0)
  if (refs.elbowR) refs.elbowR.rotation.set(0, 0, 0)
  if (refs.wristL) refs.wristL.rotation.set(0, 0, 0)
  if (refs.wristR) refs.wristR.rotation.set(0, 0, 0)
  if (refs.legL) refs.legL.rotation.set(0, 0, 0)
  if (refs.legR) refs.legR.rotation.set(0, 0, 0)
  if (refs.kneeL) refs.kneeL.rotation.set(0, 0, 0)
  if (refs.kneeR) refs.kneeR.rotation.set(0, 0, 0)
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

function rotateJointToward(
  joint: Object3D,
  fromDirection: Vector3,
  toDirection: Vector3,
  factor = ARM_IK_LERP
): void {
  if (fromDirection.lengthSq() < ARM_IK_EPSILON || toDirection.lengthSq() < ARM_IK_EPSILON) return

  ikFrom.copy(fromDirection).normalize()
  ikTo.copy(toDirection).normalize()
  ikDelta.setFromUnitVectors(ikFrom, ikTo)
  joint.getWorldQuaternion(ikJointWorld)
  ikDesiredWorld.copy(ikDelta).multiply(ikJointWorld)

  if (joint.parent) {
    joint.parent.getWorldQuaternion(ikParentWorld).invert()
    ikDesiredLocal.copy(ikParentWorld).multiply(ikDesiredWorld)
  } else {
    ikDesiredLocal.copy(ikDesiredWorld)
  }

  joint.quaternion.slerp(ikDesiredLocal, factor)
  joint.updateWorldMatrix(true, true)
}

/**
 * 用手掌中心作为末端的双骨骼 IK。肘部引导向量由躯干、外侧和后下方合成,
 * 让肘部贴近身体而不是横向展开;可达距离限制避免过度拉伸或反向折叠。
 */
function applyDeskArmIK(
  refs: AvatarRefs,
  shoulder: Object3D | null | undefined,
  elbow: Object3D | null | undefined,
  hand: Object3D | null | undefined,
  target: Object3D | null | undefined,
  tap: number
): boolean {
  if (!shoulder || !elbow || !hand || !target) return false

  target.getWorldPosition(ikTarget)
  ikTarget.y += tap * 0.004
  ikTarget.z += Math.abs(tap) * 0.0015
  shoulder.getWorldPosition(ikShoulder)
  elbow.getWorldPosition(ikElbow)
  hand.getWorldPosition(ikHand)

  const upperLength = ikShoulder.distanceTo(ikElbow)
  const lowerLength = ikElbow.distanceTo(ikHand)
  ikDirection.copy(ikTarget).sub(ikShoulder)
  const rawDistance = ikDirection.length()
  if (upperLength < ARM_IK_EPSILON || lowerLength < ARM_IK_EPSILON || rawDistance < ARM_IK_EPSILON) return false

  ikDirection.multiplyScalar(1 / rawDistance)
  const distance = Math.min(
    upperLength + lowerLength - ARM_IK_EPSILON,
    Math.max(Math.abs(upperLength - lowerLength) + ARM_IK_EPSILON, rawDistance)
  )
  const along = (upperLength * upperLength - lowerLength * lowerLength + distance * distance) / (2 * distance)
  const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along))

  if (refs.root) {
    refs.root.getWorldPosition(ikRoot)
    ikOutward.copy(ikShoulder).sub(ikRoot).setY(0)
    if (ikOutward.lengthSq() < ARM_IK_EPSILON) ikOutward.set(Math.sign(ikShoulder.x - ikRoot.x) || 1, 0, 0)
    ikOutward.normalize()
    refs.root.getWorldQuaternion(ikRootWorld)
    ikBack.set(0, 0, -1).applyQuaternion(ikRootWorld).normalize()
  } else {
    ikOutward.set(Math.sign(ikShoulder.x) || 1, 0, 0)
    ikBack.set(0, 0, 1)
  }

  ikPole.set(0, -0.58, 0).addScaledVector(ikOutward, 0.22).addScaledVector(ikBack, 0.82)
  ikPole.addScaledVector(ikDirection, -ikPole.dot(ikDirection))
  if (ikPole.lengthSq() < ARM_IK_EPSILON) ikPole.copy(ikOutward)
  ikPole.normalize()

  ikElbowTarget
    .copy(ikShoulder)
    .addScaledVector(ikDirection, along)
    .addScaledVector(ikPole, height)

  rotateJointToward(
    shoulder,
    ikElbow.subVectors(ikElbow, ikShoulder),
    ikTo.subVectors(ikElbowTarget, ikShoulder)
  )

  elbow.getWorldPosition(ikElbow)
  hand.getWorldPosition(ikHand)
  rotateJointToward(
    elbow,
    ikHand.subVectors(ikHand, ikElbow),
    ikTo.subVectors(ikTarget, ikElbow),
    ARM_IK_LERP * 1.12
  )
  return true
}

/** 桌面办公状态共用坐姿:髋部落到座垫上,大腿前伸,小腿自然下垂。 */
function applyDeskSeatedLowerBody(refs: AvatarRefs, sway = 0): void {
  const root = refs.root
  if (root) {
    root.position.y = lerpValue(root.position.y, DESK_SEATED_ROOT_Y)
    root.rotation.z = lerpAngle(root.rotation.z, sway)
  }
  lerpRotation(refs.legL, -1.05, 0, -0.055)
  lerpRotation(refs.legR, -1.05, 0, 0.055)
  lerpRotation(refs.kneeL, 1.34, 0, 0)
  lerpRotation(refs.kneeR, 1.34, 0, 0)
}

/**
 * 双手落在工位输入阵列上。优先使用手掌端点 + 实际输入目标做 IK,
 * 无端点的兼容模型才回退到已标定的固定角度。
 */
function applyDeskControlPose(refs: AvatarRefs, leftTap = 0, rightTap = 0, opts?: AnimOptions): void {
  lerpRotation(refs.wristL, -0.04 + leftTap * 0.018, 0.02, -DESK_WRIST_PRONATION)
  lerpRotation(refs.wristR, -0.04 + rightTap * 0.018, -0.02, DESK_WRIST_PRONATION)

  const leftSolved = applyDeskArmIK(
    refs,
    refs.armL,
    refs.elbowL,
    refs.handL,
    opts?.deskHandTargets?.left,
    leftTap
  )
  const rightSolved = applyDeskArmIK(
    refs,
    refs.armR,
    refs.elbowR,
    refs.handR,
    opts?.deskHandTargets?.right,
    rightTap
  )

  if (!leftSolved) {
    lerpRotation(refs.armL, DESK_SHOULDER_X + leftTap * 0.012, -DESK_SHOULDER_Y, -DESK_SHOULDER_Z)
    lerpRotation(refs.elbowL, DESK_ELBOW_X + leftTap * 0.03, DESK_ELBOW_Y, DESK_ELBOW_Z)
    lerpRotation(refs.wristL, DESK_WRIST_X + leftTap * 0.035, DESK_WRIST_Y, -DESK_WRIST_Z)
  }
  if (!rightSolved) {
    lerpRotation(refs.armR, DESK_SHOULDER_X + rightTap * 0.012, DESK_SHOULDER_Y, DESK_SHOULDER_Z)
    lerpRotation(refs.elbowR, DESK_ELBOW_X + rightTap * 0.03, -DESK_ELBOW_Y, -DESK_ELBOW_Z)
    lerpRotation(refs.wristR, DESK_WRIST_X + rightTap * 0.035, -DESK_WRIST_Y, DESK_WRIST_Z)
  }
}

/**
 * 待机:轻微呼吸起伏 + 头部缓慢摆动,手臂自然垂放。
 */
export function applyIdle(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  const root = refs.root
  if (root) {
    root.position.y = lerpValue(root.position.y, 0)
    root.rotation.z = lerpAngle(root.rotation.z, 0)
  }
  lerpRotation(refs.head, 0.04 + Math.sin(tt * 1.2 * L) * 0.03, Math.sin(tt * 0.5 * L) * 0.12, Math.sin(tt * 0.8 * L) * 0.05)
  lerpRotation(refs.armL, Math.sin(tt * 1.6 * L) * 0.04, 0, 0.06)
  lerpRotation(refs.armR, Math.sin(tt * 1.6 * L + Math.PI) * 0.04, 0, -0.06)
  lerpRotation(refs.elbowL, 0, 0, 0)
  lerpRotation(refs.elbowR, 0, 0, 0)
  lerpRotation(refs.wristL, 0, 0, 0)
  lerpRotation(refs.wristR, 0, 0, 0)
  lerpRotation(refs.legL, 0, 0, 0)
  lerpRotation(refs.legR, 0, 0, 0)
  lerpRotation(refs.kneeL, 0, 0, 0)
  lerpRotation(refs.kneeR, 0, 0, 0)
  applyFacing(refs, opts)
}

/**
 * 值守控制台:适合 idle 工位。机器人不是休息,而是面向屏幕持续监控,
 * 双臂停在操作面板附近,头部做很小幅的扫描。
 */
export function applyMonitoring(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  applyDeskSeatedLowerBody(refs, Math.sin(tt * 0.7 * L) * 0.006)
  lerpRotation(
    refs.head,
    0.14 + Math.sin(tt * 0.9 * L) * 0.014,
    Math.sin(tt * 0.45 * L) * 0.055,
    Math.sin(tt * 0.6 * L) * 0.01
  )
  applyDeskControlPose(refs, Math.sin(tt * 1.1 * L) * 0.12, Math.cos(tt * 1.05 * L) * 0.12, opts)
  applyFacing(refs, opts)
}

/**
 * 打字:双手在桌前快速交替敲击,身体微前倾并轻颤,头随节奏点动。
 */
export function applyTyping(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  const beat = tt * 12 * L
  applyDeskSeatedLowerBody(refs)
  lerpRotation(refs.head, 0.18 + Math.sin(beat) * 0.025, Math.sin(tt * 2 * L) * 0.04, 0)
  // 双手保持在两个输入区内,敲击只由很小的肘腕位移表达。
  applyDeskControlPose(refs, Math.sin(beat), Math.cos(beat), opts)
  applyFacing(refs, opts)
}

/**
 * 行走:四肢对角摆动 + 身体上下起伏,root 仅做原地步态(位移由调用方控制)。
 */
export function applyWalking(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  const motion = Math.max(0.16, Math.min(1, L))
  const stride = tt * 6 * (0.72 + motion * 0.28)
  const swing = Math.sin(stride) * motion
  const bendL = Math.max(0, swing)
  const bendR = Math.max(0, -swing)
  const root = refs.root
  if (root) {
    // 步伐落点时的双峰起伏
    root.position.y = lerpValue(root.position.y, Math.abs(Math.sin(stride)) * 0.014 * motion)
    root.rotation.z = lerpAngle(root.rotation.z, Math.sin(stride) * 0.018 * motion)
  }
  lerpRotation(refs.head, 0.05, 0, Math.sin(stride) * 0.024)
  // 对角摆动:肩/髋控制步幅,肘/膝在摆动侧屈曲以形成清晰的回收步。
  lerpRotation(refs.armL, swing * 0.26, 0, 0)
  lerpRotation(refs.armR, -swing * 0.26, 0, 0)
  lerpRotation(refs.elbowL, -0.1 - bendL * 0.14, 0, 0)
  lerpRotation(refs.elbowR, -0.1 - bendR * 0.14, 0, 0)
  lerpRotation(refs.wristL, swing * -0.04, 0, 0)
  lerpRotation(refs.wristR, swing * 0.04, 0, 0)
  lerpRotation(refs.legL, -swing * 0.28, 0, 0)
  lerpRotation(refs.legR, swing * 0.28, 0, 0)
  lerpRotation(refs.kneeL, 0.04 + bendL * 0.24, 0, 0)
  lerpRotation(refs.kneeR, 0.04 + bendR * 0.24, 0, 0)
  applyFacing(refs, opts)
}

/**
 * 说话:头部活跃点动 + 单手偶尔抬起比划,身体轻微起伏。
 */
export function applyTalking(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  applyDeskSeatedLowerBody(refs, Math.sin(tt * 0.8 * L) * 0.006)
  // 叠加两个频率模拟说话时的自然点头/侧偏
  lerpRotation(refs.head, 0.08 + Math.sin(tt * 6 * L) * 0.03 + Math.sin(tt * 11 * L) * 0.012, Math.sin(tt * 3 * L) * 0.09, Math.sin(tt * 2 * L) * 0.025)
  // 视频沟通时仍保持控制台接触,用头部动作表达交流,避免手臂穿过桌面。
  applyDeskControlPose(refs, Math.sin(tt * 1.7 * L) * 0.08, Math.sin(tt * 1.3 * L) * 0.14, opts)
  applyFacing(refs, opts)
}

/** 离开工位后的站立交流:双脚保持落地,用头部和前臂表达确认/讨论。 */
export function applyStandingTalking(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  const gesture = (Math.sin(tt * 2.1 * L) + 1) * 0.5
  const root = refs.root
  if (root) {
    root.position.y = lerpValue(root.position.y, 0)
    root.rotation.z = lerpAngle(root.rotation.z, Math.sin(tt * 0.7 * L) * 0.008)
  }
  lerpRotation(
    refs.head,
    0.05 + Math.sin(tt * 4.8 * L) * 0.025,
    Math.sin(tt * 1.8 * L) * 0.08,
    Math.sin(tt * 1.2 * L) * 0.018
  )
  lerpRotation(refs.armL, -0.08 + Math.sin(tt * 1.3 * L) * 0.04, 0, 0.08)
  lerpRotation(refs.armR, -0.12 - gesture * 0.16, 0, -0.12)
  lerpRotation(refs.elbowL, -0.08, 0, 0)
  lerpRotation(refs.elbowR, -0.12 - gesture * 0.18, 0, 0)
  lerpRotation(refs.wristL, 0, 0, 0)
  lerpRotation(refs.wristR, Math.sin(tt * 2.4 * L) * 0.05, 0, 0)
  lerpRotation(refs.legL, 0, 0, -0.015)
  lerpRotation(refs.legR, 0, 0, 0.015)
  lerpRotation(refs.kneeL, 0.02, 0, 0)
  lerpRotation(refs.kneeR, 0.02, 0, 0)
  applyFacing(refs, opts)
}

/**
 * 思考:头微仰并侧倾,一手托腮(抬近头部),身体几乎静止,偶尔缓慢重心转移。
 */
export function applyThinking(refs: AvatarRefs, t: number, opts?: AnimOptions): void {
  const L = amp(opts)
  const tt = time(t, opts)
  applyDeskSeatedLowerBody(refs, Math.sin(tt * 0.4 * L) * 0.008)
  lerpRotation(refs.head, 0.02 + Math.sin(tt * 0.7 * L) * 0.02, 0.08 + Math.sin(tt * 0.5 * L) * 0.035, 0.07)
  // 故障诊断仍在双侧输入区操作,只降低节奏并增加观察停顿。
  applyDeskControlPose(refs, Math.sin(tt * 0.7 * L) * 0.06, Math.cos(tt * 0.55 * L) * 0.06, opts)
  applyFacing(refs, opts)
}

// 保留导出供调用方在切换活动时显式复位(非清单要求,但无副作用且类型安全)
export { neutralLimbs, TAU }
