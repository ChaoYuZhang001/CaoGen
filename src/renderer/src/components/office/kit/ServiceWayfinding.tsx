export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

const CYAN = '#8fe9ff'
const APPROVAL = '#6f8fa0'
const DINING = '#5f7f8c'
const FLOOR_DARK = '#151a21'
const PANEL_DARK = '#171b22'
const METAL = '#303845'

interface StripProps {
  position: [number, number, number]
  size: [number, number, number]
  color: string
  opacity?: number
}

function Strip({ position, size, color, opacity = 0.42 }: StripProps): React.JSX.Element {
  return (
    <mesh position={position} receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.18}
        transparent
        opacity={opacity}
        roughness={0.58}
        toneMapped={false}
      />
    </mesh>
  )
}

function Waypoint({
  position,
  color,
  radius = 0.16
}: {
  position: [number, number, number]
  color: string
  radius?: number
}): React.JSX.Element {
  return (
    <mesh position={position} receiveShadow>
      <cylinderGeometry args={[radius, radius, 0.018, 32]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.32}
        transparent
        opacity={0.48}
        toneMapped={false}
      />
    </mesh>
  )
}

function RestroomIcon({ accent }: { accent: string }): React.JSX.Element {
  return (
    <group position={[0, 0.42, 0.04]} scale={0.86}>
      <mesh position={[-0.12, 0.18, 0]}>
        <boxGeometry args={[0.09, 0.09, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.34} toneMapped={false} />
      </mesh>
      <mesh position={[-0.12, -0.02, 0]}>
        <boxGeometry args={[0.12, 0.28, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.26} toneMapped={false} />
      </mesh>
      <mesh position={[0.12, 0.18, 0]}>
        <boxGeometry args={[0.09, 0.09, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.34} toneMapped={false} />
      </mesh>
      <mesh position={[0.12, -0.02, 0]}>
        <boxGeometry args={[0.13, 0.28, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.26} toneMapped={false} />
      </mesh>
    </group>
  )
}

function DiningIcon({ accent }: { accent: string }): React.JSX.Element {
  return (
    <group position={[0, 0.4, 0.04]} scale={0.86}>
      <mesh position={[-0.1, -0.02, 0]}>
        <boxGeometry args={[0.034, 0.42, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.3} toneMapped={false} />
      </mesh>
      {[-0.15, -0.1, -0.05].map((x) => (
        <mesh key={x} position={[x, 0.22, 0]}>
          <boxGeometry args={[0.018, 0.14, 0.018]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.28} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[0.15, -0.02, 0]} rotation={[0, 0, -0.1]}>
        <boxGeometry args={[0.04, 0.46, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.3} toneMapped={false} />
      </mesh>
      <mesh position={[0.18, 0.22, 0]} rotation={[0, 0, -0.1]}>
        <boxGeometry args={[0.08, 0.16, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.3} toneMapped={false} />
      </mesh>
    </group>
  )
}

function FacilityPortal({
  position,
  rotation = [0, 0, 0],
  accent,
  kind
}: {
  position: [number, number, number]
  rotation?: [number, number, number]
  accent: string
  kind: 'restroom' | 'dining'
}): React.JSX.Element {
  return (
    <group position={position} rotation={rotation}>
      <mesh position={[0, 0.34, -0.05]} receiveShadow>
        <boxGeometry args={[0.84, 0.68, 0.052]} />
        <meshStandardMaterial color="#111820" metalness={0.16} roughness={0.78} transparent opacity={0.62} />
      </mesh>
      <mesh position={[0, 0.3, 0]} receiveShadow>
        <boxGeometry args={[0.66, 0.56, 0.05]} />
        <meshStandardMaterial color="#202834" metalness={0.2} roughness={0.68} transparent opacity={0.58} />
      </mesh>
      <mesh position={[-0.38, 0.34, 0.018]} castShadow={false}>
        <boxGeometry args={[0.035, 0.64, 0.09]} />
        <meshStandardMaterial color={METAL} metalness={0.44} roughness={0.42} transparent opacity={0.68} />
      </mesh>
      <mesh position={[0.38, 0.34, 0.018]} castShadow={false}>
        <boxGeometry args={[0.035, 0.64, 0.09]} />
        <meshStandardMaterial color={METAL} metalness={0.44} roughness={0.42} transparent opacity={0.68} />
      </mesh>
      <mesh position={[0, 0.68, 0.018]} castShadow={false}>
        <boxGeometry args={[0.78, 0.04, 0.09]} />
        <meshStandardMaterial color={METAL} metalness={0.46} roughness={0.4} transparent opacity={0.7} />
      </mesh>
      <mesh position={[0, 0.05, 0.055]} receiveShadow>
        <boxGeometry args={[0.76, 0.024, 0.07]} />
        <meshStandardMaterial color={METAL} metalness={0.42} roughness={0.5} transparent opacity={0.76} />
      </mesh>
      <mesh position={[0, 0.024, 0.36]} receiveShadow>
        <boxGeometry args={[0.78, 0.014, 0.48]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.24} transparent opacity={0.2} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.62, 0.048]}>
        <boxGeometry args={[0.52, 0.02, 0.032]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.38} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.5, 0.05]}>
        <boxGeometry args={[0.36, 0.014, 0.028]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.26} transparent opacity={0.72} toneMapped={false} />
      </mesh>
      {kind === 'restroom' ? <RestroomIcon accent={accent} /> : <DiningIcon accent={accent} />}
    </group>
  )
}

function RestroomFixture({
  position,
  rotation = [0, 0, 0],
  accent
}: {
  position: [number, number, number]
  rotation?: [number, number, number]
  accent: string
}): React.JSX.Element {
  return (
    <group position={position} rotation={rotation}>
      {[-0.24, 0.24].map((x) => (
        <mesh key={x} position={[x, 0.36, 0]} receiveShadow>
          <boxGeometry args={[0.046, 0.62, 0.36]} />
          <meshStandardMaterial color={PANEL_DARK} metalness={0.18} roughness={0.7} transparent opacity={0.72} />
        </mesh>
      ))}
      <mesh position={[0, 0.18, -0.08]} receiveShadow>
        <boxGeometry args={[0.36, 0.12, 0.18]} />
        <meshStandardMaterial color="#9fb2c2" metalness={0.08} roughness={0.48} />
      </mesh>
      {[-0.07, 0.07].map((x) => (
        <mesh key={`restroom-fixture-slat-${x}`} position={[x, 0.27, -0.08]}>
          <boxGeometry args={[0.1, 0.014, 0.018]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.24} transparent opacity={0.58} toneMapped={false} />
        </mesh>
      ))}
      <Strip position={[0, 0.044, 0.26]} size={[0.62, 0.014, 0.08]} color={accent} opacity={0.28} />
    </group>
  )
}

function DiningFixture({
  position,
  rotation = [0, 0, 0],
  accent
}: {
  position: [number, number, number]
  rotation?: [number, number, number]
  accent: string
}): React.JSX.Element {
  return (
    <group position={position} rotation={rotation}>
      <mesh position={[0, 0.22, 0]} receiveShadow castShadow>
        <boxGeometry args={[0.92, 0.32, 0.24]} />
        <meshStandardMaterial color="#202832" metalness={0.12} roughness={0.74} />
      </mesh>
      <mesh position={[0, 0.41, -0.01]}>
        <boxGeometry args={[0.78, 0.024, 0.25]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.22} transparent opacity={0.48} toneMapped={false} />
      </mesh>
      <mesh position={[0.04, 0.24, -0.55]} receiveShadow castShadow>
        <cylinderGeometry args={[0.24, 0.24, 0.045, 28]} />
        <meshStandardMaterial color="#303845" metalness={0.08} roughness={0.62} />
      </mesh>
      {[-0.3, 0.38].map((x) => (
        <group key={x} position={[x, 0, -0.55]}>
          <mesh position={[0, 0.13, 0]} receiveShadow>
            <cylinderGeometry args={[0.09, 0.09, 0.05, 20]} />
            <meshStandardMaterial color="#26313b" roughness={0.64} />
          </mesh>
          <mesh position={[0, 0.06, 0]}>
            <cylinderGeometry args={[0.018, 0.018, 0.13, 12]} />
            <meshStandardMaterial color={METAL} metalness={0.42} roughness={0.42} />
          </mesh>
        </group>
      ))}
      <Strip position={[0.04, 0.04, -0.55]} size={[0.76, 0.014, 0.54]} color={accent} opacity={0.16} />
    </group>
  )
}

/**
 * 服务动线:把工位、审批台、茶水区和侧边设施入口连成一个清晰的低矮路径层。
 * 所有元素都贴地或靠边,避免遮挡默认相机里的机器人和工位。
 */
export default function ServiceWayfinding({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 中央服务脊线:从工位区引到右侧服务带,设施不压在默认镜头前景。 */}
      <Strip position={[0.72, 0.034, 1.42]} size={[0.08, 0.018, 2.78]} color={FLOOR_DARK} opacity={0.64} />
      <Strip position={[2.44, 0.046, 0.74]} size={[3.44, 0.016, 0.08]} color={APPROVAL} opacity={0.46} />
      <Strip position={[3.12, 0.046, 1.82]} size={[4.12, 0.016, 0.08]} color={CYAN} opacity={0.42} />
      <Strip position={[-1.72, 0.044, 2.78]} size={[4.28, 0.014, 0.07]} color={DINING} opacity={0.34} />

      <Waypoint position={[4.18, 0.052, 0.74]} color={APPROVAL} radius={0.18} />
      <Waypoint position={[4.86, 0.052, 1.82]} color={CYAN} radius={0.16} />
      <Waypoint position={[-3.78, 0.05, 2.78]} color={DINING} radius={0.15} />

      {/* 侧边设施入口:真实办公室里的卫生间/餐饮不放在控制室中心,只保留走廊入口信号。 */}
      <FacilityPortal position={[-5.62, 0, 2.64]} rotation={[0, 0.28, 0]} accent={CYAN} kind="restroom" />
      <FacilityPortal position={[-4.74, 0, 2.78]} rotation={[0, 0.28, 0]} accent={DINING} kind="dining" />
      <RestroomFixture position={[-6.18, 0, 3.16]} rotation={[0, 0.28, 0]} accent={CYAN} />
      <DiningFixture position={[-4.16, 0, 3.34]} rotation={[0, 0.28, 0]} accent={DINING} />
    </group>
  )
}
