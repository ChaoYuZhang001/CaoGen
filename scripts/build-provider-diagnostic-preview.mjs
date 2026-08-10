import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'electron-builder'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const output = process.argv[2]
if (!output) throw new Error('output directory is required')

const config = require(path.join(repoRoot, 'electron-builder.windows-preview.cjs'))
config.directories = { ...(config.directories ?? {}), output: path.resolve(repoRoot, output) }
config.win = { ...(config.win ?? {}), target: ['dir'] }
config.publish = null
await build({
  projectDir: repoRoot,
  config,
  win: ['dir'],
  x64: true
})
