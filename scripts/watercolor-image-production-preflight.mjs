#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const reportPath = path.join(repoRoot, 'test-results', 'watercolor-image-production', 'latest.json')
const masterDir = path.join(repoRoot, 'output', 'imagegen', 'caogen-watercolor-v1')
const chromaDir = path.join(masterDir, 'runtime-chroma')
const runtimeDir = path.join(repoRoot, 'src', 'renderer', 'src', 'assets', 'watercolor-characters')
const promptDir = path.join(repoRoot, 'docs', 'visual-prompts')
const runtimePromptPath = path.join(promptDir, 'runtime-transparent-derivative-v01.prompt.txt')
const requiredStage = readRequiredStage()

const roles = ['researcher', 'planner', 'writer', 'designer', 'developer', 'review-test', 'operations']
const states = ['idle', 'thinking', 'tool-running', 'awaiting-approval', 'blocked', 'repairing', 'delivering']
const pendingStateOrder = ['blocked', 'delivering', 'thinking', 'repairing']
const generatedStateNames = states.filter((state) => state !== 'idle')
const runtimePrompt = readUtf8(runtimePromptPath)
const runtimePromptViolations = validateRuntimePrompt(runtimePrompt)
const runtimePromptSha256 = runtimePrompt ? sha256(Buffer.from(runtimePrompt, 'utf8')) : undefined

const anchors = roles.map((role) => {
  const version = role === 'planner' ? 'v02' : 'v01'
  return describeFile(path.join(masterDir, `role-${role}-anchor-${version}.png`), { role, version })
})
const statePrompts = roles.flatMap((role) => generatedStateNames.map((state) => {
  const filePath = path.join(promptDir, `role-${role}-state-${state}-v01.prompt.txt`)
  const text = readUtf8(filePath)
  return {
    role,
    state,
    path: relative(filePath),
    present: text !== undefined,
    sha256: text ? sha256(Buffer.from(text, 'utf8')) : undefined,
    violations: validateStatePrompt(text)
  }
}))
const jobs = roles.flatMap((role) => states.map((state) => {
  const filename = `role-${role}-state-${state}-v01.png`
  const sourcePath = path.join(masterDir, filename)
  const source = describeFile(sourcePath, { role, state })
  return {
    role,
    state,
    filename,
    source: {
      path: source.path,
      present: source.present,
      bytes: source.bytes,
      sha256: source.sha256,
      dimensions: source.dimensions,
      violations: source.violations
    },
    statePrompt: state === 'idle' ? null : `docs/visual-prompts/role-${role}-state-${state}-v01.prompt.txt`,
    runtimePrompt: relative(runtimePromptPath),
    runtimePromptSha256,
    request: {
      mode: 'edit',
      model: 'gpt-image-2',
      size: '1024x1536',
      quality: 'high',
      outputFormat: 'png'
    },
    chromaOutput: relative(path.join(chromaDir, filename)),
    runtimeOutput: relative(path.join(runtimeDir, filename))
  }
}))

const missingAnchors = anchors.filter((item) => !item.present).map((item) => item.path)
const invalidAnchors = anchors.filter((item) => item.present && item.violations.length > 0)
const invalidStatePrompts = statePrompts.filter((item) => !item.present || item.violations.length > 0)
const missingMasters = jobs.filter((job) => !job.source.present).map((job) => job.source.path)
const invalidMasters = jobs.filter((job) => job.source.present && job.source.violations.length > 0)
const pendingGenerationJobs = pendingStateOrder.flatMap((state) => roles.map((role) => {
  const anchor = anchors.find((item) => item.role === role)
  const prompt = statePrompts.find((item) => item.role === role && item.state === state)
  return {
    role,
    state,
    image: anchor?.path,
    prompt: prompt?.path,
    promptSha256: prompt?.sha256,
    output: `output/imagegen/caogen-watercolor-v1/role-${role}-state-${state}-v01.png`,
    request: { mode: 'edit', model: 'gpt-image-2', size: '1024x1536', quality: 'high', outputFormat: 'png' }
  }
}))
const credentials = {
  openaiApiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
  openaiBaseUrlPresent: Boolean(process.env.OPENAI_BASE_URL)
}
const structureValid = missingAnchors.length === 0 && invalidAnchors.length === 0 && invalidStatePrompts.length === 0 && runtimePromptViolations.length === 0
const credentialsReady = credentials.openaiApiKeyPresent && credentials.openaiBaseUrlPresent
const stateGenerationReady = structureValid && credentialsReady
const runtimeDerivativesReady = structureValid && credentialsReady && missingMasters.length === 0 && invalidMasters.length === 0
const status = !structureValid
  ? 'invalid'
  : !credentialsReady && missingMasters.length > 0
    ? 'blocked-env-and-sources'
    : !credentialsReady
      ? 'blocked-env'
      : missingMasters.length > 0
        ? 'missing-sources'
        : 'ready'

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status,
  requiredStage,
  contract: {
    roles,
    states,
    expectedRuntimeAssets: jobs.length,
    pendingStateOrder,
    request: { mode: 'edit', model: 'gpt-image-2', size: '1024x1536', quality: 'high', outputFormat: 'png' },
    runtimePrompt: relative(runtimePromptPath),
    runtimePromptSha256
  },
  credentials,
  readiness: {
    structureValid,
    credentialsReady,
    stateGenerationReady,
    runtimeDerivativesReady
  },
  counts: {
    anchorsExpected: roles.length,
    anchorsPresent: anchors.length - missingAnchors.length,
    statePromptsExpected: statePrompts.length,
    statePromptsValid: statePrompts.length - invalidStatePrompts.length,
    pendingStateJobs: pendingGenerationJobs.length,
    mastersExpected: jobs.length,
    mastersPresent: jobs.length - missingMasters.length,
    mastersValid: jobs.length - missingMasters.length - invalidMasters.length,
    mastersMissing: missingMasters.length,
    mastersInvalid: invalidMasters.length
  },
  runtimePromptViolations,
  missingAnchors,
  invalidAnchors,
  invalidStatePrompts,
  missingMasters,
  invalidMasters,
  anchors,
  pendingGenerationJobs,
  jobs
}

mkdirSync(path.dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`watercolor image production preflight: ${status}`)
console.log(`state generation: ${stateGenerationReady ? 'ready' : 'not ready'}; runtime derivatives: ${runtimeDerivativesReady ? 'ready' : 'not ready'}`)
console.log(`inputs: ${report.counts.mastersPresent}/${report.counts.mastersExpected} masters, ${report.counts.statePromptsValid}/${report.counts.statePromptsExpected} prompts`)
console.log(`report: ${reportPath}`)

if (!structureValid || (requiredStage === 'state-generation' && !stateGenerationReady) || (requiredStage === 'runtime-derivatives' && !runtimeDerivativesReady)) {
  process.exitCode = 1
}

function readRequiredStage() {
  const argument = process.argv.find((value) => value.startsWith('--required='))
  const stage = argument?.slice('--required='.length)
  if (!stage) return null
  if (stage !== 'state-generation' && stage !== 'runtime-derivatives') {
    throw new Error(`unknown required stage: ${stage}`)
  }
  return stage
}

function readUtf8(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined
}

function validateRuntimePrompt(prompt) {
  if (!prompt) return ['runtime transparent prompt is missing']
  const required = [
    'Change only the background',
    'perfectly flat solid #00ff00 chroma-key background',
    'no shadows, gradients, texture, paper grain, reflections, floor plane, horizon, lighting variation',
    'Do not use #00ff00',
    'No cast shadow, contact shadow, reflection, glow, halo, floor, pedestal',
    'Do not redesign, recolor, relight, crop, rescale or reposition the character'
  ]
  return required.filter((value) => !prompt.includes(value)).map((value) => `missing required invariant: ${value}`)
}

function validateStatePrompt(prompt) {
  if (!prompt) return ['state prompt is missing']
  const violations = []
  if (!prompt.includes('Use case: identity-preserve')) violations.push('missing identity-preserve use case')
  if (!prompt.includes('Input images: Image 1')) violations.push('missing Image 1 identity reference')
  if (!prompt.includes('Identity invariants:')) violations.push('missing identity invariants')
  if (!prompt.includes('Exactly one character.')) violations.push('missing exact character-count constraint')
  if (prompt.includes('Awaiting-Approval')) {
    const required = [
      'two-layer off-white approval request slip',
      'clipped upper corner',
      'empty cinnabar square stamp frame placed off-center',
      'any national flag or flag-like composition',
      'centered disc',
      'red dot',
      'circular seal'
    ]
    for (const value of required) {
      if (!prompt.includes(value)) violations.push(`awaiting-approval prompt missing required invariant: ${value}`)
    }
    if (prompt.includes('solid cinnabar circular seal')) violations.push('awaiting-approval prompt retains the rejected circular-seal composition')
  }
  return violations
}

function describeFile(filePath, metadata) {
  if (!existsSync(filePath)) return { ...metadata, path: relative(filePath), present: false, violations: [] }
  const bytes = readFileSync(filePath)
  const dimensions = readPngDimensions(bytes)
  return {
    ...metadata,
    path: relative(filePath),
    present: true,
    bytes: statSync(filePath).size,
    sha256: sha256(bytes),
    dimensions,
    violations: dimensions ? [] : ['invalid PNG signature or IHDR']
  }
}

function readPngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    return null
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}
