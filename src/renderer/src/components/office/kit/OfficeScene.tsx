import type { OfficeProp } from './Floor'
import Floor from './Floor'
import Walls from './Walls'
import WindowWall from './WindowWall'
import Ceiling from './Ceiling'
import LoungeSofa from './LoungeSofa'
import AreaRug from './AreaRug'
import MeetingTable from './MeetingTable'
import Bookshelf from './Bookshelf'
import Whiteboard from './Whiteboard'
import ServerRack from './ServerRack'
import CoffeeStation from './CoffeeStation'
import ApprovalStation from './ApprovalStation'
import ServiceWayfinding from './ServiceWayfinding'
import SideGlassCorridor from './SideGlassCorridor'
import ArchitecturalLightBands from './ArchitecturalLightBands'
import WorkZoneGlass from './WorkZoneGlass'
import OperationsBackplane from './OperationsBackplane'
import Plant from './Plant'

// 房间参数(米):内边长 20 => 墙内壁落在 ±10;中央 x/z∈[-6,6] 留给工位网格。
// 墙高与落地窗同高(5m),吊顶下移至 5m 与墙顶对齐(Ceiling 内部烘焙在 6.2m)。
const ROOM = 20
const WALL_H = 5
const CEILING_BAKED_Y = 6.2

// 面向朝向:默认道具正面朝 +Z。
// 贴左墙(-X)朝室内 +X:绕 Y 转 +90°;贴右墙(+X)朝室内 -X:绕 Y 转 -90°。
const FACE_RIGHT = Math.PI / 2
const FACE_LEFT = -Math.PI / 2

/**
 * 办公室布景层(不含工位):地板 + 三面墙 + 落地窗(占后墙)+ 吊顶,
 * 以及沿墙布置的家具道具 —— 前左休息区(沙发 + 地毯 + 盆栽)、前右角会议桌、
 * 左墙书架 + 白板、右墙服务器机架、茶水角、前区审批确认台、服务动线,四角/休息区盆栽点缀。
 *
 * 核心工位网格 x∈[-6,6]、z∈[-5,3] 留空,前缘可放服务设施。
 * 所有子件均为 kit 内既有模块,纯代码几何,统一由 OfficeView 的灯光/阴影渲染。
 */
export default function OfficeScene({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* ---- 建筑外壳 ---- */}
      {/* 地板:略大于房间,铺到墙下 */}
      <Floor size={ROOM + 2} color="#1d232b" />

      {/* 建筑光带:贴边/高位/贴地,提升夜间层次,不放在相机和工位之间。 */}
      <ArchitecturalLightBands presentationMode />

      {/* 中央贴地玻璃边界:建立真实办公区边界,不挡机器人和工位。 */}
      <WorkZoneGlass />

      {/* 运营背板 + 数据总线:让空间像真实控制室,但全部处于后景/贴地不遮挡主体。 */}
      <OperationsBackplane />

      {/* 默认验收视角是剖切展示:保留后窗空间感,打开前/左/右实体墙避免遮挡工位。 */}
      <Walls size={ROOM} height={WALL_H} openSide="back" openSides={['front', 'left', 'right']} cutaway cutawayHeight={0.12} />

      {/* 落地窗幕墙:填充后墙开口(玻璃贴内壁线 z=-10,窗外城市在更远 -Z) */}
      <WindowWall position={[0, 0, -ROOM / 2]} minimalFrames />

      {/* 左侧剖切玻璃走廊:补足开放视角里的侧向外景,避免黑色空背景像墙面遮挡。 */}
      <SideGlassCorridor presentationMode />

      {/* 吊顶:下移至 y=WALL_H,与墙顶/窗顶对齐;默认剖切视角隐藏实体,避免遮挡办公区 */}
      <Ceiling position={[0, WALL_H - CEILING_BAKED_Y, 0]} presentationMode />

      {/* ---- 服务动线:贴地路线 + 卫生间/餐饮侧边入口 ---- */}
      <ServiceWayfinding />

      {/* ---- 前左:休息区 ---- */}
      {/* 地毯划分休息区(青色发光边框呼吸) */}
      <AreaRug position={[-2.5, 0, 8]} scale={1.5} />
      {/* 沙发:背靠前墙(+Z),面朝室内 -Z */}
      <LoungeSofa position={[-2.5, 0, 8.2]} />

      {/* ---- 前右角:会议桌 ---- */}
      <MeetingTable position={[7, 0, 6.5]} seats={4} />

      {/* ---- 左墙(-X):书架 + 白板,正面朝室内 +X ---- */}
      <Bookshelf position={[-9.7, 0, -3]} rotation={[0, FACE_RIGHT, 0]} />
      <Whiteboard position={[-9.6, 0, 3]} rotation={[0, FACE_RIGHT, 0]} />

      {/* ---- 右侧服务区:服务器机架 + 茶水角,正面朝室内 -X ---- */}
      <ServerRack position={[9.55, 0, -4]} rotation={[0, FACE_LEFT, 0]} />
      <CoffeeStation position={[5.48, 0, 2.02]} rotation={[0, FACE_LEFT, 0]} scale={0.9} />

      {/* ---- 前区:审批确认台,等待授权的 Agent 会离席到这里处理确认 ---- */}
      <ApprovalStation position={[5.18, 0, 0.78]} rotation={[0, FACE_LEFT, 0]} scale={0.86} />

      {/* ---- 盆栽点缀 ---- */}
      {/* 后墙两角(落地窗两侧) */}
      <Plant position={[-8, 0, -8]} kind="tall" />
      <Plant position={[8, 0, -8]} kind="tall" />
      {/* 休息区两侧 */}
      <Plant position={[-5, 0, 8.2]} kind="tall" />
      <Plant position={[0.4, 0, 8.4]} kind="tall" />
    </group>
  )
}
