#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const repoRoot = process.cwd()
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'release-integrity-audit.yml')
const source = readFileSync(workflowPath, 'utf8')
const workflow = yaml.load(source)
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const triggers = workflow.on

assert.equal(workflow.name, 'CaoGen release integrity audit')
assert.deepEqual(Object.keys(triggers), ['schedule', 'workflow_dispatch'])
assert.deepEqual(triggers.schedule, [{ cron: '17 */6 * * *' }])
assert.deepEqual(workflow.permissions, { contents: 'read' }, 'release integrity audit must be read-only')
assert.equal(workflow.concurrency.group, 'caogen-release-integrity-audit')
assert.equal(workflow.concurrency['cancel-in-progress'], false)
assert.deepEqual(Object.keys(workflow.jobs), ['audit'])

const job = workflow.jobs.audit
assert.equal(job['runs-on'], 'ubuntu-24.04')
const releaseProbe = job.steps.find((step) => step.name === 'Check whether the target release is published')
assert.equal(releaseProbe?.id, 'release')
assert.equal(releaseProbe?.env?.GH_TOKEN, '${{ github.token }}')
assert.match(releaseProbe?.run ?? '', /require\('\.\/package\.json'\)\.version/)
assert.match(releaseProbe?.run ?? '', /releases\/tags\/\$\{tag\}/)
assert.match(releaseProbe?.run ?? '', /200\)[\s\S]*published=true/)
assert.match(releaseProbe?.run ?? '', /404\)[\s\S]*published=false/)
assert.match(releaseProbe?.run ?? '', /GitHub release lookup failed/)
const audit = job.steps.find((step) => step.name === 'Audit the published release')
assert.equal(audit?.run, 'npm run test:github-release-integrity:required')
assert.equal(audit?.if, "steps.release.outputs.published == 'true'")
assert.match(
  packageJson.scripts?.['test:github-release-integrity:required'] ?? '',
  /github-release-audit\.mjs --required --read-text-assets --expected-assets-from-notes docs\/RELEASE-NOTES-FINAL\.md/,
  'the scheduled audit must bind names, digests, and body to the final notes contract'
)

const upload = job.steps.find((step) => step.name === 'Upload the redacted audit report')
assert.equal(upload?.if, "always() && steps.release.outputs.published == 'true'")
assert.equal(upload?.with?.path, 'test-results/github-release-audit/**')
assert.equal(upload?.with?.['if-no-files-found'], 'error')
assert(!/gh\s+release|create-release|softprops\/action-gh-release|contents:\s*write/i.test(source), 'integrity audit must not mutate releases')

for (const action of job.steps.filter((step) => typeof step.uses === 'string').map((step) => step.uses.replace(/\s+#.*$/, ''))) {
  assert.match(action, /^[^@]+@[0-9a-f]{40}$/i, `action must be pinned to a full commit: ${action}`)
}

console.log('Release integrity workflow contract smoke: passed')
