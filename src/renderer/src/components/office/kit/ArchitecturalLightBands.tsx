import type { OfficeProp } from './Floor'

const COOL_WHITE = '#b9cbe0'
const STEEL_BLUE = '#7f95a6'
const SIGNAL_CYAN = '#72b8c8'
const FLOOR_WASH = '#26323f'
const RAIL_DARK = '#1b232d'

function LightBar({
  position,
  size,
  color = COOL_WHITE,
  intensity = 0.7,
  opacity = 1
}: {
  position: [number, number, number]
  size: [number, number, number]
  color?: string
  intensity?: number
  opacity?: number
}): React.JSX.Element {
  return (
    <mesh position={position} castShadow={false} receiveShadow={false}>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={intensity}
        transparent={opacity < 1}
        opacity={opacity}
        roughness={0.22}
        metalness={0.12}
        toneMapped={false}
      />
    </mesh>
  )
}

/**
 * 建筑级照明层:高位光带、踢脚线和地面洗墙光。
 * 它们都贴边或贴地,负责提升办公室层次,不挡默认相机视线。
 */
export default function ArchitecturalLightBands({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  presentationMode = false
}: OfficeProp & { presentationMode?: boolean }): React.JSX.Element {
  const edgeY = presentationMode ? 0.11 : 0.2
  const edgeDepth = presentationMode ? 0.024 : 0.04
  const backLightLength = presentationMode ? 10.4 : 14.4
  const sideLightLength = presentationMode ? 5.4 : 12.4
  const rightLightLength = presentationMode ? 5.0 : 11.8

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 高位洗墙灯:沿后窗/侧墙布置,避免横穿默认画面顶部。 */}
      {!presentationMode && (
        <>
          {[-4.2, 0, 4.2].map((x) => (
            <group key={`back-${x}`}>
              <LightBar position={[x, 3.72, -8.72]} size={[2.55, 0.032, 0.052]} color={COOL_WHITE} intensity={0.34} opacity={0.7} />
              <mesh position={[x, 3.75, -8.69]} castShadow={false}>
                <boxGeometry args={[2.75, 0.03, 0.085]} />
                <meshStandardMaterial color={RAIL_DARK} roughness={0.44} metalness={0.36} />
              </mesh>
            </group>
          ))}
          {[-4.8, -1.4, 2.0].map((z) => (
            <group key={`side-${z}`}>
              <LightBar position={[-8.72, 3.44, z]} size={[0.052, 0.032, 1.92]} color={COOL_WHITE} intensity={0.26} opacity={0.62} />
              <mesh position={[-8.69, 3.47, z]} castShadow={false}>
                <boxGeometry args={[0.085, 0.03, 2.08]} />
                <meshStandardMaterial color={RAIL_DARK} roughness={0.44} metalness={0.36} />
              </mesh>
            </group>
          ))}
        </>
      )}

      {/* 后窗/侧廊踢脚光仅在自由浏览视角显示;展示视角不放长灯带进主体画面。 */}
      {!presentationMode && (
        <>
          <LightBar
            position={[0, edgeY, -8.92]}
            size={[backLightLength, edgeDepth, edgeDepth]}
            color={STEEL_BLUE}
            intensity={0.38}
            opacity={0.88}
          />
          <LightBar
            position={[-8.92, edgeY, -3.15]}
            size={[edgeDepth, edgeDepth, sideLightLength]}
            color={STEEL_BLUE}
            intensity={0.32}
            opacity={0.86}
          />
          <LightBar
            position={[8.92, edgeY, -3.3]}
            size={[edgeDepth, edgeDepth, rightLightLength]}
            color={COOL_WHITE}
            intensity={0.42}
            opacity={1}
          />
        </>
      )}

      {/* 中央工作区地面洗光:薄、低透明度,增强空间层次,不变成发光地毯。 */}
      <mesh position={[0, 0.018, -1.25]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[7.8, 5.4]} />
        <meshStandardMaterial
          color={FLOOR_WASH}
          emissive={FLOOR_WASH}
          emissiveIntensity={0.12}
          transparent
          opacity={0.28}
          roughness={0.74}
          metalness={0.08}
          depthWrite={false}
        />
      </mesh>

      {/* 三个克制的工位定位点,强化"办公区"而不是黑色舞台。 */}
      {[
        [-2.3, -2.65],
        [0.9, -2.15],
        [2.85, 0.4]
      ].map(([x, z]) => (
        <LightBar
          key={`${x}:${z}`}
          position={[x, 0.07, z]}
          size={[0.62, 0.018, 0.055]}
          color={SIGNAL_CYAN}
          intensity={0.26}
          opacity={0.68}
        />
      ))}
    </group>
  )
}
