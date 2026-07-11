#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GLB_MAGIC = 0x46546c67
const GLB_VERSION = 2
const JSON_CHUNK_TYPE = 0x4e4f534a
const PINNED_SOURCE_COMMIT = '276801e46c5d433564f24658bac64f254b7d2d4b'
const SOURCE_LICENSE = 'BSD-3-Clause'
const SOURCE_ROOT_NODE_NAME = 'reference_office_robot_unitree_style'
const REQUIRED_ANIMATION_ROOT_NAMES = [
  'helmet_head',
  'left_arm',
  'right_arm',
  'left_leg',
  'right_leg'
]
const REQUIRED_GAIT_CONTROL_NODE_NAMES = [
  'waist_yaw_link',
  'waist_roll_link',
  'left_ankle_pitch_link',
  'right_ankle_pitch_link',
  'left_ankle_roll_link',
  'right_ankle_roll_link'
]
const REQUIRED_OFFICIAL_MESH_BINDINGS = [
  {
    label: 'official head',
    nodeNames: ['official_head_link'],
    meshNames: ['head_link'],
    sourceMeshNames: ['head_link'],
    animationRootName: 'helmet_head'
  },
  {
    label: 'official 23-DOF torso',
    nodeNames: ['official_torso_link', 'official_torso_link_23dof_rev_1_0'],
    meshNames: ['torso_link_23dof_rev_1_0'],
    sourceMeshNames: ['torso_link', 'torso_link_23dof_rev_1_0']
  },
  {
    label: 'official left rubber hand',
    nodeNames: ['official_left_rubber_hand', 'official_left_wrist_roll_rubber_hand'],
    meshNames: ['left_rubber_hand', 'left_wrist_roll_rubber_hand'],
    sourceMeshNames: ['left_rubber_hand', 'left_wrist_roll_rubber_hand'],
    animationRootName: 'left_arm'
  },
  {
    label: 'official right rubber hand',
    nodeNames: ['official_right_rubber_hand', 'official_right_wrist_roll_rubber_hand'],
    meshNames: ['right_rubber_hand', 'right_wrist_roll_rubber_hand'],
    sourceMeshNames: ['right_rubber_hand', 'right_wrist_roll_rubber_hand'],
    animationRootName: 'right_arm'
  }
]

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const defaultAssetPath = path.join(
  repoRoot,
  'src/renderer/src/assets/robots/reference-office-robot.glb'
)
const assetPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultAssetPath

try {
  const buffer = readGlb(assetPath)
  const glb = parseGlb(buffer, assetPath)
  const inspection = inspectDocument(glb.document)

  printGlbSummary(assetPath, buffer.length, glb)
  printDocumentSummary(inspection)

  if (inspection.failures.length > 0) {
    throw new Error(
      `reference robot GLB contract failed with ${inspection.failures.length} issue(s):\n${inspection.failures
        .map((failure) => `  - ${failure}`)
        .join('\n')}`
    )
  }

  console.log('reference robot GLB smoke ok')
} catch (error) {
  console.error(`reference robot GLB smoke failed: ${errorMessage(error)}`)
  process.exitCode = 1
}

function readGlb(filePath) {
  try {
    return readFileSync(filePath)
  } catch (error) {
    throw new Error(`cannot read GLB asset "${filePath}": ${errorMessage(error)}`)
  }
}

function parseGlb(buffer, filePath) {
  if (buffer.length < 12) {
    throw new Error(
      `invalid GLB header in "${filePath}": expected at least 12 bytes, found ${buffer.length}`
    )
  }

  const magic = buffer.readUInt32LE(0)
  if (magic !== GLB_MAGIC) {
    throw new Error(
      `invalid GLB magic in "${filePath}": expected ASCII "glTF" (bytes 67 6c 54 46), ` +
        `found ${formatBytes(buffer.subarray(0, 4))}`
    )
  }

  const version = buffer.readUInt32LE(4)
  if (version !== GLB_VERSION) {
    throw new Error(
      `unsupported GLB version in "${filePath}": expected ${GLB_VERSION}, found ${version}`
    )
  }

  const declaredLength = buffer.readUInt32LE(8)
  if (declaredLength !== buffer.length) {
    throw new Error(
      `GLB length mismatch in "${filePath}": header declares ${declaredLength} bytes, ` +
        `file contains ${buffer.length} bytes (difference ${buffer.length - declaredLength})`
    )
  }

  const chunks = []
  let offset = 12
  while (offset < buffer.length) {
    const remaining = buffer.length - offset
    if (remaining < 8) {
      throw new Error(
        `truncated GLB chunk header at byte ${offset}: ${remaining} trailing byte(s), expected 8`
      )
    }

    const byteLength = buffer.readUInt32LE(offset)
    const type = buffer.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    const endOffset = dataOffset + byteLength

    if (byteLength % 4 !== 0) {
      throw new Error(
        `misaligned GLB chunk ${chunks.length} (${formatChunkType(type)}) at byte ${offset}: ` +
          `length ${byteLength} is not a multiple of 4`
      )
    }
    if (endOffset > buffer.length) {
      throw new Error(
        `truncated GLB chunk ${chunks.length} (${formatChunkType(type)}) at byte ${offset}: ` +
          `declares ${byteLength} data bytes ending at ${endOffset}, file ends at ${buffer.length}`
      )
    }

    chunks.push({
      index: chunks.length,
      type,
      byteLength,
      headerOffset: offset,
      dataOffset,
      data: buffer.subarray(dataOffset, endOffset)
    })
    offset = endOffset
  }

  if (chunks.length === 0) {
    throw new Error('invalid GLB: header is present but no chunks were found')
  }
  if (chunks[0].type !== JSON_CHUNK_TYPE) {
    throw new Error(
      `invalid GLB chunk order: first chunk must be JSON, found ${formatChunkType(chunks[0].type)}`
    )
  }

  const jsonChunks = chunks.filter((chunk) => chunk.type === JSON_CHUNK_TYPE)
  if (jsonChunks.length !== 1) {
    throw new Error(`invalid GLB JSON chunk count: expected exactly 1, found ${jsonChunks.length}`)
  }

  let jsonText
  try {
    jsonText = new TextDecoder('utf-8', { fatal: true }).decode(jsonChunks[0].data).trim()
  } catch (error) {
    throw new Error(`GLB JSON chunk is not valid UTF-8: ${errorMessage(error)}`)
  }
  if (!jsonText) {
    throw new Error('GLB JSON chunk is empty after removing padding')
  }

  let document
  try {
    document = JSON.parse(jsonText)
  } catch (error) {
    throw new Error(
      `cannot parse GLB JSON chunk (${jsonChunks[0].byteLength} bytes): ${errorMessage(error)}`
    )
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('GLB JSON root must be an object')
  }

  return { version, declaredLength, chunks, document }
}

function inspectDocument(document) {
  const failures = []
  const nodes = Array.isArray(document.nodes) ? document.nodes : []
  const materials = Array.isArray(document.materials) ? document.materials : []
  const meshes = Array.isArray(document.meshes) ? document.meshes : []

  if (document.asset?.version !== '2.0') {
    failures.push(
      `JSON asset.version must be "2.0"; found ${formatValue(document.asset?.version)}`
    )
  }
  if (!Array.isArray(document.nodes)) {
    failures.push(`JSON nodes must be an array; found ${describeType(document.nodes)}`)
  }
  if (!Array.isArray(document.materials)) {
    failures.push(`JSON materials must be an array; found ${describeType(document.materials)}`)
  }
  if (!Array.isArray(document.meshes)) {
    failures.push(`JSON meshes must be an array; found ${describeType(document.meshes)}`)
  }

  const nodeEntries = nodes.map((node, index) => ({
    index,
    name: typeof node?.name === 'string' && node.name.length > 0 ? node.name : null,
    meshIndex: Number.isInteger(node?.mesh) ? node.mesh : null,
    meshName:
      Number.isInteger(node?.mesh) && typeof meshes[node.mesh]?.name === 'string'
        ? meshes[node.mesh].name
        : null
  }))
  const nodeNames = nodeEntries.flatMap((node) => (node.name ? [node.name] : []))
  const nodeNameSet = new Set(nodeNames)
  const missingAnimationRootNames = REQUIRED_ANIMATION_ROOT_NAMES.filter(
    (name) => !nodeNameSet.has(name)
  )
  if (missingAnimationRootNames.length > 0) {
    failures.push(
      `missing required animation root node name(s): ${missingAnimationRootNames
        .map(quote)
        .join(', ')}. Expected exact contract: ${REQUIRED_ANIMATION_ROOT_NAMES.map(quote).join(', ')}`
    )
  }

  const animationRootNodes = []
  for (const name of REQUIRED_ANIMATION_ROOT_NAMES) {
    const matches = nodeEntries.filter((node) => node.name === name)
    if (matches.length > 1) {
      failures.push(`animation root ${quote(name)} must be unique; found ${matches.length}`)
    }
    if (matches.length === 1) {
      const entry = matches[0]
      animationRootNodes.push(entry)
      if (!Array.isArray(nodes[entry.index]?.children) || nodes[entry.index].children.length === 0) {
        failures.push(`animation root ${quote(name)} must contain official model descendants`)
      }
    }
  }

  const gaitControlNodes = []
  for (const name of REQUIRED_GAIT_CONTROL_NODE_NAMES) {
    const matches = nodeEntries.filter((node) => node.name === name)
    if (matches.length !== 1) {
      failures.push(`gait control ${quote(name)} must appear exactly once; found ${matches.length}`)
    } else {
      gaitControlNodes.push(matches[0])
    }
  }

  const sourceRootMatches = nodeEntries.filter((node) => node.name === SOURCE_ROOT_NODE_NAME)
  const sourceRoot = sourceRootMatches.length === 1 ? sourceRootMatches[0] : null
  if (sourceRootMatches.length !== 1) {
    failures.push(
      `source root ${quote(SOURCE_ROOT_NODE_NAME)} must appear exactly once; found ${sourceRootMatches.length}`
    )
  }

  const sourceExtras = sourceRoot ? nodes[sourceRoot.index]?.extras : null
  if (sourceExtras?.source_commit !== PINNED_SOURCE_COMMIT) {
    failures.push(
      `source root extras.source_commit must be ${quote(PINNED_SOURCE_COMMIT)}; found ${formatValue(sourceExtras?.source_commit)}`
    )
  }
  if (sourceExtras?.source_license !== SOURCE_LICENSE) {
    failures.push(
      `source root extras.source_license must be ${quote(SOURCE_LICENSE)}; found ${formatValue(sourceExtras?.source_license)}`
    )
  }
  if (typeof sourceExtras?.source_model !== 'string' || !/23[ -]?dof/iu.test(sourceExtras.source_model)) {
    failures.push(
      `source root extras.source_model must identify the official 23-DOF source geometry; found ${formatValue(sourceExtras?.source_model)}`
    )
  }

  if (sourceRoot) {
    for (const animationRoot of animationRootNodes) {
      if (!nodeContains(nodes, sourceRoot.index, animationRoot.index)) {
        failures.push(
          `animation root ${quote(animationRoot.name)} is not a descendant of ${quote(SOURCE_ROOT_NODE_NAME)}`
        )
      }
    }
  }

  const officialMeshBindings = []
  for (const contract of REQUIRED_OFFICIAL_MESH_BINDINGS) {
    const matches = nodeEntries.filter((node) => contract.nodeNames.includes(node.name))
    if (matches.length !== 1) {
      failures.push(
        `${contract.label} must use exactly one accepted exact node name (${formatList(contract.nodeNames)}); ` +
          `found ${matches.length}`
      )
      continue
    }

    const nodeEntry = matches[0]
    const node = nodes[nodeEntry.index]
    const meshIndex = node?.mesh
    if (!Number.isInteger(meshIndex) || meshIndex < 0 || meshIndex >= meshes.length) {
      failures.push(
        `${contract.label} node ${quote(nodeEntry.name)} must reference a valid mesh index; found ${formatValue(meshIndex)}`
      )
      continue
    }

    const meshName = typeof meshes[meshIndex]?.name === 'string' ? meshes[meshIndex].name : null
    const sourceMeshName = node?.extras?.unitree_mesh_name
    if (!contract.meshNames.includes(meshName)) {
      failures.push(
        `${contract.label} node ${quote(nodeEntry.name)} must bind exact mesh ${formatList(contract.meshNames)}; ` +
          `found ${formatValue(meshName)}`
      )
    }
    if (!contract.sourceMeshNames.includes(sourceMeshName)) {
      failures.push(
        `${contract.label} node ${quote(nodeEntry.name)} must preserve extras.unitree_mesh_name ` +
          `${formatList(contract.sourceMeshNames)}; found ${formatValue(sourceMeshName)}`
      )
    }

    if (contract.animationRootName) {
      const animationRootIndex = nodes.findIndex((candidate) => candidate?.name === contract.animationRootName)
      if (
        animationRootIndex >= 0 &&
        !nodeContains(nodes, animationRootIndex, nodeEntry.index)
      ) {
        failures.push(
          `${contract.label} node ${quote(nodeEntry.name)} must descend from animation root ` +
            quote(contract.animationRootName)
        )
      }
    }
    if (sourceRoot && !nodeContains(nodes, sourceRoot.index, nodeEntry.index)) {
      failures.push(
        `${contract.label} node ${quote(nodeEntry.name)} is not a descendant of ${quote(SOURCE_ROOT_NODE_NAME)}`
      )
    }

    officialMeshBindings.push({
      label: contract.label,
      nodeName: nodeEntry.name,
      meshName,
      sourceMeshName
    })
  }

  const referencedMaterialIndexes = new Set()
  for (const [meshIndex, mesh] of meshes.entries()) {
    if (!Array.isArray(mesh?.primitives)) {
      failures.push(
        `mesh[${meshIndex}] primitives must be an array; found ${describeType(mesh?.primitives)}`
      )
      continue
    }
    for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
      if (primitive?.material === undefined) continue
      const materialIndex = primitive.material
      if (!Number.isInteger(materialIndex)) {
        failures.push(
          `mesh[${meshIndex}].primitives[${primitiveIndex}].material must be an integer; ` +
            `found ${formatValue(materialIndex)}`
        )
        continue
      }
      if (materialIndex < 0 || materialIndex >= materials.length) {
        failures.push(
          `mesh[${meshIndex}].primitives[${primitiveIndex}].material references index ` +
            `${materialIndex}, but materials has ${materials.length} entr${materials.length === 1 ? 'y' : 'ies'}`
        )
        continue
      }
      referencedMaterialIndexes.add(materialIndex)
    }
  }

  const materialEntries = materials.map((material, index) => ({
    index,
    name: typeof material?.name === 'string' && material.name.length > 0 ? material.name : null,
    referenced: referencedMaterialIndexes.has(index)
  }))
  const referencedMaterials = materialEntries.filter((material) => material.referenced)
  if (referencedMaterials.length === 0) {
    failures.push(
      `no mesh primitive references a material; found ${meshes.length} mesh(es) and ${materials.length} material(s)`
    )
  }

  return {
    failures,
    nodeEntries,
    sourceProvenance: {
      nodeName: sourceRoot?.name ?? null,
      commit: sourceExtras?.source_commit ?? null,
      license: sourceExtras?.source_license ?? null,
      model: sourceExtras?.source_model ?? null
    },
    animationRootNodes,
    missingAnimationRootNames,
    gaitControlNodes,
    officialMeshBindings,
    materialEntries,
    referencedMaterials
  }
}

function nodeContains(nodes, ancestorIndex, descendantIndex) {
  if (ancestorIndex === descendantIndex) return true
  const pending = [...(Array.isArray(nodes[ancestorIndex]?.children) ? nodes[ancestorIndex].children : [])]
  const visited = new Set()

  while (pending.length > 0) {
    const index = pending.pop()
    if (!Number.isInteger(index) || visited.has(index)) continue
    if (index === descendantIndex) return true
    visited.add(index)
    const children = nodes[index]?.children
    if (Array.isArray(children)) pending.push(...children)
  }
  return false
}

function printGlbSummary(filePath, fileLength, glb) {
  console.log(`Reference robot GLB: ${filePath}`)
  console.log(
    `Header: magic=glTF, version=${glb.version}, declaredLength=${glb.declaredLength}, ` +
      `actualLength=${fileLength}`
  )
  console.log(`Chunks (${glb.chunks.length}):`)
  for (const chunk of glb.chunks) {
    console.log(
      `  [${chunk.index}] ${formatChunkType(chunk.type)} length=${chunk.byteLength} ` +
        `headerOffset=${chunk.headerOffset} dataOffset=${chunk.dataOffset}`
    )
  }
}

function printDocumentSummary(inspection) {
  console.log(`Nodes (${inspection.nodeEntries.length}):`)
  for (const node of inspection.nodeEntries) {
    const mesh = node.meshName ? ` -> mesh ${quote(node.meshName)}` : ''
    console.log(`  [${node.index}] ${node.name ?? '<unnamed>'}${mesh}`)
  }

  console.log(
    `Source provenance: node=${formatValue(inspection.sourceProvenance.nodeName)}, ` +
      `commit=${formatValue(inspection.sourceProvenance.commit)}, ` +
      `license=${formatValue(inspection.sourceProvenance.license)}`
  )
  console.log(
    `Animation roots: ${inspection.animationRootNodes.length}/${REQUIRED_ANIMATION_ROOT_NAMES.length} present ` +
      `(${formatList(inspection.animationRootNodes.map((node) => node.name))})`
  )
  console.log(
    `Gait controls: ${inspection.gaitControlNodes.length}/${REQUIRED_GAIT_CONTROL_NODE_NAMES.length} present ` +
      `(${formatList(inspection.gaitControlNodes.map((node) => node.name))})`
  )
  console.log('Official mesh bindings:')
  for (const binding of inspection.officialMeshBindings) {
    console.log(
      `  ${binding.label}: node=${quote(binding.nodeName)}, mesh=${formatValue(binding.meshName)}, ` +
        `source=${formatValue(binding.sourceMeshName)}`
    )
  }

  console.log(
    `Materials (${inspection.materialEntries.length} total, ${inspection.referencedMaterials.length} referenced):`
  )
  for (const material of inspection.materialEntries) {
    console.log(
      `  [${material.index}] ${material.name ?? '<unnamed>'} ` +
        `${material.referenced ? '[referenced]' : '[unreferenced]'}`
    )
  }
}

function formatChunkType(type) {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32LE(type)
  const ascii = [...bytes]
    .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : `\\x${hexByte(byte)}`))
    .join('')
  return `${ascii} (0x${type.toString(16).padStart(8, '0')})`
}

function formatBytes(buffer) {
  return [...buffer].map(hexByte).join(' ')
}

function hexByte(byte) {
  return byte.toString(16).padStart(2, '0')
}

function formatList(values) {
  return values.length > 0 ? values.map(quote).join(', ') : 'none'
}

function quote(value) {
  return `"${value}"`
}

function formatValue(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
