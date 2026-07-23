const packageJson = require('./package.json')
const { createReleaseProvenance } = require('./scripts/lib/release-provenance.cjs')

const baseBuild = packageJson.build || {}
const baseMac = { ...(baseBuild.mac || {}) }
const baseWin = { ...(baseBuild.win || {}) }
const releaseProvenance = createReleaseProvenance(__dirname, packageJson.version)
delete baseMac.identity

module.exports = {
  ...baseBuild,
  extraMetadata: {
    ...(baseBuild.extraMetadata || {}),
    caogenReleaseProvenance: releaseProvenance
  },
  mac: {
    ...baseMac,
    target: ['dmg', 'zip'],
    forceCodeSigning: true,
    hardenedRuntime: true,
    notarize: true,
    sign: 'scripts/macos-sign-with-retry.cjs',
    minimumSystemVersion: '14.0',
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.inherit.plist',
    signIgnore: [
      'app\\.asar\\.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-(x64|arm64)/claude$'
    ],
    extendInfo: {
      ...(baseMac.extendInfo || {}),
      NSAppleEventsUsageDescription: 'CaoGen uses automation only for user-approved desktop actions.'
    }
  },
  win: {
    ...baseWin,
    target: ['nsis'],
    forceCodeSigning: true
  }
}
