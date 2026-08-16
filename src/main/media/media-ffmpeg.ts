import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type {
  MediaAsset,
  MediaAssetBindingRole,
  MediaCompositionInput,
  MediaFfmpegInfo,
  VideoProduction,
  VideoShot
} from '../../shared/media-types'
import { getPersistedArtifactLifecycle } from '../task/artifact-lifecycle-api'
import { artifactBlobPath } from '../task/artifact-lifecycle-content'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'

const execFileAsync = promisify(execFile)
const MAX_MEDIA_ASSET_BYTES = 2 * 1024 * 1024 * 1024
const FFmpeg_PACKAGE_VERSION = '5.3.0'

export interface ImportedMediaFile {
  sourceFileName: string
  mediaType: string
  digest: string
  sizeBytes: number
  managedPath: string
}

export interface ComposedMediaFile extends ImportedMediaFile {
  durationMs: number
  width: number
  height: number
  ffmpeg: MediaFfmpegInfo & { commandDigest: string }
  inputArtifactIds: string[]
  segmentCount: number
  subtitleCueCount: number
  manifest: MediaCompositionManifest
}

export interface MediaCompositionManifest {
  schemaVersion: 1
  productionId: string
  productionRevision: number
  structureRevisionId: string
  shotIds: string[]
  width: number
  height: number
  fps: number
  durationMs: number
  subtitleMode: 'embedded' | 'burned_in' | 'none'
  subtitleCueCount: number
  shots: Array<{
    shotId: string
    durationMs: number
    promptDigest: string
    visualArtifactId?: string
    dialogueCues: Array<{
      cueId: string
      speaker: string
      text: string
      startMs: number
      endMs: number
      subtitleEnabled: boolean
      audioArtifactId?: string
    }>
  }>
  timeline: {
    backgroundAudioArtifactId?: string
    backgroundAudioVolume: number
    subtitleMode: 'embedded' | 'burned_in' | 'none'
  }
  inputs: Array<{
    artifactId: string
    assetId: string
    purpose: 'shot_video' | 'shot_keyframe' | 'dialogue_audio' | 'background_audio'
    shotId?: string
    cueId?: string
  }>
  ffmpeg: { version?: string; binaryDigest?: string; commandDigest: string; license: string }
}

interface ResolvedMediaAsset {
  asset: MediaAsset
  artifactId: string
  path: string
}

export async function importMediaFile(
  sourcePath: string,
  rootDir: string,
  projectId: string,
  mediaTypeHint?: string
): Promise<ImportedMediaFile> {
  const source = await requireStableMediaSource(sourcePath)
  const extension = normalizeMediaExtension(extname(source.canonicalPath))
  const managedRoot = mediaProjectRoot(rootDir, projectId)
  await mkdir(managedRoot, { recursive: true, mode: 0o700 })
  const temporaryPath = join(managedRoot, `.${randomUUID()}.tmp`)
  const hash = createHash('sha256')
  let sizeBytes = 0
  await new Promise<void>((fulfill, reject) => {
    const reader = createReadStream(source.canonicalPath)
    const writer = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
    reader.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      sizeBytes += bytes.byteLength
      if (sizeBytes > MAX_MEDIA_ASSET_BYTES) reader.destroy(new Error('Media asset exceeds the 2 GiB project quota'))
      else hash.update(bytes)
    })
    reader.on('error', reject)
    writer.on('error', reject)
    writer.on('finish', fulfill)
    reader.pipe(writer)
  }).catch(async (error) => {
    await rm(temporaryPath, { force: true })
    throw error
  })
  const temporaryHandle = await open(temporaryPath, 'r+')
  try { await temporaryHandle.sync() } finally { await temporaryHandle.close() }
  const after = await stat(source.canonicalPath, { bigint: true })
  if (source.size !== after.size || source.mtimeNs !== after.mtimeNs || source.ctimeNs !== after.ctimeNs) {
    await rm(temporaryPath, { force: true })
    throw new Error('Media source changed while it was imported')
  }
  const digest = `sha256:${hash.digest('hex')}`
  const finalPath = join(managedRoot, `${digest.slice('sha256:'.length)}${extension}`)
  try {
    await rename(temporaryPath, finalPath)
    await chmod(finalPath, 0o600)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    try { await stat(finalPath) } catch { throw error }
  }
  await syncDirectory(managedRoot)
  const finalState = await lstat(finalPath)
  if (!finalState.isFile() || finalState.isSymbolicLink() || finalState.size !== sizeBytes) {
    throw new Error('Managed media asset failed its stable-file check')
  }
  return {
    sourceFileName: basename(source.canonicalPath),
    mediaType: normalizeMediaType(mediaTypeHint, extension),
    digest,
    sizeBytes,
    managedPath: finalPath
  }
}

export async function composeProductionDraft(
  input: MediaCompositionInput,
  production: VideoProduction,
  rootDir: string
): Promise<ComposedMediaFile> {
  const ffmpeg = await inspectBundledFfmpeg()
  if (!ffmpeg.available) throw new Error('Bundled FFmpeg is unavailable; reinstall the Intel package before local composition')
  const width = boundedInteger(input.width, 320, 3_840, 1_280)
  const height = boundedInteger(input.height, 240, 2_160, 720)
  const fps = boundedInteger(input.fps, 12, 60, 24)
  const selected = orderedShots(production, input.shotIds)
  if (selected.length === 0) throw new Error('Media composition needs at least one Shot')
  const totalDurationMs = Math.min(selected.reduce((sum, shot) => sum + shot.durationMs, 0), 120_000)
  if (selected.reduce((sum, shot) => sum + shot.durationMs, 0) > totalDurationMs) {
    throw new Error('Media composition duration exceeds the 120 second local limit')
  }
  const subtitleMode = input.subtitleMode ?? production.timeline.subtitleMode
  const managedRoot = mediaProjectRoot(rootDir, production.projectId)
  await mkdir(managedRoot, { recursive: true, mode: 0o700 })
  const temporaryRoot = join(managedRoot, `.compose-${randomUUID()}`)
  await mkdir(temporaryRoot, { recursive: false, mode: 0o700 })
  const temporaryPath = join(temporaryRoot, 'final.mp4')
  const resolvedCache = new Map<string, Promise<ResolvedMediaAsset>>()
  const resolveAsset = (asset: MediaAsset): Promise<ResolvedMediaAsset> => {
    const existing = resolvedCache.get(asset.id)
    if (existing) return existing
    const pending = resolveRegisteredAsset(asset, production, rootDir)
    resolvedCache.set(asset.id, pending)
    return pending
  }
  const sourceInputs: MediaCompositionManifest['inputs'] = []
  const segmentPaths: string[] = []
  const cueTracks: Array<{ path: string; offsetMs: number; durationMs: number; artifactId: string; assetId: string; shotId: string; cueId: string }> = []
  const subtitleCues: Array<{ startMs: number; endMs: number; speaker: string; text: string }> = []
  const manifestShots: MediaCompositionManifest['shots'] = []
  let background: ResolvedMediaAsset | undefined
  let elapsedMs = 0
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const shot = selected[index]
      const visual = selectedShotVisual(production, shot)
      const resolvedVisual = visual ? await resolveAsset(visual.asset) : undefined
      const segmentPath = join(temporaryRoot, `segment-${String(index).padStart(2, '0')}.mp4`)
      await renderShotSegment(ffmpegPath(), segmentPath, shot, resolvedVisual, visual?.purpose, width, height, fps)
      segmentPaths.push(segmentPath)
      if (resolvedVisual && visual) {
        sourceInputs.push({
          artifactId: resolvedVisual.artifactId,
          assetId: resolvedVisual.asset.id,
          purpose: visual.purpose,
          shotId: shot.id
        })
      }
      const manifestCues: MediaCompositionManifest['shots'][number]['dialogueCues'] = []
      for (const cue of shot.dialogueCues) {
        if (cue.subtitleEnabled && subtitleMode !== 'none') {
          subtitleCues.push({
            startMs: elapsedMs + cue.startMs,
            endMs: elapsedMs + cue.endMs,
            speaker: cue.speaker,
            text: cue.text
          })
        }
        const cueAssetId = cue.audioAssetId ?? cue.voiceAssetId
        if (cueAssetId) {
          const asset = requiredProductionAsset(production, cueAssetId)
          const resolvedAudio = await resolveAsset(asset)
          cueTracks.push({
            path: resolvedAudio.path,
            offsetMs: elapsedMs + cue.startMs,
            durationMs: cue.endMs - cue.startMs,
            artifactId: resolvedAudio.artifactId,
            assetId: asset.id,
            shotId: shot.id,
            cueId: cue.id
          })
          sourceInputs.push({
            artifactId: resolvedAudio.artifactId,
            assetId: asset.id,
            purpose: 'dialogue_audio',
            shotId: shot.id,
            cueId: cue.id
          })
          manifestCues.push({
            cueId: cue.id,
            speaker: cue.speaker,
            text: cue.text,
            startMs: cue.startMs,
            endMs: cue.endMs,
            subtitleEnabled: cue.subtitleEnabled,
            audioArtifactId: resolvedAudio.artifactId
          })
        } else {
          manifestCues.push({
            cueId: cue.id,
            speaker: cue.speaker,
            text: cue.text,
            startMs: cue.startMs,
            endMs: cue.endMs,
            subtitleEnabled: cue.subtitleEnabled
          })
        }
      }
      manifestShots.push({
        shotId: shot.id,
        durationMs: shot.durationMs,
        promptDigest: `sha256:${createHash('sha256').update(shot.prompt).digest('hex')}`,
        ...(resolvedVisual ? { visualArtifactId: resolvedVisual.artifactId } : {}),
        dialogueCues: manifestCues
      })
      elapsedMs += shot.durationMs
    }
    if (production.timeline.backgroundAudioAssetId) {
      background = await resolveAsset(requiredProductionAsset(production, production.timeline.backgroundAudioAssetId))
      sourceInputs.push({ artifactId: background.artifactId, assetId: background.asset.id, purpose: 'background_audio' })
    }
    const concatList = join(temporaryRoot, 'segments.txt')
    await writeFile(concatList, segmentPaths.map((path) => `file '${concatFilePath(path)}'`).join('\n') + '\n', { mode: 0o600 })
    const joinedVideo = join(temporaryRoot, 'joined.mp4')
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y', '-fflags', '+genpts',
      '-f', 'concat', '-safe', '0', '-i', concatList,
      '-map', '0:v:0', '-an', '-c:v', 'copy', joinedVideo
    ], 180_000)
    const subtitlePath = subtitleCues.length > 0 ? join(temporaryRoot, 'subtitles.srt') : undefined
    if (subtitlePath) await writeFile(subtitlePath, encodeSrt(subtitleCues), { mode: 0o600 })
    await renderFinalComposition({
      binary: ffmpegPath(),
      outputPath: temporaryPath,
      videoPath: joinedVideo,
      title: `${production.title} - local draft`.slice(0, 120),
      durationMs: totalDurationMs,
      background,
      backgroundVolume: production.timeline.backgroundAudioVolume,
      cueTracks,
      subtitlePath,
      subtitleMode
    })
    const semanticCommand = {
      pipeline: 'caogen.media.ffmpeg.v2',
      binaryDigest: ffmpeg.binaryDigest,
      width,
      height,
      fps,
      durationMs: totalDurationMs,
      subtitleMode,
      shots: manifestShots,
      sourceInputs,
      backgroundVolume: background ? production.timeline.backgroundAudioVolume : 0
    }
    const commandDigest = createHash('sha256').update(JSON.stringify(semanticCommand)).digest('hex')
    const inputs = uniqueManifestInputs(sourceInputs)
    const manifest: MediaCompositionManifest = {
      schemaVersion: 1,
      productionId: production.id,
      productionRevision: production.revision,
      structureRevisionId: production.adoptedStructureRevisionId,
      shotIds: selected.map((shot) => shot.id),
      width,
      height,
      fps,
      durationMs: totalDurationMs,
      subtitleMode,
      subtitleCueCount: subtitleCues.length,
      shots: manifestShots,
      timeline: {
        ...(background ? { backgroundAudioArtifactId: background.artifactId } : {}),
        backgroundAudioVolume: background ? production.timeline.backgroundAudioVolume : 0,
        subtitleMode
      },
      inputs,
      ffmpeg: {
        version: ffmpeg.version,
        binaryDigest: ffmpeg.binaryDigest,
        commandDigest,
        license: ffmpeg.license
      }
    }
    const imported = await importMediaFile(temporaryPath, rootDir, production.projectId, 'video/mp4')
    return {
      ...imported,
      sourceFileName: `${safeFileStem(production.title)}-draft.mp4`,
      durationMs: totalDurationMs,
      width,
      height,
      ffmpeg: { ...ffmpeg, commandDigest },
      inputArtifactIds: [...new Set(inputs.map((item) => item.artifactId))],
      segmentCount: selected.length,
      subtitleCueCount: subtitleCues.length,
      manifest
    }
  } catch (error) {
    throw new Error(`FFmpeg local composition failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function inspectBundledFfmpeg(): Promise<MediaFfmpegInfo> {
  const binary = ffmpegPath()
  try {
    const state = await lstat(binary)
    if (!state.isFile() || state.isSymbolicLink()) throw new Error('not a regular file')
    const [versionResult, digest] = await Promise.all([
      execFileAsync(binary, ['-version'], {
        env: buildMinimalSubprocessEnv(),
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      }),
      streamDigest(binary)
    ])
    const firstLine = versionResult.stdout.split('\n')[0]?.trim()
    if (!firstLine?.startsWith('ffmpeg version')) throw new Error('version output is invalid')
    return {
      available: true,
      version: `${firstLine} (ffmpeg-static ${FFmpeg_PACKAGE_VERSION})`,
      source: 'ffmpeg-static',
      license: 'GPL-3.0-or-later',
      binaryDigest: digest
    }
  } catch {
    return { available: false, source: 'unavailable', license: 'unknown' }
  }
}

export async function purgeMediaProjectFiles(rootDir: string, projectId: string): Promise<number> {
  const root = mediaProjectRoot(rootDir, projectId)
  try {
    const state = await lstat(root)
    if (state.isSymbolicLink() || !state.isDirectory()) throw new Error('Managed media Project root is invalid')
    const count = await countManagedMediaFiles(root)
    await rm(root, { recursive: true, force: false })
    await syncDirectory(dirname(root))
    return count
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return 0
  }
}

export async function countMediaProjectFiles(rootDir: string, projectId: string): Promise<number> {
  const root = mediaProjectRoot(rootDir, projectId)
  try {
    const state = await lstat(root)
    if (state.isSymbolicLink() || !state.isDirectory()) throw new Error('Managed media Project root is invalid')
    return countManagedMediaFiles(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

export async function purgeLegacyMediaProviderOutputFiles(rootDir: string, sourceRefs: readonly string[]): Promise<number> {
  const legacyRoot = resolve(rootDir, 'media-provider-outputs')
  let count = 0
  for (const sourceRef of [...new Set(sourceRefs)].sort()) {
    if (!isAbsolute(sourceRef)) continue
    const target = resolve(sourceRef)
    const child = relative(legacyRoot, target)
    if (!/^[a-f0-9]{64}$/.test(child) || isAbsolute(child) || child.includes(sep)) continue
    try {
      const state = await lstat(target)
      if (!state.isFile() || state.isSymbolicLink()) throw new Error('Legacy media Provider output is invalid')
      await rm(target)
      await syncDirectory(legacyRoot)
      count += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    if ((await readdir(legacyRoot)).length === 0) {
      await rm(legacyRoot)
      await syncDirectory(dirname(legacyRoot))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return count
}

export function ffmpegPath(): string {
  const packaged = join(process.resourcesPath ?? '', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const development = resolve(process.cwd(), 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  return app.isPackaged ? packaged : development
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function resolveRegisteredAsset(asset: MediaAsset, production: VideoProduction, rootDir: string): Promise<ResolvedMediaAsset> {
  if (!asset.artifactId || !asset.digest || !asset.sizeBytes) throw new Error(`Media Asset is not backed by a complete Artifact: ${asset.id}`)
  const lifecycle = await getPersistedArtifactLifecycle(asset.artifactId, rootDir)
  if (!lifecycle || lifecycle.projectId !== production.projectId || lifecycle.kind !== 'custom' ||
      lifecycle.digest !== asset.digest || lifecycle.sizeBytes !== asset.sizeBytes) {
    throw new Error(`Media Asset Artifact ownership or integrity is invalid: ${asset.id}`)
  }
  const path = lifecycle.storageKind === 'source_ref'
    ? lifecycle.sourceRef
    : lifecycle.blobRef ? artifactBlobPath(rootDir, lifecycle.digest) : undefined
  if (!path) throw new Error(`Media Asset Artifact content is unavailable: ${asset.id}`)
  const state = await lstat(path)
  if (!state.isFile() || state.isSymbolicLink() || state.size !== lifecycle.sizeBytes) {
    throw new Error(`Media Asset Artifact file is invalid: ${asset.id}`)
  }
  return { asset, artifactId: lifecycle.artifactId, path }
}

function selectedShotVisual(
  production: VideoProduction,
  shot: VideoShot
): { asset: MediaAsset; purpose: 'shot_video' | 'shot_keyframe' } | undefined {
  const bindings = (shot.assetBindings ?? []).filter((binding) => binding.adopted)
  const resolveBinding = (roles: readonly MediaAssetBindingRole[], mediaPrefix: string) => bindings.find((binding) => {
    const asset = production.assets.find((candidate) => candidate.id === binding.assetId && candidate.version === binding.assetVersion)
    return asset?.mediaType?.startsWith(mediaPrefix) === true && (roles.length === 0 || roles.includes(binding.role))
  })
  const videoBinding = resolveBinding([], 'video/')
  if (videoBinding) return { asset: requiredProductionAsset(production, videoBinding.assetId), purpose: 'shot_video' }
  const keyframeBinding = resolveBinding(['keyframe', 'scene'], 'image/')
  if (keyframeBinding) return { asset: requiredProductionAsset(production, keyframeBinding.assetId), purpose: 'shot_keyframe' }
  return undefined
}

function requiredProductionAsset(production: VideoProduction, assetId: string): MediaAsset {
  const asset = production.assets.find((candidate) => candidate.id === assetId)
  if (!asset) throw new Error(`Media Asset is outside Production scope: ${assetId}`)
  return asset
}

async function renderShotSegment(
  binary: string,
  outputPath: string,
  shot: VideoShot,
  visual: ResolvedMediaAsset | undefined,
  purpose: 'shot_video' | 'shot_keyframe' | undefined,
  width: number,
  height: number,
  fps: number
): Promise<void> {
  const duration = seconds(shot.durationMs)
  const inputArgs = visual
    ? purpose === 'shot_keyframe'
      ? ['-loop', '1', '-i', visual.path]
      : ['-stream_loop', '-1', '-i', visual.path]
    : ['-f', 'lavfi', '-i', `color=c=0x202124:s=${width}x${height}:r=${fps}:d=${duration}`]
  const filter = [
    `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
    'setsar=1',
    'format=yuv420p',
    `trim=duration=${duration}`,
    'setpts=PTS-STARTPTS'
  ].join(',')
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y', ...inputArgs,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-t', duration,
    '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-video_track_timescale', '90000', outputPath
  ], 180_000, binary)
}

async function renderFinalComposition(input: {
  binary: string
  outputPath: string
  videoPath: string
  title: string
  durationMs: number
  background?: ResolvedMediaAsset
  backgroundVolume: number
  cueTracks: Array<{ path: string; offsetMs: number; durationMs: number }>
  subtitlePath?: string
  subtitleMode: 'embedded' | 'burned_in' | 'none'
}): Promise<void> {
  const duration = seconds(input.durationMs)
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input.videoPath]
  args.push('-f', 'lavfi', '-t', duration, '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  let nextInput = 2
  const audioLabels = ['base']
  const filters = [`[1:a]atrim=duration=${duration},asetpts=PTS-STARTPTS[base]`]
  if (input.background) {
    args.push('-stream_loop', '-1', '-i', input.background.path)
    filters.push(`[${nextInput}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${input.backgroundVolume.toFixed(4)}[background]`)
    audioLabels.push('background')
    nextInput += 1
  }
  input.cueTracks.forEach((cue, index) => {
    args.push('-i', cue.path)
    const label = `cue${index}`
    filters.push(`[${nextInput}:a]atrim=duration=${seconds(cue.durationMs)},asetpts=PTS-STARTPTS,adelay=${cue.offsetMs}|${cue.offsetMs}[${label}]`)
    audioLabels.push(label)
    nextInput += 1
  })
  const subtitleInput = input.subtitleMode === 'embedded' && input.subtitlePath ? nextInput : undefined
  if (subtitleInput !== undefined) args.push('-i', input.subtitlePath!)
  filters.push(`${audioLabels.map((label) => `[${label}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${duration}[aout]`)
  args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[aout]')
  if (input.subtitleMode === 'burned_in' && input.subtitlePath) {
    args.push('-vf', `subtitles='${subtitleFilterPath(input.subtitlePath)}'`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p')
  } else {
    args.push('-c:v', 'copy')
  }
  if (subtitleInput !== undefined) args.push('-map', `${subtitleInput}:s:0`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=und')
  args.push(
    '-metadata', `title=${input.title}`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', duration, '-movflags', '+faststart', input.outputPath
  )
  await runFfmpeg(args, 240_000, input.binary)
}

async function runFfmpeg(args: string[], timeout: number, binary = ffmpegPath()): Promise<void> {
  await execFileAsync(binary, args, {
    env: buildMinimalSubprocessEnv(),
    timeout,
    maxBuffer: 8 * 1024 * 1024
  })
}

function encodeSrt(cues: Array<{ startMs: number; endMs: number; speaker: string; text: string }>): string {
  return cues.map((cue, index) => {
    const speaker = cue.speaker.replace(/[\r\n]+/g, ' ').trim()
    const text = cue.text.replace(/\r\n?/g, '\n').trim()
    return `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${speaker}: ${text}\n`
  }).join('\n')
}

function srtTime(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const secondsValue = Math.floor((milliseconds % 60_000) / 1_000)
  const remainder = milliseconds % 1_000
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secondsValue, 2)},${pad(remainder, 3)}`
}

function pad(value: number, length: number): string { return String(value).padStart(length, '0') }
function seconds(milliseconds: number): string { return (milliseconds / 1_000).toFixed(3) }
function concatFilePath(path: string): string { return path.replaceAll("'", "'\\''") }
function subtitleFilterPath(path: string): string { return path.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'") }
function uniqueManifestInputs(inputs: MediaCompositionManifest['inputs']): MediaCompositionManifest['inputs'] {
  const seen = new Set<string>()
  return inputs.filter((input) => {
    const key = JSON.stringify(input)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function mediaProjectRoot(rootDir: string, projectId: string): string {
  const identity = createHash('sha256').update(projectId).digest('hex')
  return join(resolve(rootDir), 'media-files', identity)
}

async function countManagedMediaFiles(root: string): Promise<number> {
  let count = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const state = await lstat(path)
    if (state.isSymbolicLink()) throw new Error('Managed media Project tree contains a symbolic link')
    if (state.isFile()) count += 1
    else if (state.isDirectory()) count += await countManagedMediaFiles(path)
    else throw new Error('Managed media Project tree contains an unsupported entry')
  }
  return count
}

async function requireStableMediaSource(sourcePath: string) {
  const direct = resolve(sourcePath)
  const directState = await lstat(direct, { bigint: true })
  if (!directState.isFile() || directState.isSymbolicLink() || directState.size <= 0 || directState.size > MAX_MEDIA_ASSET_BYTES) {
    throw new Error('Media source must be a non-empty regular file up to 2 GiB')
  }
  const canonicalPath = await realpath(direct)
  const child = canonicalPath.slice(resolve(dirname(canonicalPath)).length)
  if (child.includes(`..${sep}`)) throw new Error('Media source path is invalid')
  return { canonicalPath, size: directState.size, mtimeNs: directState.mtimeNs, ctimeNs: directState.ctimeNs }
}

async function streamDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await open(path, 'r')
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
  } finally {
    await handle.close()
  }
  return `sha256:${hash.digest('hex')}`
}

function orderedShots(production: VideoProduction, requested?: string[]) {
  const allowed = requested ? new Set(requested) : undefined
  const byId = new Map(production.shots.map((shot) => [shot.id, shot]))
  return production.episodes.flatMap((episode) => episode.sceneIds)
    .flatMap((sceneId) => production.scenes.find((scene) => scene.id === sceneId)?.shotIds ?? [])
    .filter((shotId) => !allowed || allowed.has(shotId))
    .map((shotId) => byId.get(shotId)).filter((shot): shot is NonNullable<typeof shot> => Boolean(shot))
    .slice(0, 8)
}

function normalizeMediaExtension(value: string): string {
  const extension = value.toLowerCase()
  if (!/^\.(?:png|jpe?g|webp|gif|mp4|mov|m4v|webm|mp3|m4a|wav|aac|flac|srt|vtt)$/.test(extension)) {
    throw new Error('Media asset file type is not supported')
  }
  return extension
}

function normalizeMediaType(value: string | undefined, extension: string): string {
  if (value && /^(?:image|video|audio|text)\/[a-z0-9.+-]+$/i.test(value)) return value.toLowerCase()
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac', '.flac': 'audio/flac',
    '.srt': 'text/plain', '.vtt': 'text/vtt'
  } as Record<string, string>)[extension] ?? 'application/octet-stream'
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Media composition dimension is invalid')
  return value
}

function safeFileStem(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'caogen-video'
}
