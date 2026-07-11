import { RoundedBox } from '@react-three/drei'

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
  const isRestroom = kind === 'restroom'
  const width = isRestroom ? 1.34 : 1.58
  const postX = width / 2
  return (
    <group position={position} rotation={rotation}>
      <RoundedBox args={[width + 0.18, 0.06, 0.62]} radius={0.035} smoothness={3} position={[0, 0.03, 0.14]} receiveShadow>
        <meshStandardMaterial color={FLOOR_DARK} metalness={0.18} roughness={0.8} />
      </RoundedBox>
      {[-postX, postX].map((x) => (
        <RoundedBox key={`facility-post-${x}`} args={[0.12, 2.08, 0.18]} radius={0.035} smoothness={4} position={[x, 1.04, 0]} castShadow>
          <meshStandardMaterial color={METAL} metalness={0.58} roughness={0.38} />
        </RoundedBox>
      ))}
      <RoundedBox args={[width + 0.12, 0.18, 0.2]} radius={0.05} smoothness={4} position={[0, 2.02, 0]} castShadow>
        <meshStandardMaterial color="#252e38" metalness={0.52} roughness={0.42} />
      </RoundedBox>
      {isRestroom && (
        <>
          <RoundedBox args={[0.54, 1.72, 0.08]} radius={0.025} smoothness={4} position={[-0.32, 0.91, -0.05]} castShadow receiveShadow>
            <meshStandardMaterial color="#313a43" metalness={0.18} roughness={0.66} />
          </RoundedBox>
          <mesh position={[-0.09, 0.92, 0.005]} castShadow>
            <boxGeometry args={[0.025, 0.12, 0.035]} />
            <meshStandardMaterial color="#b7c4ce" metalness={0.58} roughness={0.32} />
          </mesh>
        </>
      )}
      <RoundedBox args={[0.72, 0.28, 0.08]} radius={0.045} smoothness={4} position={[0, 1.79, 0.12]} castShadow>
        <meshStandardMaterial color="#151b22" metalness={0.24} roughness={0.68} />
      </RoundedBox>
      <group position={[0, 1.31, 0.17]} scale={0.72}>
        {kind === 'restroom' ? <RestroomIcon accent={accent} /> : <DiningIcon accent={accent} />}
      </group>
      <mesh position={[0, 1.62, 0.17]}>
        <boxGeometry args={[0.42, 0.024, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.22} toneMapped={false} />
      </mesh>
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
      <RoundedBox args={[1.5, 0.08, 1.28]} radius={0.055} smoothness={4} position={[0, 0.04, 0]} receiveShadow>
        <meshStandardMaterial color="#202731" metalness={0.14} roughness={0.76} />
      </RoundedBox>
      <RoundedBox args={[1.46, 1.74, 0.08]} radius={0.035} smoothness={4} position={[0, 0.9, -0.58]} castShadow receiveShadow>
        <meshStandardMaterial color="#303944" metalness={0.16} roughness={0.7} />
      </RoundedBox>
      {[-0.72, 0.72].map((x) => (
        <RoundedBox key={`restroom-partition-${x}`} args={[0.08, 1.55, 1.16]} radius={0.03} smoothness={4} position={[x, 0.8, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={PANEL_DARK} metalness={0.18} roughness={0.74} />
        </RoundedBox>
      ))}

      <group position={[-0.31, 0, -0.08]}>
        <RoundedBox args={[0.42, 0.34, 0.5]} radius={0.12} smoothness={6} position={[0, 0.2, 0.02]} castShadow receiveShadow>
          <meshStandardMaterial color="#d4dbe0" metalness={0.04} roughness={0.46} />
        </RoundedBox>
        <mesh position={[0, 0.4, 0.05]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <torusGeometry args={[0.16, 0.035, 14, 40]} />
          <meshStandardMaterial color="#eef2f4" metalness={0.03} roughness={0.38} />
        </mesh>
        <RoundedBox args={[0.4, 0.5, 0.2]} radius={0.055} smoothness={4} position={[0, 0.62, -0.19]} castShadow>
          <meshStandardMaterial color="#c6d0d7" metalness={0.06} roughness={0.48} />
        </RoundedBox>
        <mesh position={[0, 0.75, -0.08]}>
          <boxGeometry args={[0.16, 0.018, 0.025]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.12} toneMapped={false} />
        </mesh>
      </group>

      <group position={[0.34, 0, -0.13]}>
        <RoundedBox args={[0.5, 0.62, 0.42]} radius={0.055} smoothness={4} position={[0, 0.32, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#46525e" metalness={0.28} roughness={0.58} />
        </RoundedBox>
        <RoundedBox args={[0.56, 0.07, 0.48]} radius={0.045} smoothness={4} position={[0, 0.66, 0]} castShadow>
          <meshStandardMaterial color="#c4ced5" metalness={0.14} roughness={0.42} />
        </RoundedBox>
        <mesh position={[0, 0.695, 0]}>
          <cylinderGeometry args={[0.17, 0.13, 0.035, 32]} />
          <meshStandardMaterial color="#e3e8eb" metalness={0.04} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.82, -0.08]} castShadow>
          <cylinderGeometry args={[0.018, 0.018, 0.24, 16]} />
          <meshStandardMaterial color="#8f9ba5" metalness={0.72} roughness={0.28} />
        </mesh>
        <mesh position={[0, 0.93, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <torusGeometry args={[0.08, 0.014, 10, 28, Math.PI]} />
          <meshStandardMaterial color="#8f9ba5" metalness={0.72} roughness={0.28} />
        </mesh>
        <RoundedBox args={[0.48, 0.56, 0.035]} radius={0.035} smoothness={4} position={[0, 1.18, -0.24]} castShadow>
          <meshStandardMaterial color="#71818c" metalness={0.62} roughness={0.2} />
        </RoundedBox>
      </group>
      <Strip position={[0, 0.06, 0.52]} size={[1.08, 0.014, 0.06]} color={accent} opacity={0.18} />
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
      <RoundedBox args={[1.78, 0.08, 1.52]} radius={0.06} smoothness={4} position={[0, 0.04, -0.12]} receiveShadow>
        <meshStandardMaterial color="#202731" metalness={0.14} roughness={0.78} />
      </RoundedBox>
      <RoundedBox args={[1.52, 0.82, 0.54]} radius={0.075} smoothness={5} position={[0, 0.43, 0.24]} castShadow receiveShadow>
        <meshStandardMaterial color="#35414c" metalness={0.22} roughness={0.62} />
      </RoundedBox>
      <RoundedBox args={[1.62, 0.08, 0.64]} radius={0.05} smoothness={4} position={[0, 0.87, 0.24]} castShadow>
        <meshStandardMaterial color="#aeb9c2" metalness={0.2} roughness={0.42} />
      </RoundedBox>
      <RoundedBox args={[0.4, 1.58, 0.5]} radius={0.055} smoothness={4} position={[-0.54, 0.8, 0.18]} castShadow receiveShadow>
        <meshStandardMaterial color="#222a34" metalness={0.34} roughness={0.54} />
      </RoundedBox>
      <mesh position={[-0.54, 0.86, 0.445]}>
        <boxGeometry args={[0.26, 0.9, 0.02]} />
        <meshStandardMaterial color="#17232d" emissive="#243944" emissiveIntensity={0.12} roughness={0.32} />
      </mesh>
      <mesh position={[-0.39, 0.84, 0.462]} castShadow>
        <boxGeometry args={[0.018, 0.32, 0.025]} />
        <meshStandardMaterial color="#aeb9c2" metalness={0.5} roughness={0.32} />
      </mesh>

      <group position={[0.2, 0, -0.62]}>
        <mesh position={[0, 0.71, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.42, 0.42, 0.075, 40]} />
          <meshStandardMaterial color="#6f7b85" metalness={0.16} roughness={0.58} />
        </mesh>
        <mesh position={[0, 0.37, 0]} castShadow>
          <cylinderGeometry args={[0.065, 0.11, 0.68, 24]} />
          <meshStandardMaterial color={METAL} metalness={0.6} roughness={0.38} />
        </mesh>
        <mesh position={[0, 0.05, 0]} receiveShadow>
          <cylinderGeometry args={[0.3, 0.3, 0.045, 32]} />
          <meshStandardMaterial color="#242c35" metalness={0.32} roughness={0.62} />
        </mesh>
        <mesh position={[0.03, 0.76, 0]}>
          <cylinderGeometry args={[0.18, 0.18, 0.025, 32]} />
          <meshStandardMaterial color="#d8dee2" metalness={0.04} roughness={0.45} />
        </mesh>
        <mesh position={[0.04, 0.79, 0]}>
          <cylinderGeometry args={[0.1, 0.1, 0.015, 32]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.08} roughness={0.5} />
        </mesh>
      </group>
      {[
        [-0.34, -0.74],
        [0.7, -0.58],
        [0.25, -1.08]
      ].map(([x, z], index) => (
        <group key={`dining-seat-${index}`} position={[x, 0, z]}>
          <RoundedBox args={[0.34, 0.08, 0.34]} radius={0.07} smoothness={4} position={[0, 0.46, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#48545f" roughness={0.62} metalness={0.12} />
          </RoundedBox>
          <mesh position={[0, 0.24, 0]} castShadow>
            <cylinderGeometry args={[0.035, 0.055, 0.42, 16]} />
            <meshStandardMaterial color={METAL} metalness={0.54} roughness={0.4} />
          </mesh>
          <mesh position={[0, 0.035, 0]} receiveShadow>
            <cylinderGeometry args={[0.15, 0.15, 0.035, 24]} />
            <meshStandardMaterial color="#242c35" metalness={0.3} roughness={0.64} />
          </mesh>
        </group>
      ))}
      <Strip position={[0.18, 0.06, -0.62]} size={[1.28, 0.014, 1.05]} color={accent} opacity={0.12} />
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
      <Strip position={[-3.72, 0.044, 3.62]} size={[0.07, 0.014, 4.4]} color={DINING} opacity={0.26} />
      <Strip position={[-5.84, 0.044, 5.92]} size={[4.24, 0.014, 0.07]} color={DINING} opacity={0.28} />

      <Waypoint position={[4.18, 0.052, 0.74]} color={APPROVAL} radius={0.18} />
      <Waypoint position={[4.86, 0.052, 1.82]} color={CYAN} radius={0.16} />
      <Waypoint position={[-8, 0.05, 4.65]} color={CYAN} radius={0.15} />
      <Waypoint position={[-5, 0.05, 6]} color={DINING} radius={0.15} />

      {/* 侧边设施入口:真实办公室里的卫生间/餐饮不放在控制室中心,只保留走廊入口信号。 */}
      <FacilityPortal position={[-8, 0, 4.65]} rotation={[0, 0.18, 0]} accent={CYAN} kind="restroom" />
      <FacilityPortal position={[-5, 0, 6]} rotation={[0, 0.08, 0]} accent={DINING} kind="dining" />
      <RestroomFixture position={[-8.04, 0, 5.34]} rotation={[0, 0.18, 0]} accent={CYAN} />
      <DiningFixture position={[-4.45, 0, 6.55]} rotation={[0, 0.08, 0]} accent={DINING} />
    </group>
  )
}
