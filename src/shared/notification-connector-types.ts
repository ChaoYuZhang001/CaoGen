export type NotificationConnectorChannel = 'feishu' | 'dingtalk' | 'wecom'

export interface NotificationConnectorInput {
  name?: string
  channel?: NotificationConnectorChannel
  webhookUrl: string
  secret?: string
  makeDefault?: boolean
}

export interface NotificationConnectorView {
  id: string
  name: string
  channel: NotificationConnectorChannel
  enabled: boolean
  isDefault: boolean
  available: boolean
  credentialStorage: 'encrypted' | 'session' | 'unavailable'
  webhookDigest: string
  revision: number
  createdAt: number
  updatedAt: number
}
