// Mirrors the server's permission rules (Sessions/Permissions.cs) so the UI only offers what will work.
// The server decides; this only hides buttons that would fail.
import {
  roleRank, type Channel, type ChannelPermission, type Member, type Message, type Permission, type ServerRole,
} from '../core/protocol'

export const PERMISSIONS: { id: Permission; label: string; hint: string }[] = [
  { id: 'manageMessages', label: 'Manage messages', hint: "Delete and pin others' messages, end polls, manage threads" },
  { id: 'timeoutMembers', label: 'Time out members', hint: 'Stop someone writing and talking for a while' },
  { id: 'kickMembers', label: 'Kick members', hint: 'Remove people (they can come back with an invite)' },
  { id: 'banMembers', label: 'Ban members', hint: 'Remove people for good, and unban them' },
  { id: 'manageChannels', label: 'Manage channels', hint: 'Create, edit and delete channels, slowmode and channel permissions' },
  { id: 'manageRoles', label: 'Manage roles', hint: 'Create and give roles below their own highest role' },
  { id: 'viewAuditLog', label: 'View audit log', hint: 'See who did what on this server' },
  { id: 'manageExpressions', label: 'Manage emoji and sounds', hint: "Add, rename and delete anyone's emoji and sounds" },
  { id: 'manageWebhooks', label: 'Manage webhooks', hint: 'Create and change webhooks' },
  { id: 'mentionEveryone', label: 'Mention @everyone', hint: 'Notify everyone with @everyone and @here' },
  { id: 'moveMembers', label: 'Move members', hint: 'Move people between voice channels' },
  { id: 'muteMembers', label: 'Mute members', hint: 'Mute people in voice for everyone' },
]

/** The "Moderator" preset: every permission a moderator needs, without being an admin. */
export const MODERATOR_PRESET: Permission[] = PERMISSIONS.map((p) => p.id)

export const isAdmin = (member: Member | null | undefined) => !!member && roleRank(member.role) >= roleRank('admin')

/** The member's custom roles, highest first. */
export function rolesOf(member: Member | null | undefined, roles: ServerRole[]): ServerRole[] {
  const ids = new Set(member?.roles ?? [])
  return roles.filter((r) => ids.has(r.id)).sort((a, b) => b.position - a.position)
}

export const topPosition = (member: Member | null | undefined, roles: ServerRole[]) => rolesOf(member, roles)[0]?.position ?? 0

export function has(member: Member | null | undefined, roles: ServerRole[], permission: Permission): boolean {
  return isAdmin(member) || rolesOf(member, roles).some((r) => r.permissions.includes(permission))
}

/** Owner, then admins, then custom roles by the highest one, then trusted, member, guest. */
function height(member: Member, roles: ServerRole[]): [number, number] {
  if (member.role === 'owner') return [3, 0]
  if (isAdmin(member)) return [2, 0]
  const top = topPosition(member, roles)
  return top > 0 ? [1, top] : [0, roleRank(member.role)]
}

export function outranks(actor: Member | null | undefined, target: Member | null | undefined, roles: ServerRole[]): boolean {
  if (!actor || !target) return false
  const [a1, a2] = height(actor, roles)
  const [b1, b2] = height(target, roles)
  return a1 > b1 || (a1 === b1 && a2 > b2)
}

/** Roles you can give, edit or move: those below your highest (admins: all). */
export const isAbove = (actor: Member | null | undefined, position: number, roles: ServerRole[]) =>
  isAdmin(actor) || topPosition(actor, roles) > position

/** Levels give the base, then the member's roles' overrides: denies, then allows. */
export function channelAccess(member: Member | null | undefined, channel: Channel, roles: ServerRole[]): Set<ChannelPermission> {
  const out = new Set<ChannelPermission>()
  if (!member) return out
  const rank = roleRank(member.role)
  if (rank >= roleRank(channel.readRole)) { out.add('view'); out.add('connect') }
  if (rank >= roleRank(channel.writeRole)) { out.add('send'); out.add('speak') }
  const mine = new Set(member.roles ?? [])
  const overrides = (channel.overrides ?? []).filter((o) => mine.has(o.roleId) && roles.some((r) => r.id === o.roleId))
  for (const o of overrides) for (const p of o.deny) out.delete(p)
  for (const o of overrides) for (const p of o.allow) out.add(p)
  if (!out.has('view')) return new Set()
  if (!out.has('connect')) out.delete('speak')
  return out
}

export const canSendIn = (member: Member | null | undefined, channel: Channel, roles: ServerRole[]) =>
  channelAccess(member, channel, roles).has(channel.kind === 'voice' ? 'speak' : 'send')

export function canDeleteMessage(me: Member | null | undefined, message: Message, author: Member | undefined, roles: ServerRole[]): boolean {
  if (!me) return false
  return message.author === me.accountKey || (has(me, roles, 'manageMessages') && (!author || outranks(me, author, roles)))
}

/** The highest role with a colour. */
export const nameColor = (member: Member | null | undefined, roles: ServerRole[]) =>
  rolesOf(member, roles).find((r) => r.color)?.color ?? null

/** The highest role shown on its own in the member list. */
export const hoistedRole = (member: Member, roles: ServerRole[]) => rolesOf(member, roles).find((r) => r.hoist) ?? null

/** A role mention notifies when the role allows anyone to mention it, or the author may mention everyone. Webhooks never ping roles. */
export const canMentionRole = (author: Member | undefined, role: ServerRole, roles: ServerRole[]) =>
  !!role.mentionable || (!!author && canPingGroups(author, roles, false))

/** Does this message mention one of the viewer's roles (in a way that notifies)? */
export function mentionsMyRole(text: string, me: Member | null | undefined, author: Member | undefined, roles: ServerRole[], webhook: boolean): boolean {
  if (!me || webhook) return false
  const mine = new Set(me.roles ?? [])
  return [...text.matchAll(/<@&(\d{1,12})>/g)].some((m) => {
    const role = roles.find((r) => r.id === Number(m[1]))
    return !!role && mine.has(role.id) && canMentionRole(author, role, roles)
  })
}

/** Who can @everyone: webhooks, trusted+, or a role that allows it. */
export const canPingGroups = (author: Member | undefined, roles: ServerRole[], webhook: boolean) =>
  webhook || (!!author && (roleRank(author.role) >= roleRank('trusted') || has(author, roles, 'mentionEveryone')))
