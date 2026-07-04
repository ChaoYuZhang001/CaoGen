import { forwardRef, useImperativeHandle, useRef } from 'react'
import type { Group, Object3D } from 'three'

/** 视觉道具通用位姿 props(与其它 kit 组件一致) */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

/**
 * 外部动画驱动句柄:各主要部位的 group(Object3D)。
 * - root:整体根节点(可做上下浮动 / 缩放)
 * - head:头部(点头 / 摇头)
 * - armL / armR:肩部枢轴(整条手臂绕肩摆动;前臂为其子节点)
 * - legL / legR:髋部枢轴(整条腿绕髋摆动;小腿为其子节点)
 */
export type AvatarRefs = {
  root: Object3D | null
  head: Object3D | null
  armL: Object3D | null
  armR: Object3D | null
  legL: Object3D | null
  legR: Object3D | null
}

type Props = OfficeProp & {
  bodyColor?: string
  skinColor?: string
  /** 可选:把各部位 group 写入外部传入的引用对象(与转发 ref 二选一或并用) */
  refs?: AvatarRefs
}

const DEFAULT_BODY = '#c9cdd4'
const DEFAULT_SKIN = '#e8d9c4'
const JOINT = '#9aa0aa'

/**
 * 改进版低多边形人形装配(rig)。
 * 每个可动部位由独立 group 包裹并暴露给外部,由调用方在 useFrame 中驱动动画;
 * 本组件自身不做任何动画,只负责结构与外形。
 *
 * 站姿参考(单位≈米,y=0 为脚底):
 *   腿高 ~0.5,躯干中心 ~0.85,肩枢轴 ~1.02,头中心 ~1.32,总高约 1.5m。
 */
const AvatarRig = forwardRef<AvatarRefs, Props>(function AvatarRig(
  { position, rotation, scale = 1, bodyColor, skinColor, refs },
  ref
): React.JSX.Element {
  const body = bodyColor ?? DEFAULT_BODY
  const skin = skinColor ?? DEFAULT_SKIN

  const rootRef = useRef<Group>(null)
  const headRef = useRef<Group>(null)
  const armLRef = useRef<Group>(null)
  const armRRef = useRef<Group>(null)
  const legLRef = useRef<Group>(null)
  const legRRef = useRef<Group>(null)

  // 同时把句柄写入外部 refs 对象与转发 ref;二者共享同一组内部 ref。
  const collect = (): AvatarRefs => {
    const bag: AvatarRefs = {
      root: rootRef.current,
      head: headRef.current,
      armL: armLRef.current,
      armR: armRRef.current,
      legL: legLRef.current,
      legR: legRRef.current
    }
    if (refs) {
      refs.root = bag.root
      refs.head = bag.head
      refs.armL = bag.armL
      refs.armR = bag.armR
      refs.legL = bag.legL
      refs.legR = bag.legR
    }
    return bag
  }
  useImperativeHandle(ref, collect, [refs])

  return (
    <group ref={rootRef} position={position} rotation={rotation} scale={scale}>
      {/* ===== 躯干 ===== */}
      <mesh position={[0, 0.85, 0]} castShadow>
        <capsuleGeometry args={[0.15, 0.32, 6, 12]} />
        <meshStandardMaterial color={body} roughness={0.7} metalness={0.1} />
      </mesh>
      {/* 颈 */}
      <mesh position={[0, 1.14, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.07, 0.08, 12]} />
        <meshStandardMaterial color={skin} roughness={0.8} />
      </mesh>

      {/* ===== 头(点头/摇头枢轴在颈根 y≈1.18) ===== */}
      <group ref={headRef} position={[0, 1.18, 0]}>
        <mesh position={[0, 0.14, 0]} castShadow>
          <sphereGeometry args={[0.15, 16, 16]} />
          <meshStandardMaterial color={skin} roughness={0.8} />
        </mesh>
      </group>

      {/* ===== 左臂:肩枢轴 y≈1.02 ===== */}
      <group ref={armLRef} position={[-0.19, 1.02, 0]}>
        {/* 肩关节 */}
        <mesh castShadow>
          <sphereGeometry args={[0.055, 12, 12]} />
          <meshStandardMaterial color={JOINT} roughness={0.6} metalness={0.2} />
        </mesh>
        {/* 上臂(自肩向下) */}
        <mesh position={[0, -0.11, 0]} castShadow>
          <capsuleGeometry args={[0.045, 0.16, 4, 8]} />
          <meshStandardMaterial color={body} roughness={0.7} metalness={0.1} />
        </mesh>
        {/* 前臂枢轴(肘) y≈-0.22:整段前臂作为子节点,可绕肘独立弯曲 */}
        <group position={[0, -0.22, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.04, 12, 12]} />
            <meshStandardMaterial color={JOINT} roughness={0.6} metalness={0.2} />
          </mesh>
          <mesh position={[0, -0.1, 0]} castShadow>
            <capsuleGeometry args={[0.04, 0.14, 4, 8]} />
            <meshStandardMaterial color={skin} roughness={0.8} />
          </mesh>
        </group>
      </group>

      {/* ===== 右臂:肩枢轴 y≈1.02 ===== */}
      <group ref={armRRef} position={[0.19, 1.02, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.055, 12, 12]} />
          <meshStandardMaterial color={JOINT} roughness={0.6} metalness={0.2} />
        </mesh>
        <mesh position={[0, -0.11, 0]} castShadow>
          <capsuleGeometry args={[0.045, 0.16, 4, 8]} />
          <meshStandardMaterial color={body} roughness={0.7} metalness={0.1} />
        </mesh>
        <group position={[0, -0.22, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.04, 12, 12]} />
            <meshStandardMaterial color={JOINT} roughness={0.6} metalness={0.2} />
          </mesh>
          <mesh position={[0, -0.1, 0]} castShadow>
            <capsuleGeometry args={[0.04, 0.14, 4, 8]} />
            <meshStandardMaterial color={skin} roughness={0.8} />
          </mesh>
        </group>
      </group>

      {/* ===== 左腿:髋枢轴 y≈0.66 ===== */}
      <group ref={legLRef} position={[-0.08, 0.66, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.055, 12, 12]} />
          <meshStandardMaterial color={JOINT} roughness={0.6} metalness={0.2} />
        </mesh>
        {/* 大腿 */}
        <mesh position={[0, -0.16, 0]} castShadow>
          <capsuleGeometry args={[0.06, 0.2, 4, 8]} />
          <meshStandardMaterial color={body} roughness={0.7} metalness={0.1} />
        </mesh>
        {/* 膝枢轴 y≈-0.32:小腿 + 脚作为子节点 */}
        <group position={[0, -0.32, 0]}>
          <mesh position={[0, -0.14, 0]} castShadow>
            <capsuleGeometry args={[0.05, 0.18, 4, 8]} />
            <meshStandardMaterial color={body} roughness={0.7} metalness={0.1} />
          </mesh>
          <mesh position={[0, -0.27, 0.04]} castShadow>
            <boxGeometry args={[0.09, 0.05, 0.16]} />
            <meshStandardMaterial color={JOINT} roughness={0.6} metalness={0.2} />
          </mesh>
        </group>
      </group>

      {/* ===== 右腿:髋枢轴 y≈0.66 ===== */}
      <group ref={legRRef} position={[0.08, 0.66, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.055, 12, 12]} />
          <meshStandardMaterial color={JOINT} roughness={0.6} metalness={0.2} />
        </mesh>
        <mesh position={[0, -0.16, 0]} castShadow>
          <capsuleGeometry args={[0.06, 0.2, 4, 8]} />
          <meshStandardMaterial color={body} roughness={0.7} metalness={0.1} />
        </mesh>
        <group position={[0, -0.32, 0]}>
          <mesh position={[0, -0.14, 0]} castShadow>
            <capsuleGeometry args={[0.05, 0.18, 4, 8]} />
            <meshStandardMaterial color={body} roughness={0.7} metalness={0.1} />
          </mesh>
          <mesh position={[0, -0.27, 0.04]} castShadow>
            <boxGeometry args={[0.09, 0.05, 0.16]} />
            <meshStandardMaterial color={JOINT} roughness={0.6} metalness={0.2} />
          </mesh>
        </group>
      </group>
    </group>
  )
})

export default AvatarRig

