import type { OfficeProp } from './Floor'
import WindowWall from './WindowWall'

const STEEL_BLUE = '#7f95a6'
const FRAME = '#202833'
const RAIL = '#293340'

/**
 * 左侧剖切玻璃走廊:用侧向幕墙替代黑色空背景,保留开放视角。
 * 只放贴边/贴地元素,避免重新遮挡工位和走动 Agent。
 */
export default function SideGlassCorridor({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  presentationMode = false
}: OfficeProp & { presentationMode?: boolean }): React.JSX.Element {
  const wallScale = presentationMode ? 0.48 : 0.82
  const wallX = presentationMode ? -11.4 : -10.08
  const wallZ = presentationMode ? -5.4 : -1.1
  const boundaryHeight = presentationMode ? 0.16 : 1
  const boundaryY = boundaryHeight / 2
  const railY = presentationMode ? 0.24 : 1.05
  const railLength = presentationMode ? 4.8 : 9.4
  const lowLightLength = presentationMode ? 5.1 : 9.8
  const glowPoints = presentationMode ? [-5.1, -3.4] : [-4.6, -2.4, -0.2, 2.0]

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {!presentationMode && (
        <WindowWall position={[wallX, 0, wallZ]} rotation={[0, Math.PI / 2, 0]} scale={wallScale} minimalFrames={presentationMode} />
      )}

      {/* 侧向玻璃走廊的内侧边界:低矮细线,不形成挡视线的大墙面。 */}
      <mesh position={[-9.72, boundaryY, presentationMode ? -2.9 : -1.1]} castShadow receiveShadow>
        <boxGeometry args={[0.06, boundaryHeight, presentationMode ? 6.8 : 10.1]} />
        <meshStandardMaterial color={FRAME} metalness={0.42} roughness={0.42} transparent={presentationMode} opacity={presentationMode ? 0.46 : 1} />
      </mesh>
      <mesh position={[-9.58, railY, presentationMode ? -2.9 : -1.1]} castShadow receiveShadow>
        <boxGeometry args={[0.06, 0.04, railLength]} />
        <meshStandardMaterial color={RAIL} metalness={0.5} roughness={0.38} transparent={presentationMode} opacity={presentationMode ? 0.5 : 1} />
      </mesh>
      <mesh position={[-9.52, 0.12, presentationMode ? -2.9 : -1.1]}>
        <boxGeometry args={[0.03, 0.03, lowLightLength]} />
        <meshStandardMaterial color={STEEL_BLUE} emissive={STEEL_BLUE} emissiveIntensity={presentationMode ? 0.24 : 0.4} toneMapped={false} transparent={presentationMode} opacity={presentationMode ? 0.62 : 1} />
      </mesh>

      {/* 几个贴边光点,让侧廊在夜间截图里可读。 */}
      {glowPoints.map((z) => (
        <mesh key={z} position={[-9.5, presentationMode ? 0.28 : 1.92, z]}>
          <boxGeometry args={[0.03, presentationMode ? 0.028 : 0.08, presentationMode ? 0.24 : 0.72]} />
          <meshStandardMaterial color={STEEL_BLUE} emissive={STEEL_BLUE} emissiveIntensity={presentationMode ? 0.16 : 0.3} toneMapped={false} transparent={presentationMode} opacity={presentationMode ? 0.42 : 1} />
        </mesh>
      ))}
    </group>
  )
}
