// Pure rules (no React, no socket) for invite tracking and incoming webhook formats: how an invite reads, the
// "joined with" filter, format URLs and signing secrets. See "Invite tracking" and "Webhook formats" in PROTOCOL.md.
import type { JoinedVia } from '../core/protocol'
import { t } from '../i18n'

export const MAX_INVITE_LABEL = 40

/** The invites people joined with, for the filter: most used first, then by name. */
export function joinInvites(joins: JoinedVia[]): { invite: JoinedVia['invite']; count: number }[] {
  const byId = new Map<string, { invite: JoinedVia['invite']; count: number }>()
  for (const j of joins) {
    const entry = byId.get(j.invite.id)
    if (entry) entry.count++
    else byId.set(j.invite.id, { invite: j.invite, count: 1 })
  }
  return [...byId.values()].sort((a, b) => b.count - a.count || sortName(a.invite).localeCompare(sortName(b.invite)))
}

const sortName = (i: { id: string; label: string | null }) => i.label ?? `~${i.id}`

/** How an invite reads: its label in quotes, or "invite abc123" (the start of its public id). */
export function inviteName(invite: { id: string; label: string | null }): string {
  return invite.label ? t('invitetrack.named', { label: invite.label }) : t('invitetrack.unnamed', { id: invite.id.slice(0, 6) })
}

/** "Joined with “Reddit post” from Anna" (and who let them in). The maker's current name, else the one recorded. */
export function joinedViaText(j: JoinedVia, nameOf: (key: string) => string | undefined): string {
  const invite = inviteName(j.invite)
  const maker = j.invite.createdBy === 'server' ? t('invitetrack.setupLink')
    : j.invite.createdBy ? nameOf(j.invite.createdBy) ?? j.invite.createdByName ?? t('invitetrack.someone') : null
  const base = maker ? t('invitetrack.viaFrom', { invite, name: maker }) : t('invitetrack.via', { invite })
  if (!j.approvedBy) return base
  return t('invitetrack.approved', { text: base, name: nameOf(j.approvedBy) ?? j.approvedByName ?? t('invitetrack.someone') })
}

// ── Incoming webhook formats ────────────────────────────────────────────────

export const WEBHOOK_FORMATS = ['discord', 'github', 'gitea', 'gitlab', 'slack'] as const
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number]

/** The URL for a format: the plain URL, or with the service's suffix. */
export const webhookFormatUrl = (url: string, format: WebhookFormat): string => (format === 'discord' ? url : `${url}/${format}`)

export const SIGNING_MIN = 16
export const SIGNING_MAX = 256

/** A fresh signing secret: 32 random bytes as base64url (43 characters). */
export function newSigningSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** What's wrong with a secret the admin typed (the server checks the same), or null. */
export function signingSecretProblem(secret: string): 'length' | 'characters' | null {
  if (secret.length < SIGNING_MIN || secret.length > SIGNING_MAX) return 'length'
  if (/[^\x20-\x7e]/.test(secret) || secret.trim() !== secret) return 'characters'
  return null
}
