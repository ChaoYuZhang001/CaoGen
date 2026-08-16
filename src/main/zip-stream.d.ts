declare module 'zip-stream' {
  import { Transform } from 'node:stream'

  interface ZipStreamOptions {
    comment?: string
    forceLocalTime?: boolean
    forceZip64?: boolean
    store?: boolean
    zlib?: { level?: number }
  }

  interface ZipEntryOptions {
    name: string
    comment?: string
    date?: Date
    mode?: number
    store?: boolean
    type?: 'file' | 'directory' | 'symlink'
  }

  export default class ZipStream extends Transform {
    constructor(options?: ZipStreamOptions)
    entry(
      source: Buffer | string | NodeJS.ReadableStream,
      data: ZipEntryOptions,
      callback: (error?: Error | null) => void
    ): this
    finalize(): void
    getBytesWritten(): number
  }
}
