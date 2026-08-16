/**
 * Electron 40+ ships V8 headers that require C++20. tree-sitter 0.21.x still
 * pins its native binding to C++17, so cross-arch electron-builder rebuilds can
 * fail unless the local install is adjusted before packaging.
 */
const fs = require('node:fs')
const childProcess = require('node:child_process')
const path = require('node:path')

const root = path.join(__dirname, '..')
const electronPackagePath = path.join(root, 'node_modules', 'electron', 'package.json')
const treeSitterGypPath = path.join(root, 'node_modules', 'tree-sitter', 'binding.gyp')
const targetArch = readTargetArch(process.argv.slice(2))

if (!fs.existsSync(electronPackagePath)) {
  console.log('prepare-native-build: electron package not installed, skipping native build patch')
  process.exit(0)
}

if (process.platform === 'darwin' && targetArch) prepareDarwinNativeBinaries(targetArch)

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

function readTargetArch(args) {
  const index = args.indexOf('--arch')
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value !== 'x64' && value !== 'arm64') throw new Error(`prepare-native-build: unsupported target architecture ${value || '(missing)'}`)
  return value
}

function prepareDarwinNativeBinaries(arch) {
  const target = arch === 'x64' ? 'x86_64' : 'arm64'
  const cacheRoot = path.join(root, 'node_modules', '.cache', 'caogen-native-universal')
  const nativeFiles = [
    'node_modules/@nut-tree-fork/libnut-darwin/build/Release/libnut.node',
    'node_modules/@nut-tree-fork/node-mac-permissions/build/Release/permissions.node',
    'node_modules/fsevents/fsevents.node'
  ]
  for (const relativePath of nativeFiles) {
    const source = path.join(root, relativePath)
    if (!fs.existsSync(source)) continue
    const cache = path.join(cacheRoot, relativePath.replace(/^node_modules\//, ''))
    const currentArchitectures = architectures(source)
    if (currentArchitectures.includes('x86_64') && currentArchitectures.includes('arm64')) {
      fs.mkdirSync(path.dirname(cache), { recursive: true })
      fs.copyFileSync(source, cache)
    } else if (fs.existsSync(cache)) {
      fs.copyFileSync(cache, source)
    }
    const available = architectures(source)
    if (!available.includes(target)) {
      throw new Error(`prepare-native-build: ${relativePath} lacks ${target}; available=${available.join(',') || 'none'}`)
    }
    const temporary = `${source}.caogen-${target}-${process.pid}`
    childProcess.execFileSync('lipo', [source, '-thin', target, '-output', temporary])
    fs.renameSync(temporary, source)
    console.log(`prepare-native-build: prepared ${relativePath} for ${target}`)
  }
}

function architectures(filePath) {
  try {
    return childProcess.execFileSync('lipo', ['-archs', filePath], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean)
  } catch {
    return []
  }
}
