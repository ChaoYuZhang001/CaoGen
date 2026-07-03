import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useStore } from '../../store'
import Workstation from './Workstation'

/** 把会话按网格铺开;返回每个会话的世界坐标 */
function gridPositions(count: number): Array<[number, number, number]> {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  const gap = 3.0
  const out: Array<[number, number, number]> = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const rowCount = Math.ceil(count / cols)
    const x = (col - (cols - 1) / 2) * gap
    const z = (row - (rowCount - 1) / 2) * gap
    out.push([x, 0, z])
  }
  return out
}

export default function OfficeView(): React.JSX.Element {
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const selectSession = useStore((s) => s.selectSession)
  const setView = useStore((s) => s.setView)
  const setShowNewSession = useStore((s) => s.setShowNewSession)

  const ids = order.filter((id) => sessions[id])
  const positions = gridPositions(ids.length)

  const focus = (id: string): void => {
    selectSession(id)
    setView('list')
  }

  return (
    <div className="office">
      <div className="office-topbar drag-region">
        <div className="office-title no-drag">🏢 办公区</div>
        <div className="office-actions no-drag">
          <span className="office-hint">拖拽旋转 · 滚轮缩放 · 点击工位进入会话</span>
          <button className="btn btn-ghost" onClick={() => setShowNewSession(true)}>
            + 新建
          </button>
          <button className="btn btn-primary" onClick={() => setView('list')}>
            列表视图
          </button>
        </div>
      </div>

      {ids.length === 0 ? (
        <div className="office-empty">
          <div className="office-empty-inner">
            <div className="office-empty-mark">🏢</div>
            <p>办公区还没有工位。新建一个会话,看它入职开工。</p>
            <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
              + 新建会话
            </button>
          </div>
        </div>
      ) : (
        <Canvas shadows camera={{ position: [7, 7, 9], fov: 42 }} dpr={[1, 1.75]}>
          <color attach="background" args={['#14161b']} />
          <fog attach="fog" args={['#14161b', 14, 34]} />
          <ambientLight intensity={0.55} />
          <directionalLight position={[6, 12, 6]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
          <directionalLight position={[-8, 6, -6]} intensity={0.35} color="#8fb4ff" />

          {/* 地板 */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
            <planeGeometry args={[60, 60]} />
            <meshStandardMaterial color="#191c22" />
          </mesh>
          <gridHelper args={[60, 60, '#2a2f39', '#212530']} position={[0, 0.001, 0]} />

          <Suspense fallback={null}>
            {ids.map((id, i) => (
              <Workstation
                key={id}
                session={sessions[id]}
                position={positions[i]}
                active={id === activeId}
                onSelect={() => focus(id)}
              />
            ))}
          </Suspense>

          <OrbitControls
            enablePan={false}
            minDistance={6}
            maxDistance={22}
            maxPolarAngle={Math.PI / 2.2}
            target={[0, 0.6, 0]}
          />
        </Canvas>
      )}
    </div>
  )
}
