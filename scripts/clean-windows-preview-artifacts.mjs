#!/usr/bin/env node
import { existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const distRoot = path.resolve(repoRoot, 'dist')
const staleMetadata = path.join(distRoot, 'latest.yml')

if (existsSync(staleMetadata)) {
  unlinkSync(staleMetadata)
  console.log('windows preview cleanup: removed stale dist/latest.yml')
} else {
  console.log('windows preview cleanup: no stable update metadata present')
}
