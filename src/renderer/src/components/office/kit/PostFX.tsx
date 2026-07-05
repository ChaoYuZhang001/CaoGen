import { EffectComposer, Bloom, N8AO, Vignette, SMAA } from '@react-three/postprocessing'

interface Props {
  /** 亮色主题:弱化辉光与暗角强度,避免过曝 */
  light?: boolean
  /** 开启 SMAA 抗锯齿(默认开) */
  smaa?: boolean
}

/**
 * 后处理栈:让发光材质(emissive + toneMapped={false})与粒子"绚"起来。
 * - N8AO:屏幕空间环境遮蔽,让桌腿/椅子/脚下落地
 * - Bloom(mipmapBlur):高质量泛光辉光
 * - Vignette:暗角,把视线聚到中心舞台
 * - SMAA:边缘抗锯齿(可选)
 * light 主题下整体弱化,防止浅色背景被泛光洗白。
 */
export default function PostFX({ light = false, smaa = true }: Props): React.JSX.Element {
  return (
    <EffectComposer multisampling={0}>
      <N8AO
        aoRadius={0.9}
        distanceFalloff={0.75}
        intensity={light ? 0.45 : 0.8}
        quality="medium"
        halfRes
      />
      <Bloom
        intensity={light ? 0.45 : 0.8}
        luminanceThreshold={light ? 0.55 : 0.45}
        luminanceSmoothing={0.9}
        mipmapBlur
      />
      <Vignette eskil={false} offset={0.15} darkness={light ? 0.4 : 0.75} />
      {smaa ? <SMAA /> : <></>}
    </EffectComposer>
  )
}
