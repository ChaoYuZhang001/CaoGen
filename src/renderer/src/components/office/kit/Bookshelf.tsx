import { useLayoutEffect, useMemo, useRef } from 'react'
import { Color, Object3D } from 'three'
import type { InstancedMesh } from 'three'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

// 书架整体尺寸(米):宽 × 高 × 深
const WIDTH = 1.0
const HEIGHT = 1.9
const DEPTH = 0.3
const FRAME = 0.04 // 框架/隔板厚度
const SHELVES = 5 // 隔板层数(=> 4 个可放书的格子)

// 书脊配色:克制的中性 + 少量青色强调,风格与主黑副白一致
const BOOK_COLORS = [
  '#3a4150',
  '#2c313c',
  '#4a5262',
  '#5b6472',
  '#6b5540',
  '#7a4436',
  '#3d5a52',
  '#8fe9ff',
  '#c9c2b4',
  '#455066'
]

interface Book {
  x: number
  y: number
  w: number
  h: number
  color: string
}

// 稳定的伪随机:同一 seed 每次渲染布局一致(避免 useFrame 外 new)
function rand(seed: number): number {
  const v = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return v - Math.floor(v)
}

/**
 * 书架:实体框架 + 多层隔板,每个隔层用循环填满一排排颜色各异的书。
 * 书体用单个 instancedMesh 绘制(逐实例矩阵 + 逐实例颜色),控制 draw call。
 */
export default function Bookshelf({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  const booksRef = useRef<InstancedMesh>(null)

  // 可放书区域:去掉左右侧板与顶底板
  const innerW = WIDTH - FRAME * 2
  const innerH = HEIGHT - FRAME * 2
  const gap = (innerH - SHELVES * FRAME) / (SHELVES - 1) // 相邻隔板间净高

  // 每层隔板的中心 Y(自底向上)
  const shelfYs = useMemo(() => {
    const ys: number[] = []
    for (let i = 0; i < SHELVES; i++) {
      ys.push(FRAME / 2 + i * (gap + FRAME))
    }
    return ys
  }, [gap])

  // 生成每一排的书:自左向右填充,直到该层剩余宽度不足
  const books = useMemo(() => {
    const out: Book[] = []
    const left = -innerW / 2
    let seed = 1
    for (let s = 0; s < SHELVES - 1; s++) {
      const shelfTop = shelfYs[s] + FRAME / 2 // 该层书本立于此面
      let cursor = 0.01
      while (cursor < innerW - 0.02) {
        const w = 0.03 + rand(seed++) * 0.05 // 书脊厚度
        if (cursor + w > innerW - 0.01) break
        const h = gap * (0.62 + rand(seed++) * 0.32) // 书高不超过格子净高
        const color = BOOK_COLORS[Math.floor(rand(seed++) * BOOK_COLORS.length)]
        out.push({
          x: left + cursor + w / 2,
          y: shelfTop + h / 2,
          w,
          h,
          color
        })
        cursor += w + 0.004 // 书间微缝
      }
    }
    return out
  }, [innerW, gap, shelfYs])

  // 逐实例写入变换与颜色
  useLayoutEffect(() => {
    const mesh = booksRef.current
    if (!mesh) return
    const dummy = new Object3D()
    const col = new Color()
    const bookDepth = DEPTH - FRAME * 2 - 0.02
    for (let i = 0; i < books.length; i++) {
      const b = books[i]
      dummy.position.set(b.x, b.y, 0)
      dummy.scale.set(b.w, b.h, bookDepth)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      mesh.setColorAt(i, col.set(b.color))
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [books])

  const shelfColor = '#20242c'
  const backColor = '#181b22'

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 侧板 ×2 */}
      <mesh position={[-WIDTH / 2 + FRAME / 2, HEIGHT / 2, 0]} castShadow>
        <boxGeometry args={[FRAME, HEIGHT, DEPTH]} />
        <meshStandardMaterial color={shelfColor} roughness={0.8} />
      </mesh>
      <mesh position={[WIDTH / 2 - FRAME / 2, HEIGHT / 2, 0]} castShadow>
        <boxGeometry args={[FRAME, HEIGHT, DEPTH]} />
        <meshStandardMaterial color={shelfColor} roughness={0.8} />
      </mesh>

      {/* 背板 */}
      <mesh position={[0, HEIGHT / 2, -DEPTH / 2 + FRAME / 2]} receiveShadow>
        <boxGeometry args={[WIDTH, HEIGHT, FRAME]} />
        <meshStandardMaterial color={backColor} roughness={0.9} />
      </mesh>

      {/* 隔板层 */}
      {shelfYs.map((y, i) => (
        <mesh key={i} position={[0, y, 0]} castShadow receiveShadow>
          <boxGeometry args={[innerW, FRAME, DEPTH - FRAME]} />
          <meshStandardMaterial color={shelfColor} roughness={0.8} />
        </mesh>
      ))}

      {/* 一排排书(单 instancedMesh,逐实例颜色) */}
      <instancedMesh
        ref={booksRef}
        args={[undefined, undefined, books.length]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.65} metalness={0.05} />
      </instancedMesh>
    </group>
  )
}
