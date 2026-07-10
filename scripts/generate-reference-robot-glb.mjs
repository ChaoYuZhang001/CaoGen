import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const blenderScript = path.join(repoRoot, 'scripts/generate-reference-robot-blender.py')
const blenderCandidates = [
  process.env.BLENDER_BIN,
  '/usr/local/bin/blender',
  '/opt/homebrew/bin/blender',
  '/Applications/Blender.app/Contents/MacOS/Blender',
  'blender'
].filter(Boolean)

const blender = blenderCandidates.find((candidate) => candidate === 'blender' || existsSync(candidate))
if (!blender) {
  throw new Error('Blender is required to generate the reference office robot. Install Blender 4.4+ or set BLENDER_BIN.')
}

const result = spawnSync(blender, ['--background', '--python', blenderScript], {
  cwd: repoRoot,
  env: process.env,
  encoding: 'utf8',
  stdio: 'inherit'
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
