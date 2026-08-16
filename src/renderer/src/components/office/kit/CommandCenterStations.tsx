import { RoundedBox } from '@react-three/drei'
import type { OfficeProp } from './Floor'
import { CONTROL_ROOM_LAYOUT } from './controlRoomLayout'

export interface CommandCenterSignals {
  assistant: number
  project: number
  video: number
  incidents: number
}

const ASSISTANT = '#78aebe'
const PROJECT = '#7f9f86'
const VIDEO = '#b98b66'
const COMMAND = '#9aa8b3'
const INCIDENT = '#bd6862'
const FRAME = '#242d36'
const FRAME_LIGHT = '#394550'
const PANEL = '#101820'
const GLASS = '#8496a5'
const DIM = '#3a4650'

function SignalBars({ count, accent, length = 5 }: { count: number; accent: string; length?: number }): React.JSX.Element {
  const active = Math.min(length, Math.max(0, count))
  return (
    <group>
      {Array.from({ length }, (_, index) => (
        <mesh key={index} position={[-((length - 1) * 0.09) + index * 0.18, 0, 0]}>
          <boxGeometry args={[0.12, 0.035, 0.025]} />
          <meshStandardMaterial
            color={index < active ? accent : DIM}
            emissive={index < active ? accent : '#000000'}
            emissiveIntensity={index < active ? 0.34 : 0}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  )
}

function ZonePad({ accent, width = 3.1, depth = 2.2 }: { accent: string; width?: number; depth?: number }): React.JSX.Element {
  return (
    <group>
      <RoundedBox args={[width, 0.055, depth]} radius={0.08} smoothness={3} position={[0, 0.035, 0]} receiveShadow>
        <meshStandardMaterial color="#202a32" metalness={0.25} roughness={0.7} transparent opacity={0.72} />
      </RoundedBox>
      {[-0.34, 0, 0.34].map((x) => (
        <mesh key={x} position={[x, 0.072, depth / 2 - 0.12]}>
          <boxGeometry args={[0.22, 0.012, 0.035]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.2} transparent opacity={0.62} toneMapped={false} />
        </mesh>
      ))}
    </group>
  )
}

function ScreenShell({ position, size, accent }: {
  position: [number, number, number]
  size: [number, number]
  accent: string
}): React.JSX.Element {
  return (
    <group position={position}>
      <RoundedBox args={[size[0], size[1], 0.09]} radius={0.055} smoothness={4} castShadow>
        <meshStandardMaterial color={PANEL} metalness={0.32} roughness={0.45} />
      </RoundedBox>
      <mesh position={[0, 0, 0.052]}>
        <planeGeometry args={[size[0] - 0.16, size[1] - 0.15]} />
        <meshStandardMaterial color={GLASS} emissive={accent} emissiveIntensity={0.055} transparent opacity={0.18} toneMapped={false} />
      </mesh>
    </group>
  )
}

function AssistantConsole({ count }: { count: number }): React.JSX.Element {
  return (
    <group position={CONTROL_ROOM_LAYOUT.assistant.station}>
      <ZonePad accent={ASSISTANT} width={3.35} depth={2.25} />
      <RoundedBox args={[2.75, 0.13, 0.9]} radius={0.07} smoothness={4} position={[0, 0.75, 0.22]} castShadow>
        <meshStandardMaterial color={FRAME} metalness={0.42} roughness={0.48} />
      </RoundedBox>
      <ScreenShell position={[0, 1.42, -0.25]} size={[2.55, 1.1]} accent={ASSISTANT} />

      {/* 左侧对话流、中央文档、右侧工具结果，让设备远看也具有助手语义。 */}
      {[-0.84, -0.66, -0.8].map((x, index) => (
        <RoundedBox key={`assistant-message-${index}`} args={[0.58 + index * 0.06, 0.13, 0.025]} radius={0.035} smoothness={3} position={[x, 1.68 - index * 0.27, -0.188]}>
          <meshStandardMaterial color={index === 1 ? ASSISTANT : '#667681'} emissive={index === 1 ? ASSISTANT : '#000000'} emissiveIntensity={0.2} toneMapped={false} />
        </RoundedBox>
      ))}
      <group position={[0.05, 1.43, -0.185]}>
        <mesh>
          <planeGeometry args={[0.72, 0.72]} />
          <meshStandardMaterial color="#aeb9c0" roughness={0.7} />
        </mesh>
        {[0.21, 0.07, -0.07, -0.21].map((y, index) => (
          <mesh key={y} position={[-0.04, y, 0.018]}>
            <boxGeometry args={[index === 3 ? 0.38 : 0.5, 0.022, 0.01]} />
            <meshStandardMaterial color={index === 0 ? ASSISTANT : '#586671'} emissive={index === 0 ? ASSISTANT : '#000000'} emissiveIntensity={0.18} toneMapped={false} />
          </mesh>
        ))}
      </group>
      {[-0.84, -0.55, -0.26].map((y, index) => (
        <group key={`assistant-tool-${index}`} position={[0.83, 1.74 + y, -0.184]}>
          <mesh position={[-0.2, 0, 0]}><boxGeometry args={[0.09, 0.09, 0.02]} /><meshStandardMaterial color={index === 0 ? ASSISTANT : FRAME_LIGHT} emissive={index === 0 ? ASSISTANT : '#000000'} emissiveIntensity={0.18} /></mesh>
          <mesh position={[0.1, 0, 0]}><boxGeometry args={[0.4, 0.035, 0.018]} /><meshStandardMaterial color="#667681" /></mesh>
        </group>
      ))}
      <group position={[0, 0.84, 0.68]}><SignalBars count={count} accent={ASSISTANT} /></group>
      {[-1.02, 1.02].map((x) => (
        <mesh key={x} position={[x, 0.36, 0.22]} castShadow><boxGeometry args={[0.11, 0.72, 0.11]} /><meshStandardMaterial color={FRAME} metalness={0.5} roughness={0.42} /></mesh>
      ))}
    </group>
  )
}

function ProjectBoard({ count }: { count: number }): React.JSX.Element {
  const nodes: Array<[number, number]> = [[-0.9, 0.32], [0, 0.32], [0.9, 0.32], [-0.45, -0.28], [0.45, -0.28]]
  return (
    <group position={CONTROL_ROOM_LAYOUT.project.station}>
      <ZonePad accent={PROJECT} width={4.3} depth={2.05} />
      <ScreenShell position={[0, 1.62, -0.12]} size={[3.65, 1.72]} accent={PROJECT} />
      {nodes.map(([x, y], index) => (
        <group key={index} position={[x, 1.6 + y, -0.062]}>
          {index > 2 && (
            <mesh position={[index === 3 ? 0.23 : -0.23, 0.31, -0.008]} rotation={[0, 0, index === 3 ? -0.94 : 0.94]}>
              <boxGeometry args={[0.035, 0.72, 0.018]} />
              <meshStandardMaterial color={PROJECT} emissive={PROJECT} emissiveIntensity={0.2} transparent opacity={0.58} toneMapped={false} />
            </mesh>
          )}
          <RoundedBox args={[0.54, 0.25, 0.04]} radius={0.045} smoothness={3}>
            <meshStandardMaterial color={index < Math.min(count, nodes.length) ? PROJECT : DIM} emissive={index < Math.min(count, nodes.length) ? PROJECT : '#000000'} emissiveIntensity={0.25} toneMapped={false} />
          </RoundedBox>
          <mesh position={[0, -0.07, 0.028]}><boxGeometry args={[0.32, 0.024, 0.015]} /><meshStandardMaterial color="#22303a" /></mesh>
        </group>
      ))}
      <group position={[0, 0.52, 0.44]}><SignalBars count={count} accent={PROJECT} length={7} /></group>
      {[-1.58, 1.58].map((x) => (
        <mesh key={x} position={[x, 0.68, -0.08]} castShadow><boxGeometry args={[0.1, 1.36, 0.14]} /><meshStandardMaterial color={FRAME} metalness={0.46} roughness={0.46} /></mesh>
      ))}
    </group>
  )
}

function VideoDeck({ count }: { count: number }): React.JSX.Element {
  return (
    <group position={CONTROL_ROOM_LAYOUT.video.station}>
      <ZonePad accent={VIDEO} width={3.55} depth={2.25} />
      <RoundedBox args={[2.9, 0.13, 0.94]} radius={0.07} smoothness={4} position={[0, 0.75, 0.2]} castShadow>
        <meshStandardMaterial color={FRAME} metalness={0.44} roughness={0.44} />
      </RoundedBox>
      <ScreenShell position={[0, 1.47, -0.27]} size={[2.8, 1.22]} accent={VIDEO} />
      {[-0.88, 0, 0.88].map((x, index) => (
        <group key={x} position={[x, 1.56, -0.208]}>
          <mesh><planeGeometry args={[0.7, 0.64]} /><meshStandardMaterial color={index < Math.min(count, 3) ? '#4b3c33' : '#28343d'} emissive={index < Math.min(count, 3) ? VIDEO : '#000000'} emissiveIntensity={index < Math.min(count, 3) ? 0.11 : 0} /></mesh>
          <mesh position={[0, 0, 0.014]} rotation={[0, 0, -Math.PI / 2]}><coneGeometry args={[0.1, 0.17, 3]} /><meshStandardMaterial color={VIDEO} emissive={VIDEO} emissiveIntensity={0.38} toneMapped={false} /></mesh>
        </group>
      ))}
      <group position={[0, 1.03, -0.204]}>
        <mesh><boxGeometry args={[2.35, 0.055, 0.018]} /><meshStandardMaterial color="#28343d" /></mesh>
        {[-0.88, -0.4, 0.2, 0.72].map((x, index) => (
          <mesh key={x} position={[x, 0, 0.012]}><boxGeometry args={[index % 2 === 0 ? 0.34 : 0.22, 0.036, 0.012]} /><meshStandardMaterial color={index < Math.min(count, 4) ? VIDEO : DIM} emissive={index < Math.min(count, 4) ? VIDEO : '#000000'} emissiveIntensity={0.2} /></mesh>
        ))}
      </group>
      <group position={[0, 0.84, 0.7]}><SignalBars count={count} accent={VIDEO} /></group>
      {[-1.08, 1.08].map((x) => (
        <mesh key={x} position={[x, 0.36, 0.2]} castShadow><boxGeometry args={[0.11, 0.72, 0.11]} /><meshStandardMaterial color={FRAME} metalness={0.5} roughness={0.42} /></mesh>
      ))}
    </group>
  )
}

function CommandCore({ signals }: { signals: CommandCenterSignals }): React.JSX.Element {
  const accent = signals.incidents > 0 ? INCIDENT : COMMAND
  const rows = [[ASSISTANT, signals.assistant], [PROJECT, signals.project], [VIDEO, signals.video]] as const
  return (
    <group position={CONTROL_ROOM_LAYOUT.command}>
      <mesh position={[0, 0.045, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.8, 1.94, 64]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={signals.incidents > 0 ? 0.3 : 0.1} transparent opacity={0.62} toneMapped={false} />
      </mesh>
      <RoundedBox args={[1.65, 0.64, 1.05]} radius={0.1} smoothness={4} position={[0, 0.35, 0]} castShadow>
        <meshStandardMaterial color={FRAME} metalness={0.45} roughness={0.46} />
      </RoundedBox>
      <group position={[0, 0.84, 0.03]} rotation={[-0.34, 0, 0]}>
        <RoundedBox args={[1.52, 0.76, 0.08]} radius={0.06} smoothness={4} castShadow>
          <meshStandardMaterial color={PANEL} metalness={0.34} roughness={0.45} />
        </RoundedBox>
        {rows.map(([color, count], index) => (
          <group key={color} position={[-0.04, 0.22 - index * 0.22, 0.052]}>
            <mesh position={[-0.58, 0, 0]}><boxGeometry args={[0.09, 0.09, 0.025]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.32} toneMapped={false} /></mesh>
            <SignalBars count={count} accent={color} length={5} />
          </group>
        ))}
      </group>
      <group position={[0, 1.48, -0.26]}>
        <RoundedBox args={[0.64, 0.22, 0.07]} radius={0.045} smoothness={3}>
          <meshStandardMaterial color={PANEL} metalness={0.34} roughness={0.44} />
        </RoundedBox>
        {[-0.2, 0, 0.2].map((x, index) => (
          <mesh key={x} position={[x, 0, 0.045]}><boxGeometry args={[0.09, 0.08, 0.02]} /><meshStandardMaterial color={index < Math.min(signals.incidents, 3) ? INCIDENT : COMMAND} emissive={index < Math.min(signals.incidents, 3) ? INCIDENT : '#000000'} emissiveIntensity={0.35} toneMapped={false} /></mesh>
        ))}
        <mesh position={[0, -0.28, -0.01]}><boxGeometry args={[0.08, 0.38, 0.08]} /><meshStandardMaterial color={FRAME_LIGHT} metalness={0.5} roughness={0.4} /></mesh>
      </group>
    </group>
  )
}

function ArtifactVault(): React.JSX.Element {
  return (
    <group position={CONTROL_ROOM_LAYOUT.artifact}>
      <ZonePad accent={ASSISTANT} width={2.15} depth={1.55} />
      <RoundedBox args={[1.75, 2.25, 0.62]} radius={0.065} smoothness={4} position={[0, 1.14, 0]} castShadow>
        <meshStandardMaterial color={FRAME} metalness={0.42} roughness={0.5} />
      </RoundedBox>
      {[-0.52, 0, 0.52].map((x) => (
        <group key={x} position={[x, 1.18, 0.34]}>
          {[-0.7, -0.24, 0.24, 0.7].map((y, index) => (
            <RoundedBox key={y} args={[0.34, 0.3, 0.04]} radius={0.03} smoothness={3} position={[0, y, 0]}>
              <meshStandardMaterial color={index % 3 === 0 ? '#526b74' : '#37434d'} emissive={index % 3 === 0 ? ASSISTANT : '#000000'} emissiveIntensity={0.1} toneMapped={false} />
            </RoundedBox>
          ))}
        </group>
      ))}
    </group>
  )
}

export default function CommandCenterStations({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  signals
}: OfficeProp & { signals: CommandCenterSignals }): React.JSX.Element {
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <AssistantConsole count={signals.assistant} />
      <ProjectBoard count={signals.project} />
      <VideoDeck count={signals.video} />
      <CommandCore signals={signals} />
      <ArtifactVault />
    </group>
  )
}
