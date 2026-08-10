#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const repoRoot = process.cwd()
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'windows-signpath-release.yml')
const source = readFileSync(workflowPath, 'utf8')
const workflow = yaml.load(source)
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const artifactConfiguration = readFileSync(path.join(repoRoot, '.signpath', 'artifact-configuration.xml'), 'utf8')
const triggers = workflow.on

assert.equal(workflow.name, 'CaoGen Windows SignPath candidate')
assert.deepEqual(Object.keys(triggers), ['workflow_dispatch'])
assert.equal(triggers.workflow_dispatch.inputs.commit.required, true)
assert.equal(triggers.workflow_dispatch.inputs.commit.type, 'string')
assert.equal(triggers.workflow_dispatch.inputs.publish_artifact.type, 'boolean')
assert.deepEqual(workflow.permissions, { actions: 'read', contents: 'read' })
assert.equal(workflow.concurrency['cancel-in-progress'], false)
assert.match(workflow.concurrency.group, /inputs\.commit/)
assert.deepEqual(Object.keys(workflow.jobs), ['windows-x64'])

const job = workflow.jobs['windows-x64']
assert.equal(job['runs-on'], 'windows-2025')

const inputValidation = step('Validate exact candidate input')
assert.equal(inputValidation.env?.CAOGEN_COMMIT, '${{ inputs.commit }}')
assert.match(inputValidation.run, /\^\[0-9a-fA-F\]\{40\}\$/)

const checkout = step('Check out the exact candidate')
assert.equal(checkout.with?.ref, '${{ inputs.commit }}')
assert.equal(checkout.with?.['fetch-depth'], 0)
assert.equal(checkout.with?.['persist-credentials'], false)
assert.equal(checkout.with?.clean, true)

const exactCheckout = step('Reject a non-exact checkout')
assert.equal(exactCheckout.env?.CAOGEN_COMMIT, '${{ inputs.commit }}')
assert.match(exactCheckout.run, /git rev-parse HEAD/)
assert.match(exactCheckout.run, /ToLowerInvariant/)

const signPathConfiguration = step('Validate SignPath configuration')
for (const name of [
  'SIGNPATH_API_TOKEN',
  'SIGNPATH_ORGANIZATION_ID',
  'SIGNPATH_PROJECT_SLUG',
  'SIGNPATH_SIGNING_POLICY_SLUG',
  'SIGNPATH_ARTIFACT_CONFIGURATION_SLUG'
]) {
  assert(signPathConfiguration.env?.[name], `SignPath preflight must bind ${name}`)
  assert(String(signPathConfiguration.run).includes(`'${name}'`), `SignPath preflight must require ${name}`)
}
assert.match(signPathConfiguration.run, /IsNullOrWhiteSpace/)

const build = step('Build unsigned NSIS input')
assert.deepEqual(build.env, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
assert.match(build.run, /electron-builder --config electron-builder\.windows-preview\.cjs --win nsis --x64 --publish never/)

const staging = step('Read version and stage signing input')
assert.match(staging.run, /CaoGen-\$\(\$Package\.version\)-windows-x64-unsigned-preview\.exe/)
assert.match(staging.run, /signpath-input/)

const signingInput = step('Upload immutable SignPath input')
assert.equal(signingInput.with?.['if-no-files-found'], 'error')
assert.equal(signingInput.with?.['compression-level'], 0)
assert.match(signingInput.with?.name, /inputs\.commit/)
assert.match(signingInput.with?.path, /steps\.package\.outputs\.input-name/)

const signPath = step('Submit SignPath signing request')
assert.equal(signPath.with?.['api-token'], '${{ secrets.SIGNPATH_API_TOKEN }}')
assert.equal(signPath.with?.['organization-id'], '${{ secrets.SIGNPATH_ORGANIZATION_ID }}')
assert.equal(signPath.with?.['project-slug'], '${{ vars.SIGNPATH_PROJECT_SLUG }}')
assert.equal(signPath.with?.['signing-policy-slug'], '${{ vars.SIGNPATH_SIGNING_POLICY_SLUG }}')
assert.equal(signPath.with?.['artifact-configuration-slug'], '${{ vars.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG }}')
assert.equal(signPath.with?.['github-artifact-id'], '${{ steps.signing-input.outputs.artifact-id }}')
assert.equal(signPath.with?.['github-token'], '${{ github.token }}')
assert.equal(signPath.with?.['output-artifact-directory'], 'signpath-output')

const verification = step('Verify Authenticode result')
assert.match(verification.run, /\$Files\.Count -ne 1/)
assert.match(verification.run, /\$File\.Name -ne \$env:CAOGEN_INPUT_NAME/)
assert.match(verification.run, /Get-AuthenticodeSignature/)
assert.match(verification.run, /Status -ne 'Valid'/)
assert.match(verification.run, /TimeStamperCertificate/)
assert.match(verification.run, /\$Digest  \$ReleaseName/)
assert.match(verification.run, /PROVENANCE\.json/)
assert.match(verification.run, /signerThumbprint/)

const upload = step('Upload signed Windows candidate')
assert.equal(upload.if, '${{ inputs.publish_artifact }}')
assert.equal(upload.with?.['if-no-files-found'], 'error')
for (const requiredPath of ['steps.signed.outputs.release-name', 'SHA256SUMS.txt', 'PROVENANCE.json']) {
  assert(String(upload.with?.path).includes(requiredPath), `signed output must include ${requiredPath}`)
}

for (const action of job.steps.filter((item) => typeof item.uses === 'string').map((item) => item.uses.replace(/\s+#.*$/, ''))) {
  assert.match(action, /^[^@]+@[0-9a-f]{40}$/i, `action must be pinned to a full commit: ${action}`)
}
for (const item of job.steps.filter((candidate) => typeof candidate.run === 'string')) {
  assert(!item.run.includes('${{ inputs.commit }}'), `${item.name} must not interpolate untrusted dispatch input into PowerShell`)
}
assert(!/(^|\n)\s*(push|schedule|release):/m.test(source), 'signing must only run through an explicit dispatch')
assert(!/gh\s+release|create-release|softprops\/action-gh-release|contents:\s*write/i.test(source), 'candidate workflow must not publish a release')
assert.match(
  packageJson.scripts?.['test:release-workflow-contract'] ?? '',
  /windows-signpath-workflow-contract-smoke\.mjs/,
  'aggregate release workflow contract must include the SignPath gate'
)
assert.match(artifactConfiguration, /<artifact-configuration xmlns="http:\/\/signpath\.io\/artifact-configuration\/v1">/)
assert.match(artifactConfiguration, /<zip-file>/)
assert.match(artifactConfiguration, /<pe-file path="CaoGen-\*-windows-x64-unsigned-preview\.exe">/)
assert.match(artifactConfiguration, /<authenticode-sign\s*\/>/)

console.log('Windows SignPath workflow contract smoke: passed')

function step(name) {
  const value = job.steps.find((candidate) => candidate.name === name)
  assert(value, `workflow step is missing: ${name}`)
  return value
}
