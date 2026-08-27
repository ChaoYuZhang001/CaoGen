#!/usr/bin/env node

const { existsSync } = require('node:fs')
const path = require('node:path')
const { dialog } = require('electron')

const mainEntry = requiredFile('CAOGEN_VIDEO_STUDIO_MAIN_ENTRY')
const importPath = requiredFile('CAOGEN_VIDEO_STUDIO_IMPORT_PATH')
const openDialog = dialog.showOpenDialog.bind(dialog)

dialog.showOpenDialog = async (...args) => {
  const options = args.at(-1)
  if (options && typeof options === 'object' && options.title === '导入视频工作室素材') {
    return { canceled: false, filePaths: [importPath] }
  }
  return openDialog(...args)
}

require(mainEntry)

function requiredFile(name) {
  const value = String(process.env[name] || '').trim()
  if (!value || !path.isAbsolute(value) || !existsSync(value)) {
    throw new Error(`${name} must name an existing absolute file`)
  }
  return value
}
