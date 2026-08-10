#!/usr/bin/env node

const controlUrl = process.env.CAOGEN_LOCAL_COMPUTE_TEST_CONTROL_URL

if (process.argv[2] !== 'serve' || !controlUrl) process.exit(2)

fetch(controlUrl, { method: 'POST' })
  .then((response) => {
    if (!response.ok) throw new Error(`control endpoint returned ${response.status}`)
  })
  .then(() => process.exit(0))
  .catch(() => process.exit(1))
