export interface UserMessageAttachmentView {
  id: string
  /** Content address for durable restart recovery. Legacy transcript entries omit it and fail closed. */
  hash?: string
  mime: string
  bytes: number
}
