import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-layered-memory-'))
const outDir = path.join(tempRoot, 'compiled')
const storeRoot = path.join(tempRoot, 'memory')
const projectA = path.join(tempRoot, 'project-a')
const projectB = path.join(tempRoot, 'project-b')

try {
  mkdirSync(projectA, { recursive: true })
  mkdirSync(projectB, { recursive: true })
  compile(['src/main/memory/memory-manager.ts', 'src/main/memory/memory-retriever.ts', 'src/main/memory/memory-writer.ts'], outDir)
  const manager = await import(pathToFileURL(findCompiled(outDir, 'memory-manager.js')).href)
  const retriever = await import(pathToFileURL(findCompiled(outDir, 'memory-retriever.js')).href)
  const writer = await import(pathToFileURL(findCompiled(outDir, 'memory-writer.js')).href)
  const projectStore = await import(pathToFileURL(findCompiled(outDir, 'memoryStore.js')).href)

  const projectMemory = await manager.addMemory(storeRoot, {
    layer: 'project',
    projectRoot: projectA,
    title: 'Pricing API contract',
    body: 'Pricing requests must verify quota before writing billing records.',
    source: 'smoke',
    tags: ['pricing', 'quota']
  })
  await manager.addMemory(storeRoot, {
    layer: 'project',
    projectRoot: projectB,
    title: 'Different project note',
    body: 'This note belongs to another project and must not leak.',
    source: 'smoke'
  })
  await manager.addMemory(storeRoot, {
    layer: 'user',
    title: 'User verification preference',
    body: 'Always report verification commands and exact failures.',
    source: 'smoke',
    tags: ['preference']
  })
  await manager.addMemory(storeRoot, {
    layer: 'working',
    projectRoot: projectA,
    title: 'Temporary rollout detail',
    body: 'The current P1 rollout is focused on orchestration automation.',
    source: 'smoke'
  })

  const hits = await manager.searchMemories(storeRoot, {
    query: 'pricing quota verification',
    projectRoot: projectA,
    layers: ['project', 'user'],
    limit: 10
  })
  assert(hits.some((hit) => hit.entry.id === projectMemory.id), 'project memory should match project A')
  assert(hits.some((hit) => hit.entry.layer === 'user'), 'user memory should be globally visible')
  assert(!hits.some((hit) => hit.entry.title === 'Different project note'), 'project B memory should not leak')

  const updated = await manager.updateMemory(storeRoot, projectMemory.id, {
    title: 'Pricing API quota contract',
    body: 'Pricing requests must verify quota and account limits before writing billing records.'
  })
  assert(updated?.title.includes('quota'), 'updateMemory should edit layered entries')

  const extracted = await writer.writeExtractedMemory({
    rootDir: storeRoot,
    text: '记住: P1 变更必须报告验证命令和真实失败点。',
    projectRoot: projectA,
    source: 'smoke:auto'
  })
  assert(extracted?.status === 'draft', 'writeExtractedMemory should create a pending project Memory draft')
  const activeAfterExtraction = await manager.listMemories(storeRoot)
  assert(!activeAfterExtraction.some((entry) => entry.title === extracted.title), 'auto extraction must not enter active layered memory')
  const projectMemoryState = await projectStore.readProjectMemory(projectA, storeRoot)
  assert(projectMemoryState.drafts.some((entry) => entry.id === extracted.id), 'auto extraction draft should be reviewable')

  const prompt = await retriever.buildLayeredMemoryPrompt({
    rootDir: storeRoot,
    query: 'verification commands',
    projectRoot: projectA,
    layers: ['user'],
    limit: 3
  })
  assert(prompt.includes('Relevant CaoGen Memory'), 'retriever should build a memory prompt')

  const archived = await manager.archiveStaleMemories(storeRoot, -1, Date.now())
  assert(archived >= 1, 'archiveStaleMemories should archive stale entries')

  const exported = await manager.exportMemories(storeRoot)
  assert(JSON.parse(exported).entries.length >= 4, 'exportMemories should include entries')
  assert(await manager.deleteMemory(storeRoot, projectMemory.id), 'deleteMemory should remove entry')

  console.log('layeredMemory smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile(files, outDir) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files,
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function findCompiled(root, fileName) {
  const found = findCompiledOptional(root, fileName)
  if (found) return found
  throw new Error(`compiled ${fileName} not found`)
}

function findCompiledOptional(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
