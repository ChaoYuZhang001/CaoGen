#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import yaml from 'js-yaml'

const repoRoot = process.cwd()
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))
const workflow = yaml.load(readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'release-candidate-evidence.yml'),
  'utf8'
))
const rendererOnlyDependencies = [
  '@react-three/drei',
  '@react-three/fiber',
  '@react-three/postprocessing',
  '@types/sql.js',
  'highlight.js',
  'lucide-react',
  'postprocessing',
  'react',
  'react-dom',
  'react-markdown',
  'rehype-highlight',
  'remark-gfm',
  'three',
  'zustand'
]
const forbiddenRuntimePackages = new Set([
  '@anthropic-ai/claude-agent-sdk'
])
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

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

for (const dependency of ['@fontsource/noto-sans-sc', 'ffmpeg-static', 'tsx']) {
  assert.equal(packageJson.dependencies?.[dependency], undefined, `${dependency} must not ship as a runtime dependency`)
  assert.equal(typeof packageJson.devDependencies?.[dependency], 'string', `${dependency} must remain available at build time`)
  assert.equal(packageLock.packages?.['']?.dependencies?.[dependency], undefined, `${dependency} lock root must not be runtime`)
  assert.equal(
    typeof packageLock.packages?.['']?.devDependencies?.[dependency],
    'string',
    `${dependency} lock root must be development-only`
  )
}

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

const packagePrunePatterns = [
  '!node_modules/ffmpeg-static/**',
  '!node_modules/@fontsource/noto-sans-sc/**',
  '!node_modules/lucide-react/**',
  '!node_modules/**/*.map',
  '!node_modules/exceljs/dist/**',
  '!node_modules/sql.js/dist/sql-asm*',
  '!node_modules/sql.js/dist/worker*',
  '!node_modules/sql.js/dist/sql-wasm-browser*',
  '!node_modules/sql.js/dist/*-debug*',
  '!node_modules/pdfkit/.yarn/**',
  '!node_modules/pdfkit/js/pdfkit.es.js',
  '!node_modules/pdfkit/js/pdfkit.standalone.js',
  '!node_modules/puppeteer-core/src/**',
  '!node_modules/zod/src/**',
  '!node_modules/chromium-bidi/node_modules/zod/src/**',
  '!node_modules/docx/dist/index.iife.js',
  '!node_modules/docx/dist/index.mjs',
  '!node_modules/docx/dist/*.d.*',
  '!node_modules/pptxgenjs/dist/pptxgen.bundle.js',
  '!node_modules/pptxgenjs/dist/pptxgen.es.js',
  '!node_modules/pptxgenjs/dist/pptxgen.min.js',
  '!node_modules/pptxgenjs/types/**',
  '!node_modules/pptxgenjs/demos/**',
  '!node_modules/pptxgenjs/src/**',
  '!node_modules/pptxgenjs/libs/**',
  '!node_modules/pptxgenjs/tools/**',
  '!node_modules/pptxgenjs/.github/**',
  '!node_modules/pptxgenjs/.vscode/**',
  '!node_modules/pptxgenjs/node_modules/**',
  '!node_modules/pptxgenjs/.npmignore',
  '!node_modules/pptxgenjs/bower.json',
  '!node_modules/pptxgenjs/eslint.config.mjs',
  '!node_modules/pptxgenjs/gulpfile.js',
  '!node_modules/pptxgenjs/package-lock.json',
  '!node_modules/pptxgenjs/rollup.config.mjs',
  '!node_modules/pptxgenjs/tsconfig.json',
  '!node_modules/tree-sitter{,-*}/prebuilds/**',
  '!node_modules/typescript/lib/_tsc.js',
  '!node_modules/typescript/lib/{cs,de,es,fr,it,ja,ko,pl,pt-br,ru,tr}/**',
  '!node_modules/devtools-protocol/**',
  '!node_modules/puppeteer-core/lib/es5-iife/**',
  '!node_modules/puppeteer-core/**/*.d.ts',
  '!node_modules/chromium-bidi/**/*.d.ts',
  '!node_modules/zod/**/*.d.ts',
  '!node_modules/**/*.d.cts',
  '!node_modules/**/*.d.mts',
  '!node_modules/**/*.md',
  '!node_modules/@aws-sdk/**/*.d.ts',
  '!node_modules/@smithy/**/*.d.ts',
  '!node_modules/jimp/browser/**',
  '!node_modules/fontkit/dist/browser*',
  '!node_modules/@jimp/png/node_modules/pngjs/browser.js',
  '!node_modules/pngjs/browser.js'
]
for (const pattern of packagePrunePatterns) {
  assert(globalFiles.includes(pattern), `missing package prune filter: ${pattern}`)
}
assert(
  !globalFiles.includes('!node_modules/docx/dist/index.cjs'),
  'docx CommonJS runtime entrypoint must remain in the package'
)

const macFiles = packageJson.build?.mac?.files || []
// A platform-level files array replaces the global array in electron-builder.
// Keep the narrow app include set here so macOS never falls back to packaging the repository.
for (const pattern of requiredBaseFiles) {
  assert(macFiles.includes(pattern), `missing macOS base package filter: ${pattern}`)
}
for (const pattern of packagePrunePatterns) {
  assert(macFiles.includes(pattern), `missing macOS package prune filter: ${pattern}`)
}
assert(
  !macFiles.includes('!node_modules/docx/dist/index.cjs'),
  'docx CommonJS runtime entrypoint must remain in the macOS package'
)
for (const pattern of [
  '!node_modules/**/prebuilds/!(darwin-${arch})/**',
  '!node_modules/@nut-tree-fork/libnut-linux/**',
  '!node_modules/@nut-tree-fork/libnut-win32/**'
]) assert(macFiles.includes(pattern), `missing macOS package filter: ${pattern}`)

assert.equal(packageJson.dependencies?.['@anthropic-ai/claude-agent-sdk'], undefined)
assert.equal(packageLock.packages?.['']?.dependencies?.['@anthropic-ai/claude-agent-sdk'], undefined)
assert(!Object.keys(packageLock.packages ?? {}).some((name) => name.includes('claude-agent-sdk')))
assert(!(packageJson.build?.asarUnpack ?? []).some((pattern) => pattern.includes('claude-agent-sdk')))
assert.deepEqual(
  findForbiddenRuntimeImports(path.join(repoRoot, 'src')),
  [],
  'CaoGen source must not import a removed vendor Agent runtime'
)
assert.deepEqual(
  collectForbiddenRuntimeImports('fixture.ts', `
    import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
    type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')
    const sdk = await import('@anthropic-ai/claude-agent-sdk/runtime')
    const legacy = require('@anthropic-ai/claude-agent-sdk')
  `).map((item) => item.specifier),
  [
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-agent-sdk/runtime',
    '@anthropic-ai/claude-agent-sdk'
  ],
  'vendor runtime guard must cover static, type-only, dynamic, subpath, and require imports'
)
assert.equal(packageJson.build?.afterPack, undefined)
assert.equal(packageJson.build?.mac?.afterPack, undefined)
assert(packageJson.scripts?.['dist:mac:release:x64']?.includes('test:macos-package-size:required'))

const extraResources = packageJson.build?.extraResources || []
for (const resource of [
  ['node_modules/ffmpeg-static/ffmpeg', 'ffmpeg/ffmpeg'],
  ['node_modules/ffmpeg-static/LICENSE', 'ffmpeg/LICENSE'],
  ['node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff', 'office-font/NotoSansSC-Regular.woff'],
  ['node_modules/@fontsource/noto-sans-sc/LICENSE', 'office-font/LICENSE']
]) {
  assert(
    extraResources.some((entry) => entry?.from === resource[0] && entry?.to === resource[1]),
    `missing build-only resource mapping: ${resource[0]}`
  )
}

const x64Steps = workflow.jobs?.['macos-x64']?.steps || []
const x64Upload = x64Steps.find((step) => step.name === 'Upload x64 assets and evidence')
assert(x64Upload, 'x64 distributable upload step is required')
assert(String(x64Upload.with?.path || '').includes('dist/latest-mac.yml'))
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

function findForbiddenRuntimeImports(root) {
  return listSourceFiles(root).flatMap((file) =>
    collectForbiddenRuntimeImports(file, readFileSync(file, 'utf8'))
  )
}

function listSourceFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(absolute))
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(absolute)
    }
  }
  return files.sort()
}

function collectForbiddenRuntimeImports(file, sourceText) {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file)
  )
  const violations = []

  const record = (node, specifier) => {
    if (!isForbiddenRuntimeSpecifier(specifier)) return
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.push({
      file: path.relative(repoRoot, file),
      line: position.line + 1,
      specifier
    })
  }

  const visit = (node) => {
    const specifier = moduleSpecifierFor(node)
    if (specifier) record(node, specifier)
    ts.forEachChild(node, visit)
  }

  visit(source)
  return violations
}

function moduleSpecifierFor(node) {
  return declarationModuleSpecifier(node) ??
    importEqualsModuleSpecifier(node) ??
    importTypeModuleSpecifier(node) ??
    callModuleSpecifier(node)
}

function declarationModuleSpecifier(node) {
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return undefined
  const specifier = node.moduleSpecifier
  return specifier && ts.isStringLiteralLike(specifier) ? specifier.text : undefined
}

function importEqualsModuleSpecifier(node) {
  if (!ts.isImportEqualsDeclaration(node)) return undefined
  if (!ts.isExternalModuleReference(node.moduleReference)) return undefined
  const specifier = node.moduleReference.expression
  return specifier && ts.isStringLiteralLike(specifier) ? specifier.text : undefined
}

function importTypeModuleSpecifier(node) {
  if (!ts.isImportTypeNode(node) || !ts.isLiteralTypeNode(node.argument)) return undefined
  const specifier = node.argument.literal
  return ts.isStringLiteralLike(specifier) ? specifier.text : undefined
}

function callModuleSpecifier(node) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return undefined
  const specifier = node.arguments[0]
  if (!ts.isStringLiteralLike(specifier)) return undefined
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return specifier.text
  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') return specifier.text
  return undefined
}

function isForbiddenRuntimeSpecifier(specifier) {
  for (const dependency of forbiddenRuntimePackages) {
    if (specifier === dependency || specifier.startsWith(`${dependency}/`)) return true
  }
  return false
}

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}
