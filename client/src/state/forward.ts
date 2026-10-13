// Forwarding a channel message: to a channel on the same server (the server copies it), or to a DM (re-encrypted
// like any DM, with the files as links). A DM never names a channel the recipient can't read.
import { roleRank, type Channel, type Member, type Message } from '../core/protocol'
import type { DmForward } from '../core/dm'
import { connectionFor, type ServerState } from './store'
import { sendDm } from './dms'
import { t } from '../i18n'

export async function forwardToChannel(serverKey: string, message: Message, channelId: number): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error(t('errors.codes.disconnected'))
  await connection.request('chat.forward', { id: message.id, channelId })
}

/** Where the message came from, as the DM's recipient may see it. */
export function forwardLabel(server: ServerState, source: Channel | undefined, peer: Member | undefined): string | null {
  if (!source || !peer || roleRank(peer.role) < roleRank(source.readRole)) return null
  return t('chat.forward.from', { channel: source.name, server: server.name })
}

export function dmForward(server: ServerState, message: Message, peerKey: string): { text: string; forward: DmForward } {
  const base = server.publicUrl ?? server.directUrl
  const source = server.channels.find((c) => c.id === message.channelId)
  const files = message.attachments.map((f) => ({ name: f.name, url: base + f.url, size: f.size, type: f.type }))
  // Mentions read as names: the recipient may not know these people.
  const text = message.text.replace(/<@([A-Za-z0-9_-]{43})>/g, (_, k: string) => `@${server.members[k]?.name ?? t('chat.composer.someone')}`)
  return {
    text: text || files.map((f) => f.name).join(', ') || t('chat.forward.fallback'),
    forward: { from: forwardLabel(server, source, server.members[peerKey]), files },
  }
}

export async function forwardToDm(server: ServerState, message: Message, peerKey: string): Promise<void> {
  const { text, forward } = dmForward(server, message, peerKey)
  await sendDm(peerKey, text.slice(0, 4000), { forward })
}
