import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const GLB_MAGIC = 0x46546c67
const GLB_JSON_CHUNK = 0x4e4f534a
const FULL_GLB_BUDGET_BYTES = 8_000_000
const LOD_TRIANGLE_RATIO_LIMIT = 0.3

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

const fullAssetPath = path.join(
  repoRoot,
  'src/renderer/src/assets/robots/reference-office-robot.glb'
)
const lodAssetPath = path.join(
  repoRoot,
  'src/renderer/src/assets/robots/reference-office-robot-lod.glb'
)

const full = inspectGeneratedGlb(fullAssetPath)
const lod = inspectGeneratedGlb(lodAssetPath)

if (full.bytes > FULL_GLB_BUDGET_BYTES) {
  throw new Error(
    `Generated reference robot GLB exceeds ${FULL_GLB_BUDGET_BYTES} bytes: ${full.bytes}`
  )
}
if (lod.triangles >= full.triangles * LOD_TRIANGLE_RATIO_LIMIT) {
  throw new Error(
    `Generated LOD must keep fewer than ${Math.round(LOD_TRIANGLE_RATIO_LIMIT * 100)}% of full triangles: ` +
      `${lod.triangles}/${full.triangles}`
  )
}

console.log(
  `validated Draco GLBs: full=${full.bytes} B/${full.triangles} triangles, ` +
    `low=${lod.bytes} B/${lod.triangles} triangles`
)

function inspectGeneratedGlb(filePath) {
  const buffer = readFileSync(filePath)
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error(`Generated asset is not a valid GLB: ${filePath}`)
  }
  const jsonLength = buffer.readUInt32LE(12)
  const jsonType = buffer.readUInt32LE(16)
  if (jsonType !== GLB_JSON_CHUNK || 20 + jsonLength > buffer.length) {
    throw new Error(`Generated asset has an invalid GLB JSON chunk: ${filePath}`)
  }
  const document = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').trim())
  if (!document.extensionsRequired?.includes('KHR_draco_mesh_compression')) {
    throw new Error(`Generated asset is missing required Draco compression: ${filePath}`)
  }
  const triangles = (document.meshes ?? []).reduce(
    (meshTotal, mesh) =>
      meshTotal +
      (mesh.primitives ?? []).reduce((primitiveTotal, primitive) => {
        const indexCount = document.accessors?.[primitive.indices]?.count ?? 0
        return primitiveTotal + Math.floor(indexCount / 3)
      }, 0),
    0
  )
  return { bytes: buffer.length, triangles }
}
