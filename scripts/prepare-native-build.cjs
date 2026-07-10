/**
 * Electron 40 ships V8 headers that require C++20. tree-sitter 0.21.x still
 * pins its native binding to C++17, so cross-arch electron-builder rebuilds can
 * fail unless the local install is adjusted before packaging.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const electronPackagePath = path.join(root, 'node_modules', 'electron', 'package.json')
const treeSitterGypPath = path.join(root, 'node_modules', 'tree-sitter', 'binding.gyp')

if (!fs.existsSync(electronPackagePath)) {
  console.log('prepare-native-build: electron package not installed, skipping native build patch')
  process.exit(0)
}

const electronVersion = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8')).version || '0.0.0'
const electronMajor = Number(String(electronVersion).split('.')[0])
if (!Number.isFinite(electronMajor) || electronMajor < 40) {
  console.log(`prepare-native-build: Electron ${electronVersion} does not require tree-sitter C++20 patch`)
  process.exit(0)
}

if (!fs.existsSync(treeSitterGypPath)) {
  console.log('prepare-native-build: tree-sitter binding.gyp not found, skipping native build patch')
  process.exit(0)
}

const before = fs.readFileSync(treeSitterGypPath, 'utf8')
const after = before
  .replaceAll('-std=c++17', '-std=c++20')
  .replaceAll('c++17', 'c++20')
  .replaceAll('/std:c++17', '/std:c++20')

if (after === before) {
  if (before.includes('c++20') || before.includes('/std:c++20')) {
    console.log(`prepare-native-build: tree-sitter already uses C++20 for Electron ${electronVersion}`)
    process.exit(0)
  }
  throw new Error('prepare-native-build: tree-sitter binding.gyp did not contain a recognized C++ standard marker')
}

fs.writeFileSync(treeSitterGypPath, after, 'utf8')
console.log(`prepare-native-build: patched tree-sitter native binding for Electron ${electronVersion} C++20 rebuilds`)
