import type { OfficeProp } from './Floor'
import Floor from './Floor'
import Walls from './Walls'
import WindowWall from './WindowWall'
import Ceiling from './Ceiling'
import ServerRack from './ServerRack'
import ApprovalStation from './ApprovalStation'
import SideGlassCorridor from './SideGlassCorridor'
import ArchitecturalLightBands from './ArchitecturalLightBands'
import WorkZoneGlass from './WorkZoneGlass'
import OperationsBackplane from './OperationsBackplane'
import CommandCenterStations from './CommandCenterStations'
import type { CommandCenterSignals } from './CommandCenterStations'
import { CONTROL_ROOM_LAYOUT } from './controlRoomLayout'
import Plant from './Plant'

// 房间参数(米):内边长 20 => 墙内壁落在 ±10;中央 x/z∈[-6,6] 留给工位网格。
// 墙高与落地窗同高(5m),吊顶下移至 5m 与墙顶对齐(Ceiling 内部烘焙在 6.2m)。
const ROOM = 20
const WALL_H = 5
const CEILING_BAKED_Y = 6.2

/**
 * 共享控制室布景层(不含数字员工工位):建筑外壳、三类业务设备、中央总控、
 * Artifact 资产库、审批台以及 Provider / 渲染基础设施。
 *
 * 核心工位网格 x∈[-6,6]、z∈[-5,3] 留空,前缘可放服务设施。
 * 所有子件均为 kit 内既有模块,纯代码几何,统一由 OfficeView 的灯光/阴影渲染。
 */
export default function OfficeScene({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  lightMode = false,
  signals = { assistant: 0, project: 0, video: 0, incidents: 0 }
}: OfficeProp & { lightMode?: boolean; signals?: CommandCenterSignals }): React.JSX.Element {
  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* ---- 建筑外壳 ---- */}
      {/* 地板:略大于房间,铺到墙下 */}
      <Floor
        size={ROOM + 2}
        color={lightMode ? '#a7b1b7' : '#1d232b'}
        seamMainColor={lightMode ? '#6f7d86' : '#2a2a2a'}
        seamSubColor={lightMode ? '#bcc4c9' : '#1c1c1c'}
      />

      {/* 建筑光带:贴边/高位/贴地,提升夜间层次,不放在相机和工位之间。 */}
      <ArchitecturalLightBands presentationMode />

      {/* 中央贴地玻璃边界:建立真实办公区边界,不挡机器人和工位。 */}
      <WorkZoneGlass />

      {/* 运营背板 + 数据总线:让空间像真实控制室,但全部处于后景/贴地不遮挡主体。 */}
      <OperationsBackplane />

      {/* 默认验收视角是剖切展示:保留后窗空间感,打开前/左/右实体墙避免遮挡工位。 */}
      <Walls size={ROOM} height={WALL_H} openSide="back" openSides={['front', 'left', 'right']} cutaway cutawayHeight={0.12} />

      {/* 落地窗幕墙:填充后墙开口(玻璃贴内壁线 z=-10,窗外城市在更远 -Z) */}
      <WindowWall position={[0, 0, -ROOM / 2]} minimalFrames lightMode={lightMode} />

      {/* 左侧剖切玻璃走廊:补足开放视角里的侧向外景,避免黑色空背景像墙面遮挡。 */}
      <SideGlassCorridor presentationMode />

      {/* 吊顶:下移至 y=WALL_H,与墙顶/窗顶对齐;默认剖切视角隐藏实体,避免遮挡办公区 */}
      <Ceiling position={[0, WALL_H - CEILING_BAKED_Y, 0]} presentationMode />

      {/* 助手、项目、视频和中央指挥四类设施。所有信号均来自真实只读投影。 */}
      <CommandCenterStations signals={signals} />

      {/* Provider / 模型路由 / 视频渲染共用算力机架。 */}
      <ServerRack position={CONTROL_ROOM_LAYOUT.infrastructure} scale={1.16} />

      {/* 中央审批台处理授权、暂停、恢复和重试。 */}
      <ApprovalStation position={CONTROL_ROOM_LAYOUT.approval} scale={1.02} />

      {/* ---- 盆栽点缀 ---- */}
      {/* 后墙两角(落地窗两侧)，仅用于空间层次，不占用业务首屏。 */}
      <Plant position={[-8, 0, -8]} kind="tall" />
      <Plant position={[8, 0, -8]} kind="tall" />
    </group>
  )
}
