import { useMemo } from 'react'
import type { OfficeProp } from './Floor'

/** 房间四边中要留空的一面(给 WindowWall 用) */
type OpenSide = 'front' | 'back' | 'left' | 'right'

interface WallsProps extends OfficeProp {
  /** 房间内边长(米,正方形),默认 20 */
  size?: number
  /** 墙高(米),默认 4 */
  height?: number
  /** 墙体厚度(米),默认 0.2 */
  thickness?: number
  /** 留空给窗的一面,默认 'front'(+Z,面向相机) */
  openSide?: OpenSide
  /** 额外留空的墙面,用于剖切展示视角避开相机前景 */
  openSides?: OpenSide[]
  /** 墙面色(深灰哑光),默认 #1c1c1c */
  color?: string
  /** 踢脚线色,默认略深 #121212 */
  baseColor?: string
  /** 剖切展示模式:保留边界感,降低墙面高度避免挡住办公主体 */
  cutaway?: boolean
  /** 剖切展示模式下的墙高,默认只保留低矮边界 */
  cutawayHeight?: number
}

const DEFAULT_SIZE = 20
const DEFAULT_HEIGHT = 4
const DEFAULT_THICKNESS = 0.2
const DEFAULT_COLOR = '#1c1c1c'
const DEFAULT_BASE_COLOR = '#121212'

const BASEBOARD_HEIGHT = 0.14
const BASEBOARD_PROUD = 0.015

interface WallSpec {
  key: OpenSide
  /** 墙体中心 */
  position: [number, number, number]
  /** 墙沿其展开的长度(内边长) */
  length: number
  /** 是否沿 X 轴展开(否则沿 Z 轴) */
  alongX: boolean
  /** 踢脚线朝房间内侧偏移的方向(单位向量分量) */
  inward: [number, number]
}

/**
 * 房间三面墙 + 踢脚线:深灰哑光,留出一面给窗(WindowWall 单独做)。
 * 墙体用带厚度的 boxGeometry 生成,内壁正好落在 ±size/2 上、朝房间内;
 * boxGeometry 六面皆可见,故内壁始终有面可渲染。踢脚线为略深的薄条,
 * 沿内壁底部微微向内探出,增强写实转角。无发光材质,统一走 Bloom 前的哑光基调。
 */
export default function Walls({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  size = DEFAULT_SIZE,
  height = DEFAULT_HEIGHT,
  thickness = DEFAULT_THICKNESS,
  openSide = 'front',
  openSides = [],
  color = DEFAULT_COLOR,
  baseColor = DEFAULT_BASE_COLOR,
  cutaway = false,
  cutawayHeight = 0.72
}: WallsProps): React.JSX.Element {
  const half = size / 2
  const wallHeight = cutaway ? Math.min(height, cutawayHeight) : height

  // 四面墙规格;内壁贴合 ±half,墙体中心再向外挪 thickness/2
  const walls = useMemo<WallSpec[]>(() => {
    const outer = half + thickness / 2
    return [
      // 后墙(-Z),内壁面向 +Z
      { key: 'back', position: [0, wallHeight / 2, -outer], length: size, alongX: true, inward: [0, 1] },
      // 前墙(+Z),内壁面向 -Z
      { key: 'front', position: [0, wallHeight / 2, outer], length: size, alongX: true, inward: [0, -1] },
      // 左墙(-X),内壁面向 +X
      { key: 'left', position: [-outer, wallHeight / 2, 0], length: size, alongX: false, inward: [1, 0] },
      // 右墙(+X),内壁面向 -X
      { key: 'right', position: [outer, wallHeight / 2, 0], length: size, alongX: false, inward: [-1, 0] }
    ]
  }, [half, size, wallHeight, thickness])

  const visible = useMemo(() => {
    const open = new Set<OpenSide>([openSide, ...openSides])
    return walls.filter((w) => !open.has(w.key))
  }, [walls, openSide, openSides])

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {visible.map((w) => {
        // 墙体尺寸:沿展开轴用 length,另一水平轴用 thickness
        const wallArgs: [number, number, number] = w.alongX
          ? [w.length, wallHeight, thickness]
          : [thickness, wallHeight, w.length]

        // 踢脚线:比墙略窄,厚度稍大于墙厚以探出内壁
        const baseDepth = thickness + BASEBOARD_PROUD
        const baseArgs: [number, number, number] = w.alongX
          ? [w.length, BASEBOARD_HEIGHT, baseDepth]
          : [baseDepth, BASEBOARD_HEIGHT, w.length]

        // 踢脚线中心:贴地(y=BASEBOARD_HEIGHT/2),并沿内向探出半个探出量
        const bx = w.position[0] + w.inward[0] * (BASEBOARD_PROUD / 2)
        const bz = w.position[2] + w.inward[1] * (BASEBOARD_PROUD / 2)

        return (
          <group key={w.key}>
            {!cutaway && (
              <mesh position={w.position} castShadow receiveShadow>
                <boxGeometry args={wallArgs} />
                <meshStandardMaterial color={color} metalness={0.05} roughness={0.95} />
              </mesh>
            )}
            {cutaway && (
              <mesh position={[w.position[0], wallHeight, w.position[2]]} castShadow receiveShadow>
                <boxGeometry args={w.alongX ? [w.length, 0.035, thickness] : [thickness, 0.035, w.length]} />
                <meshStandardMaterial
                  color="#26313b"
                  metalness={0.14}
                  roughness={0.74}
                  transparent
                  opacity={0.42}
                />
              </mesh>
            )}
            <mesh position={[bx, BASEBOARD_HEIGHT / 2, bz]} castShadow receiveShadow>
              <boxGeometry args={baseArgs} />
              <meshStandardMaterial color={baseColor} metalness={0.08} roughness={0.9} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}
