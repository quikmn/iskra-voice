// Mirrors the server's permission rules (Sessions/Permissions.cs) so the UI only offers what will work.
// The server decides; this only hides buttons that would fail.
import {
  roleRank, type BaseAbility, type BaseRoleInfo, type Channel, type ChannelPermission, type Member, type Message, type Permission, type Role, type ServerRole,
} from '../core/protocol'
import { t } from '../i18n'

export const PERMISSIONS: Permission[] = [
  'manageMessages', 'timeoutMembers', 'kickMembers', 'banMembers', 'manageChannels', 'manageRoles', 'viewAuditLog',
  'manageExpressions', 'manageWebhooks', 'mentionEveryone', 'moveMembers', 'muteMembers', 'manageAutoMod', 'prioritySpeaker',
]

export const permissionLabel = (p: Permission) => t(`roles.permissions.${p}.label`)
export const permissionHint = (p: Permission) => t(`roles.permissions.${p}.hint`)

const LEVELS: readonly string[] = ['guest', 'member', 'trusted', 'admin', 'owner'] satisfies Role[]

/** A level's name in the app's language ("member"); anything else as is. */
export const levelName = (role: string): string => (LEVELS.includes(role) ? t(`common.roles.${role as Role}`) : role)

/** The "Moderator" preset: every permission a moderator needs, without being an admin. */
export const MODERATOR_PRESET: Permission[] = [...PERMISSIONS]

export const isAdmin = (member: Member | null | undefined) => !!member && roleRank(member.role) >= roleRank('admin')

/** The member's custom roles, highest first. */
export function rolesOf(member: Member | null | undefined, roles: ServerRole[]): ServerRole[] {
  const ids = new Set(member?.roles ?? [])
  return roles.filter((r) => ids.has(r.id)).sort((a, b) => b.position - a.position)
}

export const topPosition = (member: Member | null | undefined, roles: ServerRole[]) => rolesOf(member, roles)[0]?.position ?? 0

/** Each base ability and the lowest role that has it by default (Sessions/BaseRoles.cs). */
export const DEFAULT_ABILITY_ROLES: Record<BaseAbility, Role> = {
  invite: 'member', events: 'member', whisper: 'member', externalEmoji: 'member',
  pin: 'trusted', mentionEveryone: 'trusted', uploadSounds: 'trusted',
  giveBaseRoles: 'admin', bots: 'admin', organize: 'admin', rules: 'admin', stickers: 'admin', gifs: 'admin',
  stageModerators: 'admin', forumTags: 'admin', profilePages: 'admin', resolveDisputes: 'admin', serverImages: 'admin',
  runServer: 'owner', transferOwnership: 'owner',
}
export const BASE_ABILITIES = Object.keys(DEFAULT_ABILITY_ROLES) as BaseAbility[]

/** The member's base role allows the ability on this server (the server's list, else the defaults). */
export function baseAllows(baseRoles: BaseRoleInfo[] | undefined, member: Member | null | undefined, ability: BaseAbility): boolean {
  if (!member) return false
  if (member.role === 'owner') return true
  const info = baseRoles?.find((b) => b.id === member.role)
  return info?.defaults ? info.abilities.includes(ability) : roleRank(member.role) >= roleRank(DEFAULT_ABILITY_ROLES[ability])
}

/** The permissions the member's base role gives by itself (the owner: all; admins: all unless the server changed that). */
export function basePermissions(baseRoles: BaseRoleInfo[] | undefined, member: Member | null | undefined): Permission[] {
  if (!member) return []
  if (member.role === 'owner') return PERMISSIONS
  const info = baseRoles?.find((b) => b.id === member.role)
  return info?.defaults ? info.permissions : isAdmin(member) ? PERMISSIONS : []
}

/** Pass the server's base roles where they're at hand, so changed built-in powers count. */
export function has(member: Member | null | undefined, roles: ServerRole[], permission: Permission, baseRoles?: BaseRoleInfo[]): boolean {
  if (!member) return false
  const base = baseRoles ? basePermissions(baseRoles, member).includes(permission) : isAdmin(member)
  return base || rolesOf(member, roles).some((r) => r.permissions.includes(permission))
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
  if (rank >= roleRank(channel.writeRole)) { out.add('send'); out.add('speak'); out.add('setVoiceStatus') }
  const mine = new Set(member.roles ?? [])
  const overrides = (channel.overrides ?? []).filter((o) => mine.has(o.roleId) && roles.some((r) => r.id === o.roleId))
  for (const o of overrides) for (const p of o.deny) out.delete(p)
  for (const o of overrides) for (const p of o.allow) out.add(p)
  if (!out.has('view')) return new Set()
  if (!out.has('connect')) out.delete('speak')
  return out
}

/** Posting in a channel's chat (voice and stage channels have one too; speaking there is `speak`). */
export const canSendIn = (member: Member | null | undefined, channel: Channel, roles: ServerRole[]) =>
  channelAccess(member, channel, roles).has('send')

export function canDeleteMessage(me: Member | null | undefined, message: Message, author: Member | undefined, roles: ServerRole[]): boolean {
  if (!me) return false
  return message.author === me.accountKey || (has(me, roles, 'manageMessages') && (!author || outranks(me, author, roles)))
}

/** The highest role with a colour, by the hierarchy: owner/admin base role, then custom roles, then trusted, member, guest. */
export function nameColor(member: Member | null | undefined, roles: ServerRole[], baseRoles: BaseRoleInfo[] = []): string | null {
  const base = member ? baseRoles.find((b) => b.id === member.role)?.color ?? null : null
  if (base && isAdmin(member)) return base
  return rolesOf(member, roles).find((r) => r.color)?.color ?? base
}

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
