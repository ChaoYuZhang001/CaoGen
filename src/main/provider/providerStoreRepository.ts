import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { Provider } from '../../shared/types'
import {
  ProviderProfileOperationJournal,
  ProviderProfileOperationJournalError
} from './providerProfileOperationJournal'
import {
  ProviderStoreMutationLockError,
  withProviderStoreMutationLock
} from './providerStoreMutationLock'

const MAX_PROVIDER_STORE_BYTES = 16 * 1024 * 1024

export interface ProviderStoreMutationOptions {
  operationId?: string
  expectedDiskDigest?: string
  expectedWriteDigest?: string
}

interface ProviderStoreRepositoryDependencies {
  serialize(providers: Provider[]): Provider[]
  migrate(providers: Provider[]): { providers: Provider[]; changed: boolean }
  sanitize(providers: Provider[]): Provider[]
}

export class ProviderStoreMutationBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderStoreMutationBlockedError'
  }
}

export class ProviderStoreRepository {
  private cache: Provider[] | null = null
  private mutationDepth = 0
  private readonly mutationOptions: ProviderStoreMutationOptions[] = []

  constructor(
    private readonly userDataDirectory: () => string,
    private readonly dependencies: ProviderStoreRepositoryDependencies
  ) {}

  readDigestStrict(): string {
    const root = this.userDataDirectory()
    return withProviderStoreMutationLock(root, () => this.readDigestStrictUnlocked())
  }

  load(): Provider[] {
    if (this.cache) return this.cache
    const file = this.providersFile()
    const info = fileInfo(file)
    const firstRun = !info
    if (info && (info.isSymbolicLink() || !info.isFile())) {
      throw new Error('Provider Store 必须是常规文件')
    }
    if (!firstRun && process.platform !== 'win32') chmodSync(file, 0o600)
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      this.cache = Array.isArray(raw) ? raw as Provider[] : []
    } catch {
      this.cache = []
    }
    this.migrateLoadedCache()
    return this.cache
  }

  mutate<T>(action: string, options: ProviderStoreMutationOptions, mutation: () => T): T {
    const root = this.userDataDirectory()
    return withProviderStoreMutationLock(root, () => {
      this.mutationDepth += 1
      this.mutationOptions.push(options)
      try {
        this.assertMutationAllowed(root, action, options)
        return mutation()
      } finally {
        this.mutationOptions.pop()
        this.mutationDepth -= 1
      }
    })
  }

  persist(): void {
    if (this.mutationDepth <= 0) throw new Error('Provider Store 写入必须持有 mutation lock')
    const serialized = this.dependencies.serialize(this.cache ?? [])
    const expectedWriteDigest = this.mutationOptions.at(-1)?.expectedWriteDigest
    if (expectedWriteDigest !== undefined && digestProviderStoreValue(serialized) !== expectedWriteDigest) {
      throw new ProviderStoreMutationBlockedError('Provider Store 写入结果与 operation journal 不一致')
    }
    writeProviderStoreAtomic(this.providersFile(), serialized)
  }

  replace(providers: Provider[] | null): void {
    this.cache = providers
  }

  reload(): Provider[] {
    this.cache = null
    return this.load()
  }

  cached(): Provider[] | null {
    return this.cache
  }

  private providersFile(): string {
    return join(this.userDataDirectory(), 'providers.json')
  }

  private readDigestStrictUnlocked(): string {
    const file = this.providersFile()
    const info = fileInfo(file)
    if (!info) return digestProviderStoreValue([])
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Provider Store 必须是常规文件')
    if (info.size > MAX_PROVIDER_STORE_BYTES) throw new Error('Provider Store 文件过大')
    let descriptor: number | undefined
    let value: unknown
    try {
      const defensiveFlags = process.platform === 'win32'
        ? 0
        : constants.O_NOFOLLOW | constants.O_NONBLOCK
      descriptor = openSync(file, constants.O_RDONLY | defensiveFlags)
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size > MAX_PROVIDER_STORE_BYTES) {
        throw new Error('Provider Store 文件无效')
      }
      value = JSON.parse(readBoundedUtf8(descriptor, MAX_PROVIDER_STORE_BYTES)) as unknown
    } catch (error) {
      if (error instanceof ProviderStoreMutationBlockedError) throw error
      throw new Error('Provider Store JSON 损坏')
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
    if (!Array.isArray(value)) throw new Error('Provider Store 格式无效')
    return digestProviderStoreValue(value)
  }

  private assertMutationAllowed(
    root: string,
    action: string,
    options: ProviderStoreMutationOptions
  ): void {
    const diskDigest = this.readDigestStrictUnlocked()
    new ProviderProfileOperationJournal(root).assertStoreMutationAllowed(
      diskDigest,
      options.operationId,
      options.expectedWriteDigest
    )
    if (options.expectedDiskDigest !== undefined) {
      if (diskDigest !== options.expectedDiskDigest) {
        throw new ProviderStoreMutationBlockedError(`${action}被阻止:Provider Store 已被其他进程修改`)
      }
      return
    }
    if (this.cache !== null
      && digestProviderStoreValue(this.dependencies.serialize(this.cache)) !== diskDigest) {
      throw new ProviderStoreMutationBlockedError(`${action}被阻止:内存与磁盘 Provider Store 不一致`)
    }
  }

  private migrateLoadedCache(): void {
    if (!this.cache || this.cache.length === 0) return
    const loadedProviders = this.cache
    const loadedDigest = digestProviderStoreValue(loadedProviders)
    try {
      this.mutate('迁移 Provider 凭据', { expectedDiskDigest: loadedDigest }, () => {
        const migration = this.dependencies.migrate(loadedProviders)
        this.cache = migration.providers
        if (migration.changed) this.persist()
      })
    } catch (error) {
      this.cache = this.dependencies.sanitize(loadedProviders)
      if (isMutationBoundaryError(error)) throw error
      console.error('[agent-desk] Provider 凭据迁移写回失败:', error)
    }
  }
}

export function digestProviderStoreValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isMutationBoundaryError(error: unknown): boolean {
  return error instanceof ProviderStoreMutationBlockedError
    || error instanceof ProviderStoreMutationLockError
    || error instanceof ProviderProfileOperationJournalError
}

function fileInfo(file: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(file)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

function readBoundedUtf8(descriptor: number, maxBytes: number): string {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    total += bytesRead
  }
  if (total > maxBytes) throw new Error('Provider Store 文件过大')
  return Buffer.concat(chunks, total).toString('utf8')
}

function writeProviderStoreAtomic(file: string, providers: Provider[]): void {
  const directory = dirname(file)
  const temporary = join(directory, `.providers.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    mkdirSync(directory, { recursive: true })
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(providers, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
    tightenProviderFileMode(file)
    fsyncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* best effort */ }
    }
    throw error
  }
}

function tightenProviderFileMode(file: string): void {
  if (process.platform === 'win32') return
  try {
    chmodSync(file, 0o600)
  } catch (error) {
    console.error('[agent-desk] Provider 文件权限复核失败:', error)
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  try {
    const descriptor = openSync(directory, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch {
    // The file is already fsynced; some filesystems reject directory fsync.
  }
}
