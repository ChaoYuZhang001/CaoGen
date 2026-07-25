#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const repoRoot = process.cwd()
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'windows-unsigned-build.yml')
const source = readFileSync(workflowPath, 'utf8')
const workflow = yaml.load(source)
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const triggers = workflow.on

assert.equal(workflow.name, 'CaoGen Windows unsigned build')
assert.deepEqual(Object.keys(triggers), ['workflow_dispatch', 'pull_request'])
assert.deepEqual(triggers.pull_request.branches, ['main'])
assert.deepEqual(triggers.pull_request.paths, [
  '.github/workflows/windows-unsigned-build.yml',
  'package.json',
  'package-lock.json',
  'scripts/packaged-app-smoke.mjs',
  'scripts/prepare-native-build.cjs',
  'scripts/windows-unsigned-workflow-contract-smoke.mjs'
], 'pull request builds must be limited to Windows packaging changes')
assert.deepEqual(workflow.permissions, { contents: 'read' }, 'unsigned Windows workflow must be read-only')
assert.equal(workflow.concurrency['cancel-in-progress'], false)
assert.match(workflow.concurrency.group, /github\.event\.pull_request\.number \|\| github\.ref/)
assert.deepEqual(Object.keys(workflow.jobs), ['windows-x64'])

const job = workflow.jobs['windows-x64']
assert.equal(job['runs-on'], 'windows-2025')
const checkout = job.steps.find((step) => step.name === 'Check out the selected commit')
assert.equal(checkout?.with?.ref, '${{ github.sha }}')
assert.equal(checkout?.with?.['persist-credentials'], false)

const build = job.steps.find((step) => step.name === 'Build unsigned Windows installer')
assert.deepEqual(build?.env, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
assert.match(build?.run ?? '', /electron-builder --win --x64 --publish never/)

const verify = job.steps.find((step) => step.name === 'Verify unsigned installer in a custom directory')
assert.equal(verify?.run, 'npm run test:packaged-app:win:x64:unsigned')

const upload = job.steps.find((step) => step.name === 'Upload unsigned installer and evidence')
assert(upload, 'unsigned artifact upload step is required')
assert.equal(upload.with?.['if-no-files-found'], 'error')
for (const requiredPath of [
  'dist/CaoGen Setup ${{ steps.package.outputs.version }}.exe',
  'dist/CaoGen Setup ${{ steps.package.outputs.version }}.exe.blockmap',
  'dist/latest.yml',
  'test-results/packaged-app-smoke/latest-windows-unsigned-x64.json'
]) {
  assert(String(upload.with?.path || '').includes(requiredPath), `unsigned upload must include ${requiredPath}`)
}

assert.equal(packageJson.build?.nsis?.oneClick, false, 'unsigned installer must use the assisted installer')
assert.equal(
  packageJson.build?.nsis?.allowToChangeInstallationDirectory,
  true,
  'unsigned installer must allow a custom installation directory'
)
assert.match(
  packageJson.scripts?.['test:packaged-app:win:x64:unsigned'] ?? '',
  /packaged-app-smoke\.mjs --platform windows --arch x64 --unsigned/
)
assert(!/(^|\n)\s*(push|schedule|release):/m.test(source), 'unsigned builds must not run on pushes, schedules, or releases')
assert(!/secrets\.|CSC_LINK|CSC_KEY_PASSWORD|electron-builder\.release\.cjs/i.test(source), 'unsigned workflow must not consume signing credentials or release signing config')
assert(!/gh\s+release|create-release|softprops\/action-gh-release|contents:\s*write/i.test(source), 'unsigned workflow must not publish a release')

for (const action of job.steps.filter((step) => typeof step.uses === 'string').map((step) => step.uses.replace(/\s+#.*$/, ''))) {
  assert.match(action, /^[^@]+@[0-9a-f]{40}$/i, `action must be pinned to a full commit: ${action}`)
}

console.log('Windows unsigned workflow contract smoke: passed')
