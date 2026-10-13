// Voice bots and taking people out of voice: a moderator's "Disconnect", and what the app does when it happens to you.
import type { Events } from '../core/protocol'
import { t } from '../i18n'
import { connectionFor, onServerEvent } from './store'

/** Takes someone (a person or a bot) out of the voice channel they're in: needs "Move members", like on Discord. */
export async function disconnectFromVoice(serverKey: string, accountKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error(t('errors.codes.disconnected'))
  await connection.request('voice.disconnect', { accountKey })
}

onServerEvent((serverKey, type, body) => {
  if (type !== 'voice.disconnected') return
  // LiveKit removes us too; leaving here makes sure the app doesn't treat it as a drop to rejoin.
  const { channelId } = body as Events['voice.disconnected']
  void import('./voice').then(({ leaveVoice, useVoice }) => {
    const session = useVoice.getState().session
    if (session?.serverKey === serverKey && session.channelId === channelId && !session.call && !session.group) void leaveVoice()
  })
})
