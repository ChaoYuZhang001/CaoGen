import { createHash } from 'node:crypto'

export function ccSwitchSourceProviderId(appType: string, providerId: string): string {
  return createHash('sha256').update(`${appType}\0${providerId}`).digest('hex').slice(0, 24)
}
