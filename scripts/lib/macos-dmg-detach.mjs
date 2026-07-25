import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plist = require('plist')

export function detachDmg(mountPoint, options = {}) {
  const runCommand = options.runCommand
  const wait = options.wait ?? defaultWait
  if (typeof runCommand !== 'function') throw new TypeError('detachDmg requires runCommand')

  let result
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const args = attempt === 5 ? ['detach', '-force', mountPoint] : ['detach', mountPoint]
    result = runCommand('hdiutil', args)
    if (result.ok) return { ...result, detachDisposition: 'command_succeeded' }

    const mountState = readDmgMountState(mountPoint, { runCommand })
    if (mountState === 'detached') {
      return {
        ...result,
        ok: true,
        exitCode: 0,
        detachDisposition: 'verified_detached',
        originalExitCode: result.exitCode
      }
    }
    if (attempt < 5) wait(attempt * 500)
  }
  return { ...result, detachDisposition: 'still_mounted_or_unknown' }
}

export function readDmgMountState(mountPoint, options = {}) {
  const runCommand = options.runCommand
  if (typeof runCommand !== 'function') throw new TypeError('readDmgMountState requires runCommand')

  const result = runCommand('hdiutil', ['info', '-plist'])
  if (!result.ok) return 'unknown'
  try {
    const parsed = plist.parse(result.stdout)
    const images = Array.isArray(parsed?.images) ? parsed.images : []
    const expectedMountPoint = canonicalMountPoint(mountPoint)
    const mounted = images.some((image) => {
      const entities = Array.isArray(image?.['system-entities']) ? image['system-entities'] : []
      return entities.some((entity) => {
        const value = entity?.['mount-point']
        return typeof value === 'string' && canonicalMountPoint(value) === expectedMountPoint
      })
    })
    return mounted ? 'mounted' : 'detached'
  } catch {
    return 'unknown'
  }
}

function canonicalMountPoint(value) {
  try {
    return realpathSync.native(value)
  } catch {
    return path.resolve(value)
  }
}

function defaultWait(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
}
