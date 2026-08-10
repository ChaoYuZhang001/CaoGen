import { FileText, X } from 'lucide-react'
import type { DocumentAttachmentView } from '../../../shared/types'
import { useT } from '../i18n'

interface DocumentAttachmentTrayProps {
  attachments: readonly DocumentAttachmentView[]
  disabled?: boolean
  onRemove(id: string): void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const value = bytes / 1024
  return value >= 1024 ? `${(value / 1024).toFixed(1)} MB` : `${value.toFixed(value >= 10 ? 0 : 1)} KB`
}

export default function DocumentAttachmentTray({
  attachments,
  disabled = false,
  onRemove
}: DocumentAttachmentTrayProps): React.JSX.Element | null {
  const t = useT()
  if (attachments.length === 0) return null
  return (
    <div className="document-attachment-tray" aria-label={t('documentAttachments')}>
      {attachments.map((attachment) => (
        <div key={attachment.id} className="document-attachment-item">
          <span className="document-attachment-icon" aria-hidden="true">
            <FileText size={18} strokeWidth={1.8} />
          </span>
          <span className="document-attachment-details">
            <span className="document-attachment-name" title={attachment.name}>{attachment.name}</span>
            <span className="document-attachment-meta">
              {formatBytes(attachment.bytes)}
              {attachment.dataClass === 'S3' && (
                <span className="document-attachment-sensitive" title={t('sensitiveAttachmentBlocked')}>S3</span>
              )}
            </span>
          </span>
          <button
            type="button"
            className="document-attachment-remove"
            onClick={() => onRemove(attachment.id)}
            disabled={disabled}
            aria-label={t('removeAttachment', { name: attachment.name })}
            title={t('removeAttachment', { name: attachment.name })}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}
