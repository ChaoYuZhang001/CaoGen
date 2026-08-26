import { Sparkles } from 'lucide-react'
import type { MediaProviderProfile, ProviderView } from '../../../../shared/types'

export const VERIFIED_OPENAI_VIDEO_MODELS = ['grok-imagine-video', 'grok-imagine-video-1.5'] as const

export function findDefaultVideoProvider(providers: ProviderView[]): { provider: ProviderView; model: string } | null {
  const provider = providers.find((item) => item.ready && item.models.some((model) => VERIFIED_OPENAI_VIDEO_MODELS.includes(model as typeof VERIFIED_OPENAI_VIDEO_MODELS[number])))
    ?? providers.find((item) => item.ready && item.engine === 'openai' && item.models.some((model) => /video/i.test(model)))
  if (!provider) return null
  const model = provider.models.find((item) => VERIFIED_OPENAI_VIDEO_MODELS.includes(item as typeof VERIFIED_OPENAI_VIDEO_MODELS[number]))
    ?? provider.models.find((item) => /video/i.test(item))
  return model ? { provider, model } : null
}

export function createDefaultVideoProvider(provider: ProviderView, model: string): Promise<MediaProviderProfile> {
  return window.agentDesk.upsertMediaProvider({
    displayName: `${provider.name} · 视频`,
    capabilities: ['video'],
    operations: ['video.text-to-video'],
    endpointClass: 'openai-video',
    providerId: provider.id,
    model,
    defaultFor: ['video'],
    requestTimeoutMs: 120_000,
    enabled: true
  })
}

export function VideoProviderQuickEnableButton({
  appProviders,
  busy,
  hasRemoteAdapter,
  onRun,
  onSaved
}: {
  appProviders: ProviderView[]
  busy: boolean
  hasRemoteAdapter: boolean
  onRun: (operation: () => Promise<unknown>) => Promise<void>
  onSaved: (id: string) => void
}): React.JSX.Element | null {
  const quickProvider = findDefaultVideoProvider(appProviders)
  if (hasRemoteAdapter || !quickProvider) return null
  const enable = (): void => void onRun(async () => {
    const saved = await createDefaultVideoProvider(quickProvider.provider, quickProvider.model)
    onSaved(saved.id)
  })
  return <button type="button" className="btn btn-primary btn-sm" onClick={enable} disabled={busy} data-video-enable-default-provider>
    <Sparkles size={13} aria-hidden="true" />启用 {quickProvider.model}
  </button>
}

export function hasRemoteVideoAdapter(providers: MediaProviderProfile[]): boolean {
  return providers.some((provider) => provider.id !== 'media-provider:mock-local' && provider.enabled && provider.operations.includes('video.text-to-video'))
}
