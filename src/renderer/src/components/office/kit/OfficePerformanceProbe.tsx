import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { Object3D } from 'three'

export const OFFICE_PERFORMANCE_SESSION_KEY = 'caogen.office.performance'

export interface OfficeRenderFrameMetrics {
  frame: number
  calls: number
  triangles: number
  lines: number
  points: number
}

export interface OfficePerformanceSnapshot {
  render: OfficeRenderFrameMetrics
  memory: {
    geometries: number
    textures: number
    programs: number
  }
  scene: {
    objects: number
    meshes: number
    lights: number
  }
  canvas: {
    width: number
    height: number
    pixelRatio: number
  }
  webgl: {
    renderer: string
    vendor: string
  }
}

export interface OfficePerformanceDiagnostics {
  readFrame(): OfficeRenderFrameMetrics
  snapshot(): OfficePerformanceSnapshot
}

type OfficePerformanceWindow = Window & {
  __caogenOfficePerformance?: OfficePerformanceDiagnostics
}

type SceneObject = Object3D & {
  isLight?: boolean
  isMesh?: boolean
}

interface RendererInfoLike {
  frame: number
  calls: number
  triangles: number
  lines: number
  points: number
}

function renderMetrics(render: RendererInfoLike): OfficeRenderFrameMetrics {
  return {
    frame: render.frame,
    calls: render.calls,
    triangles: render.triangles,
    lines: render.lines,
    points: render.points
  }
}

export default function OfficePerformanceProbe(): null {
  const { gl, scene } = useThree()

  useEffect(() => {
    if (window.sessionStorage.getItem(OFFICE_PERFORMANCE_SESSION_KEY) !== '1') return

    const target = window as OfficePerformanceWindow
    const diagnostics: OfficePerformanceDiagnostics = {
      readFrame: () => renderMetrics(gl.info.render),
      snapshot: () => {
        let objects = 0
        let meshes = 0
        let lights = 0
        scene.traverse((object) => {
          const item = object as SceneObject
          objects += 1
          if (item.isMesh) meshes += 1
          if (item.isLight) lights += 1
        })

        const context = gl.getContext()
        const debugInfo = context.getExtension('WEBGL_debug_renderer_info')
        const renderer = debugInfo
          ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
          : String(context.getParameter(context.RENDERER))
        const vendor = debugInfo
          ? String(context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL))
          : String(context.getParameter(context.VENDOR))

        return {
          render: renderMetrics(gl.info.render),
          memory: {
            geometries: gl.info.memory.geometries,
            textures: gl.info.memory.textures,
            programs: gl.info.programs?.length ?? 0
          },
          scene: { objects, meshes, lights },
          canvas: {
            width: gl.domElement.width,
            height: gl.domElement.height,
            pixelRatio: gl.getPixelRatio()
          },
          webgl: { renderer, vendor }
        }
      }
    }

    target.__caogenOfficePerformance = diagnostics
    return () => {
      if (target.__caogenOfficePerformance === diagnostics) {
        delete target.__caogenOfficePerformance
      }
    }
  }, [gl, scene])

  return null
}
