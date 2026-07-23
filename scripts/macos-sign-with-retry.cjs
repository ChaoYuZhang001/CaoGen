const MAX_TIMESTAMP_ATTEMPTS = 5

module.exports = async function signMacWithTimestampRetry(options) {
  const { signAsync } = await import('@electron/osx-sign')
  return signWithTimestampRetry(options, signAsync)
}

async function signWithTimestampRetry(options, signAsync, runtime = {}) {
  const wait = runtime.wait || delay
  const write = runtime.write || ((message) => process.stderr.write(message))
  let lastError
  for (let attempt = 1; attempt <= MAX_TIMESTAMP_ATTEMPTS; attempt += 1) {
    try {
      return await signAsync(options)
    } catch (error) {
      lastError = error
      if (!isTimestampFailure(error) || attempt === MAX_TIMESTAMP_ATTEMPTS) throw error
      const delayMs = 5_000 * attempt
      write(
        `macOS signing timestamp attempt ${attempt}/${MAX_TIMESTAMP_ATTEMPTS} failed; retrying in ${delayMs / 1000}s\n`
      )
      await wait(delayMs)
    }
  }
  throw lastError
}

function isTimestampFailure(error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error)
  return /timestamp was expected but was not found|timestamp service|timestamp authority|errSecTimestamp/i.test(message)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports.isTimestampFailure = isTimestampFailure
module.exports.signWithTimestampRetry = signWithTimestampRetry
module.exports.MAX_TIMESTAMP_ATTEMPTS = MAX_TIMESTAMP_ATTEMPTS
