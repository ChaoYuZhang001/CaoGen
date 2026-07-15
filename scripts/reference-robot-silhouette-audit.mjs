#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const referencePath = path.join(
  repoRoot,
  'docs/visual-references/reference-robot-orthographic-sheet.png'
)
const previewDir = path.join(repoRoot, 'test-results/reference-robot-blender')
const reportPath = path.join(previewDir, 'silhouette-audit.json')
const normalizedSize = 256
const acceptance = {
  kind: 'regression-baseline',
  meanIouMinimum: 0.52,
  meanAspectErrorMaximum: 0.045,
  views: {
    front: { iouMinimum: 0.56, aspectErrorMaximum: 0.035 },
    side: { iouMinimum: 0.48, aspectErrorMaximum: 0.055 }
  }
}

const views = [
  {
    name: 'front',
    referenceCrop: { x: 80, y: 25, width: 240, height: 228 },
    modelCrop: { x: 100, y: 100, width: 600, height: 650 },
    modelPath: path.join(previewDir, 'head-front-current.png'),
    referenceThreshold: 180,
    modelThreshold: 92
  },
  {
    name: 'side',
    referenceCrop: { x: 380, y: 25, width: 250, height: 228 },
    modelCrop: { x: 100, y: 100, width: 600, height: 650 },
    modelPath: path.join(previewDir, 'head-side-current.png'),
    referenceThreshold: 180,
    modelThreshold: 92
  }
]

const reference = readPng(referencePath)
const results = views.map((view) => inspectView(reference, view))
const meanIou = average(results.map((result) => result.normalizedIou))
const meanAspectError = average(results.map((result) => result.aspectRatioError))
const failures = evaluateAcceptance(results, meanIou, meanAspectError, acceptance)
const comparisonPath = path.join(previewDir, 'reference-vs-model-p1.png')
writeVisualComparison(reference, views, results, comparisonPath)
const report = {
  generatedAt: new Date().toISOString(),
  status: failures.length === 0 ? 'pass' : 'fail',
  reference: path.relative(repoRoot, referencePath),
  normalizedSize,
  comparison: path.relative(repoRoot, comparisonPath),
  acceptance,
  failures,
  meanIou,
  meanAspectError,
  views: results
}

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
for (const result of results) {
  console.log(
    `${result.name}: iou=${result.normalizedIou.toFixed(4)}, ` +
      `referenceAspect=${result.referenceAspectRatio.toFixed(4)}, ` +
      `modelAspect=${result.modelAspectRatio.toFixed(4)}, ` +
      `aspectError=${result.aspectRatioError.toFixed(4)}`
  )
}
console.log(`mean: iou=${meanIou.toFixed(4)}, aspectError=${meanAspectError.toFixed(4)}`)
console.log(`visual comparison: ${comparisonPath}`)
console.log(`silhouette report: ${reportPath}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`silhouette regression: ${failure}`)
  process.exitCode = 1
} else {
  console.log('reference robot silhouette regression baseline ok')
}

function evaluateAcceptance(results, meanIou, meanAspectError, contract) {
  const failures = []
  if (meanIou < contract.meanIouMinimum) {
    failures.push(
      `mean IoU ${meanIou.toFixed(4)} is below ${contract.meanIouMinimum.toFixed(4)}`
    )
  }
  if (meanAspectError > contract.meanAspectErrorMaximum) {
    failures.push(
      `mean aspect error ${meanAspectError.toFixed(4)} exceeds ` +
        contract.meanAspectErrorMaximum.toFixed(4)
    )
  }
  for (const result of results) {
    const viewContract = contract.views[result.name]
    if (!viewContract) {
      failures.push(`missing acceptance contract for ${result.name}`)
      continue
    }
    if (result.normalizedIou < viewContract.iouMinimum) {
      failures.push(
        `${result.name} IoU ${result.normalizedIou.toFixed(4)} is below ` +
          viewContract.iouMinimum.toFixed(4)
      )
    }
    if (result.aspectRatioError > viewContract.aspectErrorMaximum) {
      failures.push(
        `${result.name} aspect error ${result.aspectRatioError.toFixed(4)} exceeds ` +
          viewContract.aspectErrorMaximum.toFixed(4)
      )
    }
  }
  return failures
}

function inspectView(referenceImage, view) {
  const modelImage = readPng(view.modelPath)
  const referenceMask = createMask(referenceImage, view.referenceCrop, view.referenceThreshold)
  const modelMask = createMask(
    modelImage,
    view.modelCrop,
    view.modelThreshold
  )
  const referenceBounds = findBounds(referenceMask)
  const modelBounds = findBounds(modelMask)
  const normalizedReference = normalizeMask(referenceMask, referenceBounds, normalizedSize)
  const normalizedModel = normalizeMask(modelMask, modelBounds, normalizedSize)
  const overlayPath = path.join(previewDir, `silhouette-${view.name}-overlay.png`)
  writeOverlay(normalizedReference, normalizedModel, normalizedSize, overlayPath)
  const referenceAspectRatio = referenceBounds.width / referenceBounds.height
  const modelAspectRatio = modelBounds.width / modelBounds.height
  return {
    name: view.name,
    model: path.relative(repoRoot, view.modelPath),
    overlay: path.relative(repoRoot, overlayPath),
    referenceBounds,
    modelBounds,
    referenceAspectRatio,
    modelAspectRatio,
    aspectRatioError: Math.abs(modelAspectRatio - referenceAspectRatio) / referenceAspectRatio,
    normalizedIou: intersectionOverUnion(normalizedReference, normalizedModel)
  }
}

function writeOverlay(referenceMask, modelMask, size, outputPath) {
  const image = new PNG({ width: size, height: size })
  for (let index = 0; index < referenceMask.length; index += 1) {
    const referencePixel = referenceMask[index] === 1
    const modelPixel = modelMask[index] === 1
    const outputIndex = index * 4
    const color = referencePixel && modelPixel
      ? [236, 244, 247]
      : referencePixel
        ? [58, 201, 230]
        : modelPixel
          ? [231, 74, 142]
          : [28, 32, 37]
    image.data[outputIndex] = color[0]
    image.data[outputIndex + 1] = color[1]
    image.data[outputIndex + 2] = color[2]
    image.data[outputIndex + 3] = 255
  }
  writeFileSync(outputPath, PNG.sync.write(image))
}

function writeVisualComparison(referenceImage, viewContracts, viewResults, outputPath) {
  const panelWidth = 400
  const panelHeight = 500
  const image = new PNG({ width: panelWidth * viewContracts.length * 2, height: panelHeight })
  fillImage(image, [236, 239, 241, 255])
  let panelIndex = 0
  for (const [viewIndex, view] of viewContracts.entries()) {
    const result = viewResults[viewIndex]
    const referenceContent = absoluteBounds(view.referenceCrop, result.referenceBounds)
    const modelContent = absoluteBounds(view.modelCrop, result.modelBounds)
    drawContained(image, referenceImage, referenceContent, panelIndex * panelWidth, panelWidth, panelHeight)
    panelIndex += 1
    const modelImage = readPng(view.modelPath)
    drawContained(image, modelImage, modelContent, panelIndex * panelWidth, panelWidth, panelHeight)
    panelIndex += 1
  }
  writeFileSync(outputPath, PNG.sync.write(image))
}

function absoluteBounds(crop, bounds) {
  return {
    x: crop.x + bounds.x,
    y: crop.y + bounds.y,
    width: bounds.width,
    height: bounds.height
  }
}

function fillImage(image, color) {
  for (let index = 0; index < image.width * image.height; index += 1) {
    const outputIndex = index * 4
    image.data[outputIndex] = color[0]
    image.data[outputIndex + 1] = color[1]
    image.data[outputIndex + 2] = color[2]
    image.data[outputIndex + 3] = color[3]
  }
}

function drawContained(target, source, crop, panelX, panelWidth, panelHeight) {
  const padding = 18
  const scale = Math.min(
    (panelWidth - padding * 2) / crop.width,
    (panelHeight - padding * 2) / crop.height
  )
  const targetWidth = Math.floor(crop.width * scale)
  const targetHeight = Math.floor(crop.height * scale)
  const offsetX = panelX + Math.floor((panelWidth - targetWidth) / 2)
  const offsetY = Math.floor((panelHeight - targetHeight) / 2)
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(source.width - 1, crop.x + Math.floor(x / scale))
      const sourceY = Math.min(source.height - 1, crop.y + Math.floor(y / scale))
      const sourceIndex = (sourceY * source.width + sourceX) * 4
      const targetIndex = ((offsetY + y) * target.width + offsetX + x) * 4
      target.data[targetIndex] = source.data[sourceIndex]
      target.data[targetIndex + 1] = source.data[sourceIndex + 1]
      target.data[targetIndex + 2] = source.data[sourceIndex + 2]
      target.data[targetIndex + 3] = source.data[sourceIndex + 3]
    }
  }
}

function readPng(filePath) {
  try {
    return PNG.sync.read(readFileSync(filePath))
  } catch (error) {
    throw new Error(`cannot read PNG ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function createMask(image, crop, threshold) {
  const width = Math.min(crop.width, image.width - crop.x)
  const height = Math.min(crop.height, image.height - crop.y)
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = ((crop.y + y) * image.width + crop.x + x) * 4
      const red = image.data[sourceIndex]
      const green = image.data[sourceIndex + 1]
      const blue = image.data[sourceIndex + 2]
      const alpha = image.data[sourceIndex + 3]
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722
      pixels[y * width + x] = alpha > 0 && luminance < threshold ? 1 : 0
    }
  }
  return { width, height, pixels }
}

function findBounds(mask) {
  let minX = mask.width
  let minY = mask.height
  let maxX = -1
  let maxY = -1
  let area = 0
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.pixels[y * mask.width + x] === 0) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      area += 1
    }
  }
  if (area < 100 || maxX < minX || maxY < minY) {
    throw new Error(`silhouette mask contains only ${area} foreground pixels`)
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    area
  }
}

function normalizeMask(mask, bounds, size) {
  const output = new Uint8Array(size * size)
  const scale = Math.min((size - 8) / bounds.width, (size - 8) / bounds.height)
  const targetWidth = bounds.width * scale
  const targetHeight = bounds.height * scale
  const offsetX = (size - targetWidth) / 2
  const offsetY = (size - targetHeight) / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.floor(bounds.x + (x - offsetX) / scale)
      const sourceY = Math.floor(bounds.y + (y - offsetY) / scale)
      if (
        sourceX >= bounds.x &&
        sourceX < bounds.x + bounds.width &&
        sourceY >= bounds.y &&
        sourceY < bounds.y + bounds.height
      ) {
        output[y * size + x] = mask.pixels[sourceY * mask.width + sourceX]
      }
    }
  }
  return output
}

function intersectionOverUnion(left, right) {
  let intersection = 0
  let union = 0
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] || right[index]) union += 1
    if (left[index] && right[index]) intersection += 1
  }
  return union === 0 ? 0 : intersection / union
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
