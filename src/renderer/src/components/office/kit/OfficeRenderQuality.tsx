import { useCallback, useEffect, useRef, useState } from 'react'
import { useThree } from '@react-three/fiber'
import type { OfficeQualityMode } from '../../../../../shared/types'
import {
  initialOfficeAutoQuality,
  nextOfficeAutoQuality,
  OFFICE_QUALITY_PROFILES,
  summarizeOfficeFrameTimes
} from '../quality'
import type { OfficeAutoQualityState, OfficeQualityProfile, OfficeQualityTier } from '../quality'

const AUTO_SAMPLE_FRAMES = 45
const MAX_MEASURED_FRAME_MS = 250

export interface OfficeRenderQualityRuntime {
  renderActive: boolean
  resolvedTier: OfficeQualityTier
  autoTransitions: number
  profile: OfficeQualityProfile
  recordFrame(frameMs: number): void
}

export function useOfficeRenderQuality(requestedMode: OfficeQualityMode): OfficeRenderQualityRuntime {
  const [renderActive, setRenderActive] = useState(() => !document.hidden && document.hasFocus())
  const [autoTier, setAutoTier] = useState<OfficeQualityTier>('balanced')
  const [autoTransitions, setAutoTransitions] = useState(0)
  const autoStateRef = useRef<OfficeAutoQualityState>(initialOfficeAutoQuality(performance.now()))
  const frameSamplesRef = useRef<number[]>([])

  useEffect(() => {
    const updateVisibility = (): void => setRenderActive(!document.hidden && document.hasFocus())
    const pause = (): void => setRenderActive(false)
    const resume = (): void => setRenderActive(!document.hidden)
    document.addEventListener('visibilitychange', updateVisibility)
    window.addEventListener('blur', pause)
    window.addEventListener('focus', resume)
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility)
      window.removeEventListener('blur', pause)
      window.removeEventListener('focus', resume)
    }
  }, [])

  useEffect(() => {
    frameSamplesRef.current = []
    const initial = initialOfficeAutoQuality(performance.now())
    autoStateRef.current = initial
    setAutoTier(initial.tier)
    setAutoTransitions(0)
  }, [requestedMode])

  const recordFrame = useCallback(
    (frameMs: number): void => {
      if (requestedMode !== 'auto' || !renderActive) return
      if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > MAX_MEASURED_FRAME_MS) {
        frameSamplesRef.current = []
        return
      }
      const samples = frameSamplesRef.current
      samples.push(frameMs)
      if (samples.length < AUTO_SAMPLE_FRAMES) return
      frameSamplesRef.current = []
      const previous = autoStateRef.current
      const next = nextOfficeAutoQuality(previous, summarizeOfficeFrameTimes(samples), performance.now())
      autoStateRef.current = next
      if (next.tier !== previous.tier) setAutoTransitions((count) => count + 1)
      setAutoTier((current) => (current === next.tier ? current : next.tier))
    },
    [renderActive, requestedMode]
  )

  const resolvedTier = requestedMode === 'auto' ? autoTier : requestedMode
  return {
    renderActive,
    resolvedTier,
    autoTransitions,
    profile: OFFICE_QUALITY_PROFILES[resolvedTier],
    recordFrame
  }
}

export default function OfficeFrameDriver({
  active,
  onFrame
}: {
  active: boolean
  onFrame: (frameMs: number) => void
}): null {
  const advance = useThree((state) => state.advance)
  const elapsedRef = useRef(0)

  useEffect(() => {
    if (!active) return
    let previous = performance.now()
    let frame = 0
    const tick = (now: number): void => {
      const delta = Math.min(0.1, Math.max(0, (now - previous) / 1_000))
      previous = now
      elapsedRef.current += delta
      advance(elapsedRef.current, true)
      onFrame(delta * 1_000)
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [active, advance, onFrame])

  return null
}
