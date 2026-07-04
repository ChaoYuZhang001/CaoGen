#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const label = 'com.caogen.deep-test.hourly'
const uid = process.getuid?.()
const supportDir = path.join(homedir(), 'Library', 'Application Support', 'CaoGen', 'hourly-deep-test')
const logDir = path.join(repoRoot, 'test-results', 'caogen-deep', 'launchd')
const launchAgentsDir = path.join(homedir(), 'Library', 'LaunchAgents')
const wrapperPath = path.join(supportDir, 'run-hourly-deep-test.sh')
const plistPath = path.join(launchAgentsDir, `${label}.plist`)

mkdirSync(supportDir, { recursive: true })
mkdirSync(logDir, { recursive: true })
mkdirSync(launchAgentsDir, { recursive: true })

const wrapper = `#!/bin/zsh
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd ${shellQuote(repoRoot)}
node scripts/deep-test.mjs
`

writeFileSync(wrapperPath, wrapper)
chmodSync(wrapperPath, 0o755)

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(wrapperPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repoRoot)}</string>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logDir, 'stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logDir, 'stderr.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`

writeFileSync(plistPath, plist)

if (process.platform === 'darwin' && typeof uid === 'number') {
  const service = `gui/${uid}/${label}`
  spawnSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' })
  const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' })
  if (boot.status !== 0) {
    const error = boot.stderr.trim() || boot.stdout.trim() || `launchctl bootstrap exited ${boot.status}`
    throw new Error(error)
  }
  const kick = spawnSync('launchctl', ['kickstart', '-k', service], { encoding: 'utf8' })
  if (kick.status !== 0) {
    console.warn(kick.stderr.trim() || kick.stdout.trim() || `launchctl kickstart exited ${kick.status}`)
  }
  const listed = execFileSync('launchctl', ['print', service], { encoding: 'utf8' })
  console.log(`installed hourly CaoGen deep test: ${plistPath}`)
  console.log(`wrapper: ${wrapperPath}`)
  console.log(`reports: ${path.join(repoRoot, 'test-results', 'caogen-deep')}`)
  console.log(listed.split('\n').slice(0, 8).join('\n'))
} else {
  console.log(`created launchd files, but automatic load is only supported on macOS: ${plistPath}`)
}

function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
