import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-skill-manager-'))
const outDir = path.join(tempRoot, 'compiled')
const projectRoot = path.join(tempRoot, 'project')

try {
  mkdirSync(path.join(projectRoot, '.caogen', 'skills', 'react-component'), { recursive: true })
  writeFileSync(
    path.join(projectRoot, '.caogen', 'skills', 'react-component', 'SKILL.md'),
    [
      '---',
      'name: React Component Builder',
      'description: Build typed React components with project styles.',
      'version: 1.0.0',
      'trigger: react component',
      'tags: react, frontend, ui',
      '---',
      '',
      '## Steps',
      '- Inspect existing component style.',
      '- Implement typed props.',
      '',
      '## Verification',
      '- npm.cmd run typecheck'
    ].join('\n'),
    'utf8'
  )

  compile(['src/main/skill/skill-manager.ts', 'src/main/skill/skill-loader.ts'], outDir)
  const modulePath = findCompiled(outDir, 'skill-manager.js')
  const { SkillManager } = await import(pathToFileURL(modulePath).href)
  const manager = new SkillManager({ projectRoot })
  const result = manager.reload()

  assert(result.skills.length >= 21, 'built-in skill catalog should cover 20+ common workflows')
  const figma = result.skills.find((skill) => skill.name === 'Figma 转代码')
  assert(figma?.body.includes('Figma URL'), 'Figma built-in skill should include dedicated workflow steps')
  const local = result.skills.find((skill) => skill.name === 'React Component Builder')
  assert(local, 'project .caogen/skills/SKILL.md should be loaded')

  const matches = manager.match('please build a typed react component with UI styles', 0.1)
  assert(matches.some((match) => match.skill.id === local.id), 'query should match local skill')

  const exported = manager.exportSkill(local.id)
  assert(exported?.includes('React Component Builder'), 'exportSkill should serialize skill details')
  console.log('skillManager smoke ok')
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
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiled(fullPath, fileName)
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
