// Search & read: free to run (no approval), but what they return goes to the AI provider, so they return little: names,
// ids and short message texts, never secrets, and never anything from encrypted channels or direct messages.
import type { Message, ServerRole } from '../../../core/protocol'
import type { ServerState } from '../../store'
import { searchHelp } from '../helpCorpus'
import { channelOf, int, optStr, SERVER_ARG, str, ToolError, type ToolDef } from './registry'

const MAX_TEXT = 400
const MAX_OUTPUT = 15_000

const nameOf = (server: ServerState, accountKey: string) =>
  server.members[accountKey]?.name ?? (accountKey.startsWith('webhook:') ? 'a webhook' : 'someone')

const clip = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}…` : text)

function line(server: ServerState, m: Message): string {
  const when = new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ')
  const files = m.attachments?.length ? ` [${m.attachments.length} file(s)]` : ''
  return `[${when} UTC] ${nameOf(server, m.author)} (message ${m.id}): ${clip(m.text.replace(/\s+/g, ' ').trim())}${files}`
}

function cap(lines: string[]): string {
  let out = ''
  for (const l of lines) {
    if (out.length + l.length > MAX_OUTPUT) return `${out}…(more not shown)`
    out += `${l}\n`
  }
  return out.trim()
}

export const READ_TOOLS: ToolDef[] = [
  {
    name: 'help_search',
    category: 'read',
    risk: 'read',
    needsServer: false,
    description: "Searches Iskra's own documentation (using the app, hosting a server, bots and the bot SDK, the assistant, the wire protocol). Use it for any \"how do I…\" question and before writing bot code.",
    schema: { type: 'object', properties: { query: { type: 'string', description: 'What to look up, in a few words.' } }, required: ['query'], additionalProperties: false },
    prepare(args, ctx) {
      const query = str(args.query, 'query', 200)
      return {
        summary: { key: 'help', args: { query } },
        async run() {
          const found = searchHelp(await ctx.host.helpSections(), query, 3)
          if (!found.length) return 'Nothing in the docs matches that. Try other words.'
          return found.map((s) => `## ${s.doc}: ${s.title}\n${s.text}`).join('\n\n')
        },
      }
    },
  },
  {
    name: 'list_servers',
    category: 'read',
    risk: 'read',
    needsServer: false,
    description: "Lists the servers the user is on: name, the user's level there, and whether it's connected.",
    schema: { type: 'object', properties: {}, additionalProperties: false },
    prepare(_args, ctx) {
      return {
        summary: { key: 'listServers', args: {} },
        untrusted: true,
        run: async () => cap(ctx.host.servers().map((s) => `${s.name} (your level: ${s.me?.role ?? 'unknown'}; ${s.status.state === 'online' ? 'connected' : 'not connected'})`)) || 'No servers.',
      }
    },
  },
  {
    name: 'list_channels',
    category: 'read',
    risk: 'read',
    needsServer: true,
    description: 'Lists the channels and categories on the server that the user can see: id, name, kind, category, who can read and write, and whether it is end-to-end encrypted.',
    schema: { type: 'object', properties: { server: SERVER_ARG }, additionalProperties: false },
    prepare(_args, ctx) {
      const server = ctx.server!
      return {
        summary: { key: 'listChannels', args: { server: server.name } },
        untrusted: true,
        async run() {
          const categories = ctx.host.categoriesOf(server.key)
          const catName = (id: number | null | undefined) => categories.find((c) => c.id === id)?.name
          const channels = [...server.channels].sort((a, b) => a.position - b.position).map((c) => {
            const category = catName((c as { categoryId?: number | null }).categoryId)
            return `#${c.name} (id ${c.id}, ${c.kind}${category ? `, category "${category}"` : ''}, read: ${c.readRole}+, write: ${c.writeRole}+${c.e2ee ? ', end-to-end encrypted' : ''})`
          })
          const cats = categories.map((c) => `"${c.name}" (category id ${c.id})`)
          return cap([`Categories: ${cats.length ? cats.join(', ') : 'none'}`, 'Channels:', ...channels])
        },
      }
    },
  },
  {
    name: 'list_members',
    category: 'read',
    risk: 'read',
    needsServer: true,
    description: 'Lists members of the server: name, accountKey, level, online, and whether it is a bot. Optionally filtered by name.',
    schema: { type: 'object', properties: { server: SERVER_ARG, query: { type: 'string', description: 'Part of a name.' } }, additionalProperties: false },
    prepare(args, ctx) {
      const server = ctx.server!
      const query = optStr(args.query, 'query', 50)?.toLowerCase()
      return {
        summary: { key: 'listMembers', args: { server: server.name } },
        untrusted: true,
        async run() {
          const members = Object.values(server.members)
            .filter((m) => !query || m.name.toLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name))
          const shown = members.slice(0, 200).map((m) => `${m.name} (accountKey ${m.accountKey}, ${m.role}${m.online ? ', online' : ''}${m.bot ? ', bot' : ''}${m.timedOutUntil && m.timedOutUntil > Date.now() ? ', timed out' : ''})`)
          return cap([`${members.length} member(s)${members.length > 200 ? ', first 200 shown' : ''}:`, ...shown])
        },
      }
    },
  },
  {
    name: 'list_roles',
    category: 'read',
    risk: 'read',
    needsServer: true,
    description: "Lists the server's custom roles (highest first): id, name, colour and permissions.",
    schema: { type: 'object', properties: { server: SERVER_ARG }, additionalProperties: false },
    prepare(_args, ctx) {
      const server = ctx.server!
      return {
        summary: { key: 'listRoles', args: { server: server.name } },
        untrusted: true,
        async run() {
          const { roles } = (await ctx.request('role.list', {})) as { roles: ServerRole[] }
          if (!roles.length) return 'No custom roles. Everyone has a level: guest, member, trusted, admin or owner.'
          return cap(roles.map((r) => `${r.name} (id ${r.id}, position ${r.position}${r.color ? `, ${r.color}` : ''}; permissions: ${r.permissions.join(', ') || 'none'})`))
        },
      }
    },
  },
  {
    name: 'search_messages',
    category: 'read',
    risk: 'read',
    needsServer: true,
    description: 'Searches messages on the server in channels the user can read (never encrypted channels). Returns up to 25 matches, newest first.',
    schema: {
      type: 'object',
      properties: {
        server: SERVER_ARG,
        query: { type: 'string', description: 'Words to find (each matches the start of a word).' },
        channel: { type: 'string', description: 'Only this channel (name or id).' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const server = ctx.server!
      const query = str(args.query, 'query', 200)
      const channel = args.channel !== undefined ? channelOf(server, args.channel) : null
      if (channel?.e2ee) throw new ToolError('That channel is end-to-end encrypted; the assistant never reads it. The user can paste text instead.')
      const limit = args.limit === undefined ? 15 : Math.min(25, Math.max(1, int(args.limit, 'limit')))
      return {
        summary: { key: 'search', args: { query, server: server.name } },
        untrusted: true,
        async run() {
          const reply = (await ctx.request('search', { query, ...(channel ? { channelId: channel.id } : {}), limit })) as { results: { message: Message }[]; total: number }
          const readable = reply.results.filter((r) => !server.channels.find((c) => c.id === r.message.channelId)?.e2ee)
          if (!readable.length) return 'No messages match.'
          const where = (id: number) => `#${server.channels.find((c) => c.id === id)?.name ?? 'a thread'}`
          return cap([`${reply.total} match(es); ${readable.length} shown:`, ...readable.map((r) => `${where(r.message.channelId)} ${line(server, r.message)}`)])
        },
      }
    },
  },
  {
    name: 'read_channel',
    category: 'read',
    risk: 'read',
    needsServer: true,
    description: "Reads the latest messages of a channel the user can read (default: the one they're looking at), for summaries or questions. Never encrypted channels.",
    schema: {
      type: 'object',
      properties: {
        server: SERVER_ARG,
        channel: { type: 'string', description: 'Channel name or id; leave out for the open channel.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many messages (default 30).' },
      },
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const server = ctx.server!
      const open = ctx.host.activeChannelId(server.key)
      const channel = args.channel !== undefined ? channelOf(server, args.channel) : server.channels.find((c) => c.id === open)
      if (!channel) throw new ToolError('No channel is open; name one.')
      if (channel.e2ee) throw new ToolError('That channel is end-to-end encrypted; the assistant never reads it. The user can paste text instead.')
      const limit = args.limit === undefined ? 30 : Math.min(50, Math.max(1, int(args.limit, 'limit')))
      return {
        summary: { key: 'readChannel', args: { channel: channel.name, count: limit } },
        untrusted: true,
        async run() {
          const { messages } = (await ctx.request('chat.history', { channelId: channel.id, limit })) as { messages: Message[] }
          const shown = messages.filter((m) => !m.e2ee && m.text)
          if (!shown.length) return `#${channel.name} has no messages to read.`
          return cap([`Latest ${shown.length} message(s) in #${channel.name}, oldest first:`, ...shown.map((m) => line(server, m))])
        },
      }
    },
  },
]
