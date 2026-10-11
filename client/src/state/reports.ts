// Reports to a server's moderators: the report dialog (opened from message and person menus), the open-report
// badge for moderators, and the queue's requests. See "Reports" in PROTOCOL.md.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import type { Events, Member, Message, Permission, Report, ReportOutcome, ReportReason, ServerRole, SharedMessage } from '../core/protocol'
import { t } from '../i18n'
import { useDms } from './dms'
import { useGroups } from './groups'
import { has } from './permissions'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'

export const REPORT_REASONS: ReportReason[] = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm', 'illegal', 'other']
export const MAX_NOTE = 500
export const MAX_SHARED = 20
export const MAX_SHARED_TEXT = 2000

const MODERATION: Permission[] = ['manageMessages', 'timeoutMembers', 'kickMembers', 'banMembers']

/** Same rule as the server: anyone who can delete others' messages, time out, kick or ban. */
export const isModerator = (me: Member | null | undefined, roles: ServerRole[]) => MODERATION.some((p) => has(me, roles, p))

export type ReportTarget =
  | { kind: 'message'; serverKey: string; message: Message }
  /** A person: on a server you were looking at, or (serverKey null) from a DM or group, which may share messages. */
  | { kind: 'person'; accountKey: string; serverKey: string | null }

interface ReportsState {
  /** serverKey → open reports you can see there (0 unless you moderate). */
  open: Record<string, number>
  dialog: ReportTarget | null
}

export const useReports = create<ReportsState>(() => ({ open: {}, dialog: null }))

/** Any message but your own, your app's placeholders and AutoMod alerts. */
export const canReport = (server: { me: Member | null }, message: Message & { tempId?: string }) =>
  !!server.me && !message.tempId && message.author !== server.me.accountKey && !message.author.startsWith('automod:')

export const openReport = (target: ReportTarget) => useReports.setState({ dialog: target })
export const closeReport = () => useReports.setState({ dialog: null })

const setOpen = (serverKey: string, open: number) => useReports.setState((s) => ({ open: { ...s.open, [serverKey]: open } }))

onWelcomeHook((serverKey) => {
  connectionFor(serverKey)?.request('report.count', {}).then((r) => setOpen(serverKey, r.open), () => undefined)
})

onServerEvent((serverKey, type, body) => {
  if (type === 'report.count') setOpen(serverKey, (body as Events['report.count']).open)
})

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('safety.report.notConnected'))
  return c
}

export async function sendReport(serverKey: string, body: {
  reason: ReportReason; note?: string; messageId?: number; accountKey?: string; messages?: SharedMessage[]
}): Promise<{ id: number; already: boolean }> {
  const note = body.note?.trim()
  return connection(serverKey).request('report.create', { ...body, note: note || undefined })
}

export async function listReports(serverKey: string, status: 'open' | 'resolved', before?: number) {
  return connection(serverKey).request('report.list', { status, ...(before ? { before } : {}) })
}

export async function resolveReport(serverKey: string, id: number, outcome: ReportOutcome, note?: string): Promise<Report> {
  return (await connection(serverKey).request('report.resolve', { id, outcome, note: note?.trim() || undefined })).report
}

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

/** A decrypted message you could share with moderators: from a DM with the person, or a group you're both in. */
export interface ShareCandidate extends SharedMessage {
  id: string
  /** Where it was said: null for your DM with them, else the group's title. */
  where: string | null
}

/**
 * The newest readable text messages between you and this person (DM, then groups you share), newest last.
 * Only plain text: no calls, notices, friend actions or messages that couldn't be decrypted.
 */
export function shareCandidates(peer: string, limit = 50): ShareCandidate[] {
  const mine = me()
  const out: ShareCandidate[] = []
  const usable = (m: { from: string; text: string; error?: string; call?: unknown; pending?: string }) =>
    (m.from === peer || m.from === mine) && !m.error && !m.call && !m.pending && m.text.trim().length > 0
  for (const m of useDms.getState().conversations[peer]?.messages ?? []) {
    if (!usable(m) || m.notice || m.friend) continue
    out.push({ id: `dm:${m.id}`, author: m.from, text: m.text.slice(0, MAX_SHARED_TEXT), at: m.sentAt, where: null })
  }
  for (const g of Object.values(useGroups.getState().groups)) {
    if (!g.view?.members.includes(peer)) continue
    for (const m of g.messages) {
      if (!usable(m) || m.group) continue
      out.push({ id: `g:${g.key}:${m.id}`, author: m.from, text: m.text.slice(0, MAX_SHARED_TEXT), at: m.sentAt, where: g.name ?? '' })
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(-limit)
}
