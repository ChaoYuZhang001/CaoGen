import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-desk-start-suggestions-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'repo')
const noGitDir = path.join(tempRoot, 'no-git')
const largeDir = path.join(tempRoot, 'large')
const timeoutDir = path.join(tempRoot, 'git-timeout')
const fakeGitDir = path.join(tempRoot, 'fake-git-bin')

try {
  const tscArgs = [
    'tsc',
    'src/main/startSuggestions.ts',
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
  ]
  execFileSync(
    npxCommand(),
    npxArgs(tscArgs),
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const compiledModule = findCompiledModule(outDir)
  if (!compiledModule) throw new Error(`compiled startSuggestions.js not found under ${outDir}`)
  const startSuggestions = await import(pathToFileURL(compiledModule).href)

  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify(
      {
        name: 'suggestion-smoke',
        scripts: {
          typecheck: 'tsc --noEmit',
          test: 'node test.js'
        }
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(path.join(projectDir, 'README.md'), '# Smoke\n\nTODO: wire the start suggestions helper.\n', 'utf8')
  writeFileSync(path.join(projectDir, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8')

  git(projectDir, ['init'])
  git(projectDir, ['config', 'user.email', 'smoke@example.test'])
  git(projectDir, ['config', 'user.name', 'Start Suggestions Smoke'])
  git(projectDir, ['add', 'package.json', 'README.md', 'package-lock.json'])
  git(projectDir, ['commit', '-m', 'initial'])
  const fsmonitorMarker = path.join(projectDir, 'fsmonitor-ran.txt')
  const fsmonitorPath = path.join(projectDir, process.platform === 'win32' ? 'fsmonitor.cmd' : 'fsmonitor.sh')
  writeFileSync(
    fsmonitorPath,
    process.platform === 'win32'
      ? `@echo off\r\ntype nul > "${fsmonitorMarker}"\r\necho 1\r\necho.\r\n`
      : `#!/bin/sh\ntouch ${JSON.stringify(fsmonitorMarker)}\nprintf '1\\n\\n'\n`,
    'utf8'
  )
  if (process.platform !== 'win32') chmodSync(fsmonitorPath, 0o755)
  git(projectDir, ['config', 'core.fsmonitor', fsmonitorPath])

  writeFileSync(path.join(projectDir, 'README.md'), '# Smoke\n\nTODO: finish the helper smoke test.\n', 'utf8')
  writeFileSync(path.join(projectDir, 'TODO.md'), 'FIXME: cover git dirty state.\n', 'utf8')

  const suggestions = startSuggestions.buildStartSuggestions({
    projectDir,
    memoryEntries: [
      {
        title: 'Last attempt failed',
        body: 'Smoke memory says the previous run failed during validation.',
        status: 'failed'
      }
    ],
    worktreeSummaries: [
      {
        title: 'Feature worktree has changed files',
        summary: 'A related worktree is dirty but has no conflict.'
      }
    ]
  })

  assert(Array.isArray(suggestions), 'buildStartSuggestions should return an array')
  assert(suggestions.length > 0, 'temp project should produce suggestions')
  for (const suggestion of suggestions) assertSuggestionShape(suggestion)
  assertHasSource(suggestions, 'git-status')
  assertHasSource(suggestions, 'readme-todo')
  assertHasSource(suggestions, 'package-json')
  assertHasSource(suggestions, 'memory')
  assert(!existsSync(fsmonitorMarker), 'start suggestions must not execute core.fsmonitor')
  assert(
    suggestions.some((suggestion) => suggestion.priority === 'high'),
    'dirty/failure/TODO signals should include a high-priority suggestion'
  )
  assert(!readFileSync(path.join(projectDir, 'TODO.md'), 'utf8').includes('generated'), 'helper should not write project files')

  mkdirSync(noGitDir, { recursive: true })
  writeFileSync(path.join(noGitDir, 'package.json'), '{"name":"no-git","scripts":{"build":"vite build"}}\n', 'utf8')
  const noGitSuggestions = startSuggestions.getStartSuggestions(noGitDir)
  assert(Array.isArray(noGitSuggestions), 'non-git project should not throw')
  assert(!noGitSuggestions.some((suggestion) => suggestion.source === 'git-status'), 'non-git project should not emit git suggestions')
  assertHasSource(noGitSuggestions, 'package-json')

  mkdirSync(largeDir, { recursive: true })
  writeFileSync(path.join(largeDir, 'README.md'), `TODO: ${'large '.repeat(40_000)}`, 'utf8')
  const largeSuggestions = startSuggestions.buildStartSuggestions({
    projectDir: largeDir,
    maxFileBytes: 1_024
  })
  assert(
    !largeSuggestions.some((suggestion) => suggestion.source === 'readme-todo'),
    'large README should be skipped instead of read for TODO suggestions'
  )

  mkdirSync(timeoutDir, { recursive: true })
  writeFileSync(path.join(timeoutDir, 'package.json'), '{"name":"git-timeout","scripts":{"typecheck":"tsc --noEmit"}}\n', 'utf8')
  mkdirSync(fakeGitDir, { recursive: true })
  const fakeGitPath = path.join(fakeGitDir, process.platform === 'win32' ? 'git.cmd' : 'git')
  writeFileSync(
    fakeGitPath,
    process.platform === 'win32'
      ? '@echo off\r\nping -n 6 127.0.0.1 > nul\r\nexit /b 1\r\n'
      : '#!/bin/sh\nsleep 5\nexit 1\n',
    'utf8'
  )
  if (process.platform !== 'win32') chmodSync(fakeGitPath, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${fakeGitDir}${path.delimiter}${previousPath || ''}`
  const timeoutStarted = Date.now()
  try {
    const timeoutSuggestions = startSuggestions.getStartSuggestions(timeoutDir)
    const elapsedMs = Date.now() - timeoutStarted
    assert(elapsedMs < 3000, `git timeout path should return promptly, took ${elapsedMs}ms`)
    assertHasSource(timeoutSuggestions, 'package-json')
    assert(
      !timeoutSuggestions.some((suggestion) => suggestion.source === 'git-status'),
      'timed out git status should not emit git suggestions'
    )
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }

  console.log('startSuggestions smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = result.stderr.trim() || result.stdout.trim()
    throw new Error(`git ${args.join(' ')} failed: ${output}`)
  }
  return result.stdout.trim()
}

function findCompiledModule(root) {
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath)
      if (found) return found
    } else if (entry.isFile() && entry.name === 'startSuggestions.js') {
      return fullPath
    }
  }
  return undefined
}

function npxCommand() {
  return process.platform === 'win32' ? 'cmd' : 'npx'
}

function npxArgs(args) {
  return process.platform === 'win32' ? ['/c', 'npx', ...args] : args
}

function assertHasSource(suggestions, source) {
  assert(
    suggestions.some((suggestion) => suggestion.source === source),
    `expected suggestion source ${source}, got ${suggestions.map((suggestion) => suggestion.source).join(', ')}`
  )
}

function assertSuggestionShape(suggestion) {
  assert(typeof suggestion.id === 'string' && suggestion.id, 'suggestion.id should be non-empty')
  assert(typeof suggestion.title === 'string' && suggestion.title, 'suggestion.title should be non-empty')
  assert(typeof suggestion.body === 'string' && suggestion.body, 'suggestion.body should be non-empty')
  assert(typeof suggestion.source === 'string' && suggestion.source, 'suggestion.source should be non-empty')
  assert(['high', 'medium', 'low'].includes(suggestion.priority), 'suggestion.priority should be valid')
  assert(typeof suggestion.prompt === 'string' && suggestion.prompt, 'suggestion.prompt should be non-empty')
}

function assert(condition, message = 'assertion failed') {
  if (!condition) {
    throw new Error(message)
  }
}
