const { mkdirSync, renameSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const DEEP_TEST_STATUS_PROTOCOL = 'caogen.deep-test.status/v1'
const DEEP_TEST_STATUSES = new Set(['pass', 'skip', 'blocked', 'fail'])

function reportDeepTestStatus(status, options = {}) {
  const statusPath = process.env.CAOGEN_DEEP_TEST_STATUS_FILE
  if (!statusPath) return false
  const expectedReporter = process.env.CAOGEN_DEEP_TEST_STATUS_REPORTER
  if (expectedReporter && path.resolve(process.argv[1] || '') !== path.resolve(expectedReporter)) return false
  if (!DEEP_TEST_STATUSES.has(status)) throw new Error(`Unsupported deep-test status: ${status}`)

  const reason = typeof options.reason === 'string' ? options.reason.trim() : ''
  if (status !== 'pass' && !reason) throw new Error(`Deep-test status ${status} requires a reason`)

  const payload = {
    protocol: DEEP_TEST_STATUS_PROTOCOL,
    status,
    ...(reason ? { reason } : {}),
    ...(options.details === undefined ? {} : { details: options.details })
  }
  const absolutePath = path.resolve(statusPath)
  const tempPath = `${absolutePath}.${process.pid}.tmp`
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tempPath, absolutePath)
  return true
}

module.exports = {
  DEEP_TEST_STATUS_PROTOCOL,
  DEEP_TEST_STATUSES,
  reportDeepTestStatus
}
