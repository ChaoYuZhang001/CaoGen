#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  derivePublicStatus,
  publicStatusParagraph
} from './lib/public-status-projection.mjs'

const repoRoot = process.cwd()
const status = derivePublicStatus({
  productRequirements: readFileSync(path.join(repoRoot, 'docs', 'PRODUCT-REQUIREMENTS.md'), 'utf8'),
  statusDocument: readFileSync(path.join(repoRoot, 'STATUS.md'), 'utf8')
})

const replaceGeneratedBlock = (relativePath, content) => {
  const absolutePath = path.join(repoRoot, relativePath)
  const text = readFileSync(absolutePath, 'utf8')
  const pattern = /<!-- caogen-public-status:start -->[\s\S]*?<!-- caogen-public-status:end -->/
  if (!pattern.test(text)) throw new Error(`${relativePath} is missing the public status markers`)
  const nextText = text.replace(
    pattern,
    `<!-- caogen-public-status:start -->\n${content}\n<!-- caogen-public-status:end -->`
  )
  writeFileSync(absolutePath, nextText, 'utf8')
}

writeFileSync(
  path.join(repoRoot, 'docs', 'public-status.json'),
  `${JSON.stringify(status, null, 2)}\n`,
  'utf8'
)
replaceGeneratedBlock('README.md', publicStatusParagraph(status, 'zh-CN'))
replaceGeneratedBlock('README.en.md', publicStatusParagraph(status, 'en'))

console.log(`public status updated: ${status.p0.verified} verified, ${status.p0.open} open`)
