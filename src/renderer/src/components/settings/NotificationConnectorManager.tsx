import { useEffect, useState } from 'react'
import type { NotificationConnectorView } from '../../../../shared/types'
import { useT } from '../../i18n'

export default function NotificationConnectorManager(): React.JSX.Element {
  const t = useT()
  const [connectors, setConnectors] = useState<NotificationConnectorView[]>([])
  const [name, setName] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    setConnectors(await window.agentDesk.listNotificationConnectors())
  }

  useEffect(() => {
    void refresh().catch((reason) => setError(errorText(reason)))
  }, [])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.agentDesk.createNotificationConnector({
        name: name.trim() || undefined,
        webhookUrl: webhookUrl.trim(),
        secret: secret.trim() || undefined
      })
      setName('')
      setWebhookUrl('')
      setSecret('')
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.agentDesk.deleteNotificationConnector(id)
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const makeDefault = async (id: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.agentDesk.setDefaultNotificationConnector(id)
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="notification-connectors">
      <div className="settings-section-head">
        <h3 className="settings-h3">{t('notificationConnectorsTitle')}</h3>
      </div>

      <div className="notification-connector-form">
        <label className="field-label">
          {t('notificationConnectorName')}
          <input className="input input-block" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field-label notification-connector-wide">
          {t('notificationConnectorWebhook')}
          <input
            className="input input-block"
            type="password"
            autoComplete="off"
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
          />
        </label>
        <label className="field-label">
          {t('notificationConnectorSecret')}
          <input
            className="input input-block"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary notification-connector-add"
          disabled={busy || !webhookUrl.trim()}
          onClick={() => void create()}
        >
          {t('notificationConnectorAdd')}
        </button>
      </div>

      {error && <div className="settings-save-error" role="alert">{error}</div>}

      <div className="notification-connector-list">
        {connectors.length === 0 && <div className="settings-hint">{t('notificationConnectorEmpty')}</div>}
        {connectors.map((connector) => (
          <div className="notification-connector-row" key={connector.id}>
            <div className="notification-connector-main">
              <strong>{connector.name}</strong>
              <span>{channelLabel(connector.channel, t)}</span>
              <span className={`notification-connector-status ${connector.available ? 'ready' : 'unavailable'}`}>
                {connector.available ? t('notificationConnectorReady') : t('notificationConnectorUnavailable')}
              </span>
            </div>
            <div className="notification-connector-actions">
              {!connector.isDefault && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void makeDefault(connector.id)}>
                  {t('notificationConnectorMakeDefault')}
                </button>
              )}
              {connector.isDefault && <span className="notification-connector-default">{t('notificationConnectorDefault')}</span>}
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void remove(connector.id)}>
                {t('delete')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function channelLabel(channel: NotificationConnectorView['channel'], t: ReturnType<typeof useT>): string {
  return channel === 'feishu'
    ? t('notificationChannelFeishu')
    : channel === 'dingtalk'
      ? t('notificationChannelDingTalk')
      : t('notificationChannelWeCom')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
