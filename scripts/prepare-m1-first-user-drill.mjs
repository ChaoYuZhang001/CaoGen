#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

const repoRoot = realpathSync(process.cwd())
const evidenceDirArg = argValue('--evidence-dir')
const releaseBinding = {
  releaseTag: 'v0.1.7',
  candidateCommit: 'bbec526554aea9785291edf4d8164084145347ae',
  assetSha256: 'a6b65ddd7d11bc8aab36cd800a7ddd9055b562d5aa85b39ef0296fb9c4f78a7b'
}

if (process.argv.includes('--help')) {
  console.log('Usage: npm run prepare:m1-first-user-drill -- --evidence-dir /absolute/private/path')
  process.exit(0)
}

try {
  const evidenceDir = validateEvidenceDir(evidenceDirArg)
  process.umask(0o077)
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  chmodSync(evidenceDir, 0o700)

  const recordPath = path.join(evidenceDir, 'm1-first-user.json')
  const checklistPath = path.join(evidenceDir, 'HOST-CHECKLIST.txt')
  const record = buildRecord(evidenceDir)

  writePrivateFile(recordPath, `${JSON.stringify(record, null, 2)}\n`)
  writePrivateFile(checklistPath, buildChecklist(evidenceDir, recordPath))

  console.log(JSON.stringify({
    status: 'prepared',
    evidenceDir,
    recordPath,
    checklistPath,
    releaseBinding,
    next: 'Open HOST-CHECKLIST.txt. Do not commit or upload this directory.'
  }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

function validateEvidenceDir(value) {
  if (!value) throw new Error('missing --evidence-dir <absolute-private-path>')
  if (!path.isAbsolute(value)) throw new Error('--evidence-dir must be an absolute path')

  const target = path.resolve(value)
  if (target === path.parse(target).root) throw new Error('--evidence-dir cannot be a filesystem root')
  if (target === repoRoot || target.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error('--evidence-dir must be outside the CaoGen repository')
  }

  const existingAncestor = nearestExistingAncestor(target)
  if (realpathSync(existingAncestor) !== existingAncestor) {
    throw new Error('--evidence-dir cannot traverse a symbolic-link ancestor')
  }

  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('--evidence-dir must be a real directory, not a file or symbolic link')
    }
    if (readdirSync(target).length > 0) {
      throw new Error('--evidence-dir must be new or empty; existing evidence is never overwritten')
    }
  }

  return target
}

function nearestExistingAncestor(target) {
  let current = target
  while (!existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) throw new Error('could not resolve an existing parent for --evidence-dir')
    current = parent
  }
  return current
}

function buildRecord(evidenceDir) {
  const templatePath = path.join(repoRoot, 'docs', 'M1-FIRST-USER-RESULT.template.json')
  const record = JSON.parse(readFileSync(templatePath, 'utf8'))
  const expectedVersion = releaseBinding.releaseTag.replace(/^v/, '')
  if (
    record.releaseTag !== releaseBinding.releaseTag ||
    record.installedVersion !== expectedVersion ||
    record.installedCandidateCommit !== releaseBinding.candidateCommit ||
    record.installerAssetName !== `CaoGen-${expectedVersion}.dmg`
  ) {
    throw new Error('M1 result template does not match the fixed release binding')
  }
  record.testerId = 'replace-with-private-anonymized-id'
  record.installerPath = path.join(evidenceDir, record.installerAssetName)
  record.startedAt = 'replace-with-ISO-8601-start-time'
  record.finishedAt = 'replace-with-ISO-8601-finish-time'
  record.totalMinutes = 0
  record.result = 'not_run'
  record.steps = record.steps.map((step) => ({ ...step, completed: false, minutes: 0 }))
  record.readOnlyTask = {
    ...record.readOnlyTask,
    completed: false,
    responseUseful: false,
    mutationCount: 0,
    projectPathRedacted: true
  }
  const evidenceNames = {
    screen_recording: 'screen-recording.mov',
    system_architecture: 'system-architecture.txt',
    installed_app_identity: 'installed-app-identity.json',
    read_only_task: 'read-only-task.png'
  }
  record.evidenceFiles = record.evidenceFiles.map((item) => ({
    role: item.role,
    path: path.join(evidenceDir, evidenceNames[item.role])
  }))
  record.blockers = []
  record.roughEdges = []
  return record
}

function buildChecklist(evidenceDir, recordPath) {
  return `CaoGen M1 first-user drill - private host checklist

KEEP PRIVATE
- Do not commit, upload, or paste this directory into an Issue or Discussion.
- Never record or copy the tester's API Key, Provider URL, project path, or private repository URL.
- The tester must download the DMG through https://caogen.dev/ during the timed drill.
- Do not pre-download the DMG or create placeholder evidence on the tester's behalf.

EXPECTED RELEASE
- Tag: ${releaseBinding.releaseTag}
- Candidate commit: ${releaseBinding.candidateCommit}
- DMG SHA-256: ${releaseBinding.assetSha256}

EXPECTED PRIVATE FILES
- ${path.join(evidenceDir, 'CaoGen-0.1.7.dmg')}
- ${path.join(evidenceDir, 'screen-recording.mov')}
- ${path.join(evidenceDir, 'system-architecture.txt')}
- ${path.join(evidenceDir, 'installed-app-identity.json')}
- ${path.join(evidenceDir, 'read-only-task.png')}

AFTER THE DRILL
1. Fill every field in ${recordPath}.
2. For a completed pass, run:

npm run test:m1-first-user-onboarding:required -- --record "${recordPath}" --expected-release-tag ${releaseBinding.releaseTag} --expected-candidate-commit ${releaseBinding.candidateCommit} --expected-asset-sha256 ${releaseBinding.assetSha256}

3. For a failed or blocked observation, replace :required with the non-required command and add --observation:

npm run test:m1-first-user-onboarding -- --observation --record "${recordPath}" --expected-release-tag ${releaseBinding.releaseTag} --expected-candidate-commit ${releaseBinding.candidateCommit} --expected-asset-sha256 ${releaseBinding.assetSha256}
`
}

function writePrivateFile(filePath, contents) {
  writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  chmodSync(filePath, 0o600)
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}
