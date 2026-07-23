const packageJson = require('./package.json')

const baseBuild = packageJson.build || {}
const baseMac = { ...(baseBuild.mac || {}) }
delete baseMac.identity

module.exports = {
  ...baseBuild,
  mac: {
    ...baseMac,
    target: ['dmg', 'zip'],
    forceCodeSigning: true,
    hardenedRuntime: true,
    notarize: true,
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
  }
}
