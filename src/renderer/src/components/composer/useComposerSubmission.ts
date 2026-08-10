import { useState } from 'react'
import type {
  DocumentAttachmentView,
  ImageAttachmentView,
  SendMessagePayload
} from '../../../../shared/types'
import type { CommandDescriptor } from '../../commands'

type SubmissionAttachment = ImageAttachmentView & { name: string; previewUrl?: string }

interface ComposerSubmissionOptions {
  attachments: SubmissionAttachment[]
  documents: DocumentAttachmentView[]
  running: boolean
  uploadingAttachment: boolean
  text: string
  documentOnlyPrompt: string
  slashCommands: CommandDescriptor[]
  runSlashCommand(command: CommandDescriptor): void
  sendMessage(input: SendMessagePayload): Promise<void>
  onAccepted(): void
  onError(message: string): void
}

export function useComposerSubmission(options: ComposerSubmissionOptions) {
  const [sending, setSending] = useState(false)

  const submit = async (): Promise<void> => {
    if (options.running || sending) return
    const trimmed = options.text.trim()
    if (!trimmed && options.attachments.length === 0 && options.documents.length === 0) return
    const normalized = trimmed.toLowerCase()
    const slash = options.slashCommands.find((command) => command.title.toLowerCase() === normalized)
    if (slash && options.attachments.length === 0 && options.documents.length === 0) {
      options.runSlashCommand(slash)
      return
    }
    const images = options.attachments.map<ImageAttachmentView>(
      ({ name: _name, previewUrl: _previewUrl, ...image }) => image
    )
    setSending(true)
    options.onError('')
    try {
      await options.sendMessage({
        text: trimmed || (options.documents.length > 0 ? options.documentOnlyPrompt : ''),
        images,
        documents: options.documents
      })
      options.onAccepted()
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  return {
    attachmentsDisabled: options.uploadingAttachment || sending,
    sendDisabled: options.running || sending || options.uploadingAttachment ||
      (!options.text.trim() && options.attachments.length === 0 && options.documents.length === 0),
    submit
  }
}
