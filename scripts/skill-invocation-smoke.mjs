import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-skill-invocation-'))
const outDir = path.join(tempRoot, 'compiled')
const projectRoot = path.join(tempRoot, 'project')

try {
  mkdirSync(path.join(projectRoot, '.caogen', 'skills', 'tailwind-config'), { recursive: true })
  writeFileSync(
    path.join(projectRoot, '.caogen', 'skills', 'tailwind-config', 'SKILL.md'),
    [
      '---',
      'name: Tailwind Config Builder',
      'description: Add or repair Tailwind configuration in a TypeScript frontend project.',
      'trigger: tailwind config frontend styles',
      'tags: tailwind, frontend, typescript',
      '---',
      '',
      '## Steps',
      '- Inspect package.json and existing Tailwind files.',
      '- Update tailwind.config and postcss config.',
      '',
      '## Verification',
      '- npm.cmd run typecheck',
      '- npm.cmd run build'
    ].join('\n'),
    'utf8'
  )

  compile(
    ['src/main/skill/skill-loader.ts', 'src/main/skill/skill-manager.ts', 'src/main/skill/skill-invocation.ts'],
    outDir
  )
  const modulePath = findCompiled(outDir, 'skill-invocation.js')
  const { buildSkillInvocationPrompt } = await import(pathToFileURL(modulePath).href)
  const loader = await import(pathToFileURL(findCompiled(outDir, 'skill-loader.js')).href)
  const serialized = loader.serializeSkill({
    name: 'Serialized Skill',
    description: 'Verify frontmatter body split.',
    trigger: 'serialized skill',
    tags: ['test'],
    version: '0.1.0',
    body: '# Serialized Skill\n\n## Steps\n1. Check.\n\n## Verification\n1. Pass.'
  })
  assert(serialized.includes('---\n# Serialized Skill'), 'serialized skill frontmatter must end before body')

  const disabled = buildSkillInvocationPrompt({
    enabled: false,
    projectRoot,
    query: 'Please add Tailwind config to this TypeScript frontend.'
  })
  assert(disabled === '', 'disabled skill invocation should not inject prompt')

  const prompt = buildSkillInvocationPrompt({
    enabled: true,
    projectRoot,
    query: 'Please add Tailwind config to this TypeScript frontend.'
  })
  assert(prompt.includes('Tailwind Config Builder'), 'matched skill should be injected')
  assert(prompt.includes('npm.cmd run build'), 'verification steps should be injected')
  assert(!prompt.includes('## Current User Request'), 'skill helper should leave request boundary to engine integration')

  const unrelated = buildSkillInvocationPrompt({
    enabled: true,
    projectRoot,
    query: 'Explain a cooking recipe'
  })
  assert(!unrelated.includes('Tailwind Config Builder'), 'unrelated query should not inject local skill')

  console.log('skillInvocation smoke ok')
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
      '--esModuleInterop',
      '--strict'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled file not found: ${fileName}`)
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
