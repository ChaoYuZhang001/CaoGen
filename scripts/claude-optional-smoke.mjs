#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-claude-optional-'))

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/engine.ts',
      '--outDir',
      tempRoot,
      '--rootDir',
      'src',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const engineRegistry = await import(pathToFileURL(path.join(tempRoot, 'main', 'engine.js')).href)
  engineRegistry.registerEngine({
    kind: 'openai',
    label: 'OpenAI-compatible',
    available: () => true,
    create: () => {
      throw new Error('not used')
    }
  })
  engineRegistry.registerEngine({
    kind: 'claude',
    label: 'Claude Agent SDK',
    available: () => true,
    optional: true,
    configured: () => false,
    create: () => {
      throw new Error('not used')
    }
  })
  engineRegistry.registerEngine({
    kind: 'broken-optional',
    label: 'Broken optional probe',
    available: () => true,
    optional: true,
    configured: () => {
      throw new Error('missing external configuration')
    },
    create: () => {
      throw new Error('not used')
    }
  })

  const engines = engineRegistry.listEngines()
  const openai = engines.find((engine) => engine.kind === 'openai')
  const claude = engines.find((engine) => engine.kind === 'claude')
  const broken = engines.find((engine) => engine.kind === 'broken-optional')
  assert(openai?.available && openai.configured && !openai.optional, 'OpenAI-compatible must stay independently available')
  assert(claude?.available && claude.optional && !claude.configured, 'Claude must be available as an unconfigured optional engine')
  assert(broken?.available && !broken.configured, 'optional configuration probe failures must fail closed without blocking engine listing')

  const builtinEngines = source('src/main/engines.ts')
  assert(builtinEngines.includes('optional: true'), 'Claude factory must be marked optional')
  assert(builtinEngines.includes('configured: () =>'), 'Claude factory must expose configuration state')

  const sessionManager = source('src/main/sessionManager.ts')
  assert(!sessionManager.includes("?? 'claude'"), 'SessionManager must not interpret a missing engine as Claude')
  const sessionRouting = source('src/main/model/session-routing.ts')
  assert(!sessionRouting.includes("engine === undefined || engine === 'claude'"), 'routing must not treat an unspecified engine as Claude')

  for (const file of [
    'src/renderer/src/components/NewSessionModal.tsx',
    'src/renderer/src/components/WelcomeView.tsx',
    'src/renderer/src/components/RoutineEditor.tsx'
  ]) {
    const ui = source(file)
    assert(ui.includes('optionalEngineNotConfigured'), `${file} must label unconfigured Claude as optional`)
    assert(
      ui.includes('!en.available || (en.optional && !en.configured)'),
      `${file} must disable an optional engine until it is configured`
    )
    assert(ui.includes('[providers]'), `${file} must refresh engine configuration after Provider changes`)
  }

  const doctor = source('scripts/workos-release-doctor.mjs')
  assert(doctor.includes("id: 'claude'"), 'release doctor must declare the Claude policy')
  assert(doctor.includes('releaseRequired: false'), 'Claude authentication must not be a release requirement')
  assert(doctor.includes('defaultSelected: false'), 'Claude must not be selected by default')
  const doctorReport = JSON.parse(
    execFileSync(process.execPath, ['scripts/workos-release-doctor.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
  )
  assert(
    !doctorReport.domains.some((domain) => /claude|anthropic/i.test(`${domain.id} ${domain.title}`)),
    'release domains must not contain a Claude authentication gate'
  )
  assert(
    !doctorReport.openDomains.some((id) => /claude|anthropic/i.test(id)),
    'missing Claude authentication must not block release readiness'
  )

  const controlCenterUi = source('src/renderer/src/components/ControlCenter.tsx')
  assert(
    controlCenterUi.includes("engine.status === 'available'"),
    'Control Center ready count must exclude unconfigured optional engines'
  )

  console.log('claude optional smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
