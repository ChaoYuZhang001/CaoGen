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
 * 左墙书架 + 白板、右墙服务器机架 + 茶水角,四角/休息区盆栽点缀。
 *
 * 中央 x∈[-6,6]、z∈[-6,6] 完全留空,交给 OfficeView 的工位网格。
 * 所有子件均为 kit 内既有模块,纯代码几何,统一走 Bloom/暗角后处理。
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
      <Floor size={ROOM + 2} color="#181818" />

      {/* 三面墙:留出后墙(-Z)给落地窗 */}
      <Walls size={ROOM} height={WALL_H} openSide="back" />

      {/* 落地窗幕墙:填充后墙开口(玻璃贴内壁线 z=-10,窗外城市在更远 -Z) */}
      <WindowWall position={[0, 0, -ROOM / 2]} />

      {/* 吊顶:下移至 y=WALL_H,与墙顶/窗顶对齐 */}
      <Ceiling position={[0, WALL_H - CEILING_BAKED_Y, 0]} />

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

      {/* ---- 右墙(+X):服务器机架 + 茶水角,正面朝室内 -X ---- */}
      <ServerRack position={[9.55, 0, -4]} rotation={[0, FACE_LEFT, 0]} />
      <CoffeeStation position={[9.4, 0, 3.5]} rotation={[0, FACE_LEFT, 0]} />

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
