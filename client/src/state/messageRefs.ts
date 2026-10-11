// Pointing at a message from elsewhere (saved messages, reminders, the inbox): building a ref and a snapshot from a
// message on screen, and opening the message again later.
import { t } from '../i18n'
import type { Message } from '../core/protocol'
import { plainText } from '../ui/markdown'
import { useApp, type ServerState } from './store'
import { conversationLabel } from './threads'
import { jumpToMessage, flash } from './jump'
import { nameOf, openConversation, sharedServers, useDms, type Dm } from './dms'
import { knownName, openGroup, titleOf, useGroups } from './groups'
import type { GroupMsg } from './groupLogic'
import { shorten, type MessageRef, type MessageSnap } from './productivityLogic'

export function channelTarget(server: ServerState, message: Message): { ref: MessageRef; snap: MessageSnap } {
  const authorName = message.webhook?.name ?? server.members[message.author]?.name ?? t('common.someone')
  const text = plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null })
  return {
    ref: { kind: 'channel', server: server.key, channelId: message.channelId, messageId: message.id },
    snap: {
      author: message.author, authorName, at: message.createdAt,
      preview: shorten(text || (message.attachments.length ? t('chat.message.attachment') : '')),
      where: `${conversationLabel(server, message.channelId)} · ${server.name}`,
    },
  }
}

export function dmTarget(peer: string, dm: Dm): { ref: MessageRef; snap: MessageSnap } {
  return {
    ref: { kind: 'dm', peer, from: dm.from, id: dm.id },
    snap: {
      author: dm.from, authorName: nameOf(dm.from), at: dm.sentAt,
      preview: shorten(plainText(dm.text, { nameOf: (k) => nameOf(k) }) || (dm.files?.length ? t('chat.message.attachment') : '')),
      where: nameOf(peer),
    },
  }
}

export function groupTarget(key: string, m: GroupMsg): { ref: MessageRef; snap: MessageSnap } {
  const g = useGroups.getState().groups[key]
  return {
    ref: { kind: 'group', group: key, from: m.from, id: m.id },
    snap: {
      author: m.from, authorName: knownName(m.from), at: m.sentAt,
      preview: shorten(plainText(m.text, { nameOf: (k) => knownName(k) }) || (m.files?.length ? t('chat.message.attachment') : '')),
      where: g ? titleOf(g) : t('groups.notify.aGroup'),
    },
  }
}

/** The element id of a DM or group message row (see Home.tsx and groups/Groups.tsx). */
export const privateRowId = (from: string, id: string) => `pm-${from}-${id}`

/** Waits (a little) for a row to render, then scrolls to it and highlights it. */
async function scrollToRow(id: string): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const element = document.getElementById(id)
    if (element) {
      element.scrollIntoView({ block: 'center' })
      flash(element)
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

/** Opens where a message is and scrolls to it. False if it can't be shown (deleted, or not on this device). */
export async function openRef(ref: MessageRef): Promise<boolean> {
  if (ref.kind === 'channel') {
    if (!useApp.getState().servers[ref.server]) return false
    return jumpToMessage(ref.server, ref.channelId, ref.messageId)
  }
  if (ref.kind === 'dm') {
    openConversation(ref.peer)
    const known = useDms.getState().conversations[ref.peer]?.messages.some((m) => m.id === ref.id && m.from === ref.from)
    return known ? scrollToRow(privateRowId(ref.from, ref.id)) : false
  }
  if (!useGroups.getState().groups[ref.group]) return false
  openGroup(ref.group)
  const known = useGroups.getState().groups[ref.group]?.messages.some((m) => m.id === ref.id && m.from === ref.from)
  return known ? scrollToRow(privateRowId(ref.from, ref.id)) : false
}

/** The server a reminder about this message is kept on: its own, or for a DM one you share with the person. */
export function serverFor(ref: MessageRef): string | null {
  const { servers, order } = useApp.getState()
  const online = (key: string) => servers[key]?.status.state === 'online'
  if (ref.kind === 'channel') return online(ref.server) ? ref.server : null
  if (ref.kind === 'group') {
    const server = ref.group.split('/')[0]
    return online(server) ? server : null
  }
  return sharedServers(ref.peer)[0] ?? order.find(online) ?? null
}
