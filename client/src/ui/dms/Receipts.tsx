// Read receipts in DMs and group DMs (state/receipts.ts): the quiet "Seen" under your message, sending your own
// while you look at a conversation, and the switch in My settings → Privacy & data.
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { nameOf, useDms } from '../../state/dms'
import { useGroups, knownName } from '../../state/groups'
import { dmConv, groupConv, useRead } from '../../state/readState'
import {
  dmReceiptMessages, groupReceiptMessages, loadGroupReceipts, sendDmReceipt, sendGroupReceipt, setSendReceipts, useReceiptMarks, useSendsReceipts,
} from '../../state/receipts'
import { seenBy } from '../../state/receiptsLogic'
import { Avatar } from '../bits'
import { SwitchRow } from '../kit'
import './receipts.css'

const NOBODY: Record<string, string[]> = {}

/** Which of your messages in this DM the other person has seen: message id → [peer]. Empty while your receipts are off. */
export function useDmSeen(peer: string, me: string): Record<string, string[]> {
  const on = useSendsReceipts()
  const marks = useReceiptMarks(dmConv(peer))
  const messages = useDms((s) => s.conversations[peer]?.messages)
  if (!on || !messages || !marks[peer]) return NOBODY
  return seenBy(dmReceiptMessages(messages), me, marks, [peer])
}

/** The same for a group: message id → the members who have read up to it. */
export function useGroupSeen(groupKey: string, me: string): Record<string, string[]> {
  const on = useSendsReceipts()
  const marks = useReceiptMarks(groupConv(groupKey))
  const g = useGroups((s) => s.groups[groupKey])
  if (!on || !g?.view || Object.keys(marks).length === 0) return NOBODY
  return seenBy(groupReceiptMessages(g.messages), me, marks, g.view.members)
}

/** Sends your receipt for the DM you are looking at: when it opens, when something new arrives, when the window gets focus. */
export function useDmReceiptSender(peer: string, newest: string | undefined): void {
  const on = useSendsReceipts()
  const unread = useRead(dmConv(peer)).unread
  useEffect(() => {
    if (!on) return
    const send = () => void sendDmReceipt(peer)
    send()
    // Once more a moment later: the conversation counts as on screen only after the views around it have settled.
    const later = setTimeout(send, 500)
    window.addEventListener('focus', send)
    return () => {
      clearTimeout(later)
      window.removeEventListener('focus', send)
    }
  }, [on, peer, newest, unread])
}

export function useGroupReceiptSender(groupKey: string, newest: string | undefined, ready: boolean): void {
  const on = useSendsReceipts()
  const unread = useRead(groupConv(groupKey)).unread
  useEffect(() => {
    if (!on || !ready) return
    void loadGroupReceipts(groupKey)
    const send = () => void sendGroupReceipt(groupKey)
    send()
    const later = setTimeout(send, 500)
    window.addEventListener('focus', send)
    return () => {
      clearTimeout(later)
      window.removeEventListener('focus', send)
    }
  }, [on, groupKey, newest, unread, ready])
}

/** "Seen" under a message of yours; in a group, with the small pictures of who has read up to it. */
export function SeenLine({ readers, group }: { readers: string[] | undefined; group?: boolean }) {
  const { t } = useTranslation()
  if (!readers?.length) return null
  if (!group) return <div className="seen-line" data-testid="seen">{t('dms.receipts.seen')}</div>
  const names = readers.map((key) => knownName(key))
  return (
    <div className="seen-line" data-testid="seen" role="img" aria-label={t('dms.receipts.seenBy', { names: names.join(', ') })} title={t('dms.receipts.seenBy', { names: names.join(', ') })}>
      <span aria-hidden>{t('dms.receipts.seen')}</span>
      <span className="seen-avatars" aria-hidden>
        {readers.slice(0, 6).map((key) => <Avatar key={key} name={nameOf(key)} accountKey={key} size={16} />)}
        {readers.length > 6 && <span className="seen-more">+{readers.length - 6}</span>}
      </span>
    </div>
  )
}

/** My settings → Privacy & data. */
export function ReadReceiptSettings() {
  const { t } = useTranslation()
  const on = useSendsReceipts()
  return (
    <section className="settings-section" data-testid="read-receipt-settings">
      <h2>{t('dms.receipts.settingTitle')}</h2>
      <SwitchRow title={t('dms.receipts.settingLabel')} help={t('dms.receipts.settingHint')} checked={on} onChange={setSendReceipts} />
    </section>
  )
}
