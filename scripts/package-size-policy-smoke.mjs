#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const repoRoot = process.cwd()
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))
const workflow = yaml.load(readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'release-candidate-evidence.yml'),
  'utf8'
))
const afterPackSource = readFileSync(path.join(repoRoot, 'scripts', 'after-pack.cjs'), 'utf8')

const rendererOnlyDependencies = [
  '@react-three/drei',
  '@react-three/fiber',
  '@react-three/postprocessing',
  '@types/sql.js',
  'highlight.js',
  'postprocessing',
  'react',
  'react-dom',
  'react-markdown',
  'rehype-highlight',
  'remark-gfm',
  'three',
  'zustand'
]

for (const dependency of rendererOnlyDependencies) {
  assert.equal(packageJson.dependencies?.[dependency], undefined, `${dependency} must not ship as a runtime dependency`)
  assert.equal(typeof packageJson.devDependencies?.[dependency], 'string', `${dependency} must remain available at build time`)
  assert.equal(packageLock.packages?.['']?.dependencies?.[dependency], undefined, `${dependency} lock root must not be runtime`)
  assert.equal(
    typeof packageLock.packages?.['']?.devDependencies?.[dependency],
    'string',
    `${dependency} lock root must be development-only`
  )
}

assert.deepEqual(packageJson.build?.electronLanguages, ['en', 'zh_CN', 'zh_TW'])

const requiredBaseFiles = [
  'out/**/*',
  'package.json',
  '!node_modules/tree-sitter{,-*}/**/parser.c',
  '!node_modules/node-pty/src/**'
]

const globalFiles = packageJson.build?.files || []
for (const pattern of requiredBaseFiles) {
  assert(globalFiles.includes(pattern), `missing package filter: ${pattern}`)
}

const macFiles = packageJson.build?.mac?.files || []
// A platform-level files array replaces the global array in electron-builder.
// Keep the narrow app include set here so macOS never falls back to packaging the repository.
for (const pattern of requiredBaseFiles) {
  assert(macFiles.includes(pattern), `missing macOS base package filter: ${pattern}`)
}
for (const pattern of [
  '!node_modules/@anthropic-ai/claude-agent-sdk-darwin-!(${arch})/**',
  '!node_modules/**/prebuilds/!(darwin-${arch})/**',
  '!node_modules/@nut-tree-fork/libnut-linux/**',
  '!node_modules/@nut-tree-fork/libnut-win32/**'
]) assert(macFiles.includes(pattern), `missing macOS package filter: ${pattern}`)

assert(!afterPackSource.includes('rmSync('), 'afterPack must not delete files after ASAR creation')
assert(afterPackSource.includes('wrong-architecture Claude SDK survived packaging'))
assert(packageJson.scripts?.['dist:mac:release:x64']?.includes('test:macos-package-size:required'))

const x64Steps = workflow.jobs?.['macos-x64']?.steps || []
const x64Upload = x64Steps.find((step) => step.name === 'Upload x64 assets and evidence')
assert(x64Upload, 'x64 distributable upload step is required')
assert(!String(x64Upload.with?.path || '').includes('app.asar'), 'x64 distributable evidence must not duplicate app.asar')

const aggregateArchiveUpload = x64Steps.find((step) => step.name === 'Upload x64 archive for complete-matrix assembly')
assert.equal(aggregateArchiveUpload?.if, "${{ inputs.platform_scope == 'all' }}")
assert.equal(
  aggregateArchiveUpload?.with?.path,
  'dist/mac/CaoGen.app/Contents/Resources/app.asar'
)

const candidateCommands = workflow.jobs?.candidate?.steps
  ?.find((step) => step.name === 'Run candidate source gates')?.run || ''
assert(candidateCommands.includes('npm run test:package-size-policy'))

const aggregateSteps = workflow.jobs?.aggregate?.steps || []
const aggregateArchiveDownload = aggregateSteps.find((step) => step.name === 'Download macOS x64 archive for assembly')
assert.equal(
  aggregateArchiveDownload?.with?.name,
  'caogen-release-macos-x64-aggregate-${{ needs.candidate.outputs.commit }}'
)
assert.equal(
  aggregateArchiveDownload?.with?.path,
  'test-results/release-matrix-input/macos-x64/dist/mac/CaoGen.app/Contents/Resources'
)

console.log('package size policy smoke: passed')
