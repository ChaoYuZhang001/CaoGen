import type { OfficeProp } from './Floor'

const GLASS = '#9fd8e6'
const EDGE = '#8fe9ff'
const FRAME = '#26313b'

function GlassPanel({
  position,
  rotation = [0, 0, 0],
  size
}: {
  position: [number, number, number]
  rotation?: [number, number, number]
  size: [number, number, number]
}): React.JSX.Element {
  return (
    <group position={position} rotation={rotation}>
      <mesh castShadow={false} receiveShadow={false}>
        <boxGeometry args={size} />
        <meshStandardMaterial
          color={GLASS}
          transparent
          opacity={0.055}
          metalness={0.38}
          roughness={0.18}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, size[1] / 2 + 0.018, 0]}>
        <boxGeometry args={[size[0], 0.025, size[2]]} />
        <meshStandardMaterial color={FRAME} metalness={0.42} roughness={0.4} transparent opacity={0.58} />
      </mesh>
      <mesh position={[0, -size[1] / 2 + 0.02, 0]}>
        <boxGeometry args={[size[0], 0.028, size[2]]} />
        <meshStandardMaterial color={EDGE} emissive={EDGE} emissiveIntensity={0.18} toneMapped={false} transparent opacity={0.72} />
      </mesh>
    </group>
  )
}

/**
 * 中央工位贴地玻璃边界。
 * 高度控制在机器人脚踝附近,只定义办公区边界,不遮挡默认视角、电脑屏幕和机器人躯干。
 */
export default function WorkZoneGlass({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <GlassPanel position={[-2.05, 0.14, -0.92]} size={[0.026, 0.16, 3.55]} />
      <GlassPanel position={[1.95, 0.14, -0.92]} size={[0.026, 0.16, 3.55]} />
      <GlassPanel position={[-0.05, 0.13, 0.96]} rotation={[0, Math.PI / 2, 0]} size={[0.026, 0.14, 3.95]} />
    </group>
  )
}
