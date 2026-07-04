export interface ImageAttachment {
  id: string
  name: string
  bytes?: number
  sizeBytes?: number
  thumbnailUrl?: string
  previewUrl?: string
  imageUrl?: string
  mimeType?: string
}

export interface ImageAttachmentTrayProps {
  attachments: readonly ImageAttachment[]
  onRemove?: (id: string, attachment: ImageAttachment) => void
  disabled?: boolean
  className?: string
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const precision = value >= 10 || Number.isInteger(value) ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

function attachmentPreviewUrl(attachment: ImageAttachment): string | undefined {
  return attachment.thumbnailUrl ?? attachment.previewUrl ?? attachment.imageUrl
}

export default function ImageAttachmentTray({
  attachments,
  onRemove,
  disabled = false,
  className
}: ImageAttachmentTrayProps): React.JSX.Element | null {
  if (attachments.length === 0) return null

  const trayClassName = ['image-attachment-tray', className].filter(Boolean).join(' ')

  return (
    <div className={trayClassName} aria-label="Image attachments">
      {attachments.map((attachment) => {
        const previewUrl = attachmentPreviewUrl(attachment)
        const size = attachment.sizeBytes ?? attachment.bytes
        const removeLabel = `Remove ${attachment.name}`

        return (
          <div key={attachment.id} className="image-attachment-item">
            <div className="image-attachment-thumbnail">
              {previewUrl ? (
                <img
                  className="image-attachment-image"
                  src={previewUrl}
                  alt=""
                  draggable={false}
                  loading="lazy"
                />
              ) : (
                <span className="image-attachment-placeholder" aria-hidden="true">
                  IMG
                </span>
              )}
            </div>
            <div className="image-attachment-details">
              <div className="image-attachment-name" title={attachment.name}>
                {attachment.name}
              </div>
              <div className="image-attachment-size">{formatBytes(size)}</div>
            </div>
            {onRemove && (
              <button
                type="button"
                className="image-attachment-remove"
                onClick={() => onRemove(attachment.id, attachment)}
                disabled={disabled}
                aria-label={removeLabel}
                title={removeLabel}
              >
                x
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
