// Moderation and Server admin: off until the user turns each group on (My settings → Assistant), and every call is
// approved on its own, never "for the session". The server checks the user's rights and rank for each request as usual.
import type { Role } from '../../../core/protocol'
import { channelOf, int, LEVELS, memberOf, optStr, SERVER_ARG, str, ToolError, type ToolDef } from './registry'
import type { Permission } from '../../../core/protocol'
import { PERMISSIONS } from '../../permissions'

const DURATIONS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000, '1d': 86_400_000, '1w': 604_800_000 }

const member = { type: 'string', description: 'Name or accountKey (list_members).' }

export const MODERATION_TOOLS: ToolDef[] = [
  {
    name: 'timeout_member',
    category: 'moderation',
    risk: 'destructive',
    needsServer: true,
    description: "Times a member out (they can read but not send, react or join voice) for 1m, 5m, 1h, 1d or 1w.",
    schema: {
      type: 'object',
      properties: { server: SERVER_ARG, member, duration: { type: 'string', enum: Object.keys(DURATIONS) }, reason: { type: 'string' } },
      required: ['member', 'duration'],
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const target = memberOf(ctx.server!, args.member)
      const durationMs = DURATIONS[String(args.duration)]
      if (!durationMs) throw new ToolError(`"duration" must be one of ${Object.keys(DURATIONS).join(', ')}.`)
      const reason = optStr(args.reason, 'reason', 200)
      const body = { accountKey: target.accountKey, durationMs, ...(reason ? { reason } : {}) }
      return {
        summary: { key: 'timeout', args: { name: target.name, duration: String(args.duration) } },
        request: { type: 'member.timeout', body },
        run: async () => (await ctx.request('member.timeout', body), `Timed out ${target.name} for ${String(args.duration)}.`),
      }
    },
  },
  {
    name: 'remove_timeout',
    category: 'moderation',
    risk: 'write',
    needsServer: true,
    description: "Ends a member's timeout early.",
    schema: { type: 'object', properties: { server: SERVER_ARG, member }, required: ['member'], additionalProperties: false },
    prepare(args, ctx) {
      const target = memberOf(ctx.server!, args.member)
      const body = { accountKey: target.accountKey }
      return {
        summary: { key: 'untimeout', args: { name: target.name } },
        request: { type: 'member.timeout.remove', body },
        run: async () => (await ctx.request('member.timeout.remove', body), `Ended ${target.name}'s timeout.`),
      }
    },
  },
  {
    name: 'warn_member',
    category: 'moderation',
    risk: 'write',
    needsServer: true,
    description: 'Sends a member a private warning from the moderators, with a reason.',
    schema: { type: 'object', properties: { server: SERVER_ARG, member, reason: { type: 'string' } }, required: ['member', 'reason'], additionalProperties: false },
    prepare(args, ctx) {
      const target = memberOf(ctx.server!, args.member)
      const reason = str(args.reason, 'reason', 500)
      const body = { accountKey: target.accountKey, reason }
      return {
        summary: { key: 'warn', args: { name: target.name } },
        request: { type: 'member.warn', body },
        run: async () => (await ctx.request('member.warn', body), `Warned ${target.name}.`),
      }
    },
  },
  {
    name: 'kick_member',
    category: 'moderation',
    risk: 'destructive',
    needsServer: true,
    description: 'Removes a member from the server (they can come back with a new invite).',
    schema: { type: 'object', properties: { server: SERVER_ARG, member }, required: ['member'], additionalProperties: false },
    prepare(args, ctx) {
      const target = memberOf(ctx.server!, args.member)
      const body = { accountKey: target.accountKey }
      return {
        summary: { key: 'kick', args: { name: target.name } },
        request: { type: 'member.kick', body },
        run: async () => (await ctx.request('member.kick', body), `Kicked ${target.name}.`),
      }
    },
  },
  {
    name: 'ban_member',
    category: 'moderation',
    risk: 'destructive',
    needsServer: true,
    description: 'Bans a member (removes them and stops them coming back), with an optional reason.',
    schema: { type: 'object', properties: { server: SERVER_ARG, member, reason: { type: 'string' } }, required: ['member'], additionalProperties: false },
    prepare(args, ctx) {
      const target = memberOf(ctx.server!, args.member)
      const reason = optStr(args.reason, 'reason', 200)
      const body = { accountKey: target.accountKey, ...(reason ? { reason } : {}) }
      return {
        summary: { key: 'ban', args: { name: target.name } },
        request: { type: 'member.ban', body },
        run: async () => (await ctx.request('member.ban', body), `Banned ${target.name}.`),
      }
    },
  },
  {
    name: 'delete_messages',
    category: 'moderation',
    risk: 'destructive',
    needsServer: true,
    description: 'Deletes messages by id (from read_channel or search_messages) in one channel, up to 100.',
    schema: {
      type: 'object',
      properties: { server: SERVER_ARG, channel: { type: 'string', description: 'Channel name or id.' }, ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 100 } },
      required: ['channel', 'ids'],
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const channel = channelOf(ctx.server!, args.channel)
      if (!Array.isArray(args.ids) || args.ids.length === 0 || args.ids.length > 100) throw new ToolError('"ids" must list 1 to 100 message ids.')
      const ids = [...new Set(args.ids.map((id) => int(id, 'ids')))]
      const single = ids.length === 1
      const body = single ? { id: ids[0] } : { channelId: channel.id, ids }
      const type = single ? 'chat.delete' : 'chat.delete.bulk'
      return {
        summary: { key: 'deleteMessages', args: { count: ids.length, channel: channel.name } },
        request: { type, body },
        run: async () => (await ctx.request(type, body), `Deleted ${ids.length} message(s) in #${channel.name}.`),
      }
    },
  },
]

export const ADMIN_TOOLS: ToolDef[] = [
  {
    name: 'set_member_level',
    category: 'admin',
    risk: 'destructive',
    needsServer: true,
    description: "Sets a member's level: guest, member, trusted or admin (admins and the owner only, for people below them).",
    schema: { type: 'object', properties: { server: SERVER_ARG, member, level: { type: 'string', enum: LEVELS } }, required: ['member', 'level'], additionalProperties: false },
    prepare(args, ctx) {
      const target = memberOf(ctx.server!, args.member)
      const role = args.level as Role
      if (!LEVELS.includes(role)) throw new ToolError(`"level" must be one of ${LEVELS.join(', ')}.`)
      const body = { accountKey: target.accountKey, role }
      return {
        summary: { key: 'setLevel', args: { name: target.name, level: role } },
        request: { type: 'member.setRole', body },
        run: async () => (await ctx.request('member.setRole', body), `${target.name} is now ${role}.`),
      }
    },
  },
  {
    name: 'create_role',
    category: 'admin',
    risk: 'write',
    needsServer: true,
    description: `Creates a custom role. Permissions: ${PERMISSIONS.join(', ')}.`,
    schema: {
      type: 'object',
      properties: {
        server: SERVER_ARG,
        name: { type: 'string' },
        color: { type: 'string', description: '#rrggbb' },
        permissions: { type: 'array', items: { type: 'string', enum: [...PERMISSIONS] } },
        hoist: { type: 'boolean', description: 'Shown as its own group in the member list.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const name = str(args.name, 'name', 32)
      const color = optStr(args.color, 'color', 7)
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new ToolError('"color" must look like #3ba55c.')
      const permissions = Array.isArray(args.permissions) ? (args.permissions as unknown[]) : []
      const bad = permissions.filter((p) => !PERMISSIONS.includes(p as Permission))
      if (bad.length) throw new ToolError(`Unknown permissions: ${bad.join(', ')}.`)
      const body = { name, ...(color ? { color } : {}), permissions: permissions as Permission[], ...(typeof args.hoist === 'boolean' ? { hoist: args.hoist } : {}) }
      return {
        summary: { key: 'createRole', args: { name, count: permissions.length } },
        request: { type: 'role.create', body },
        run: async () => (await ctx.request('role.create', body), `Created the role "${name}".`),
      }
    },
  },
  {
    name: 'set_member_roles',
    category: 'admin',
    risk: 'destructive',
    needsServer: true,
    description: "Replaces a member's custom roles with this list of role ids (list_roles).",
    schema: {
      type: 'object',
      properties: { server: SERVER_ARG, member, roles: { type: 'array', items: { type: 'integer' }, maxItems: 50 } },
      required: ['member', 'roles'],
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const target = memberOf(ctx.server!, args.member)
      if (!Array.isArray(args.roles) || args.roles.length > 50) throw new ToolError('"roles" must be a list of role ids.')
      const roles = [...new Set(args.roles.map((r) => int(r, 'roles')))]
      const body = { accountKey: target.accountKey, roles }
      return {
        summary: { key: 'setRoles', args: { name: target.name, count: roles.length } },
        request: { type: 'member.roles.set', body },
        run: async () => (await ctx.request('member.roles.set', body), `Updated ${target.name}'s roles.`),
      }
    },
  },
  {
    name: 'delete_channel',
    category: 'admin',
    risk: 'destructive',
    needsServer: true,
    description: 'Deletes a channel and all its messages. Cannot be undone.',
    schema: { type: 'object', properties: { server: SERVER_ARG, channel: { type: 'string' } }, required: ['channel'], additionalProperties: false },
    prepare(args, ctx) {
      const channel = channelOf(ctx.server!, args.channel)
      const body = { id: channel.id }
      return {
        summary: { key: 'deleteChannel', args: { channel: channel.name } },
        request: { type: 'channel.delete', body },
        run: async () => (await ctx.request('channel.delete', body), `Deleted #${channel.name}.`),
      }
    },
  },
  {
    name: 'update_rules',
    category: 'admin',
    risk: 'write',
    needsServer: true,
    description: "Replaces the server's rules text (Markdown, shown to new members).",
    schema: { type: 'object', properties: { server: SERVER_ARG, text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    prepare(args, ctx) {
      const text = str(args.text, 'text', 6000)
      const body = { text }
      return {
        summary: { key: 'rules', args: {} },
        request: { type: 'rules.update', body },
        run: async () => (await ctx.request('rules.update', body), 'Updated the server rules.'),
      }
    },
  },
]
