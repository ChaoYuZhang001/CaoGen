import { useCallback, useEffect, useRef, useState } from 'react'

const OFFICE_DETAIL_UPGRADE_DELAY_MS = 1_200

export function useOfficeBootStages(recordFrame: (frameMs: number) => void): {
  bootCharactersEnabled: boolean
  sceneDetailEnabled: boolean
  sceneAssetsEnabled: boolean
  handleOfficeFrame: (frameMs: number) => void
} {
  const [bootCharactersEnabled, setBootCharactersEnabled] = useState(false)
  const [sceneDetailEnabled, setSceneDetailEnabled] = useState(false)
  const [sceneAssetsEnabled, setSceneAssetsEnabled] = useState(false)
  const bootFrameRenderedRef = useRef(false)
  const detailUpgradeTimerRef = useRef<number | null>(null)
  const handleOfficeFrame = useCallback((frameMs: number): void => {
    recordFrame(frameMs)
    if (bootFrameRenderedRef.current) return
    bootFrameRenderedRef.current = true
    setBootCharactersEnabled(true)
    detailUpgradeTimerRef.current = window.setTimeout(
      () => setSceneDetailEnabled(true),
      OFFICE_DETAIL_UPGRADE_DELAY_MS
    )
  }, [recordFrame])

  useEffect(() => () => {
    if (detailUpgradeTimerRef.current !== null) window.clearTimeout(detailUpgradeTimerRef.current)
  }, [])

  useEffect(() => {
    if (!sceneDetailEnabled || sceneAssetsEnabled) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setSceneAssetsEnabled(true))
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [sceneAssetsEnabled, sceneDetailEnabled])

  return { bootCharactersEnabled, sceneDetailEnabled, sceneAssetsEnabled, handleOfficeFrame }
}
