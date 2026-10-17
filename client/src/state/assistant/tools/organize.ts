// Organize: channels and categories (the same requests as Server settings → Channels), a theme for this device, and
// setting up a bot (a bot invite the user sees in the app, never the model, plus help writing its code). Every call is
// approved by the user; the low-risk ones may be allowed for the rest of the session.
import type { Channel, Role } from '../../../core/protocol'
import { BODY_FONTS, COLOR_KEYS, MONO_FONTS, validateTheme, type ThemeFile } from '../../../theme/theme'
import { categoryOf, channelOf, optStr, SERVER_ARG, str, ToolError, type Prepared, type ToolDef } from './registry'

const KINDS: Channel['kind'][] = ['text', 'voice', 'forum', 'stage', 'docs', 'whiteboard', 'media']
const NONE = new Set(['none', 'no category', ''])

export const ORGANIZE_TOOLS: ToolDef[] = [
  {
    name: 'create_channel',
    category: 'organize',
    risk: 'low',
    needsServer: true,
    description: 'Creates a channel (text by default) on the server, optionally in a category. Needs admin or the manage channels permission.',
    schema: {
      type: 'object',
      properties: {
        server: SERVER_ARG,
        name: { type: 'string', description: 'Channel name, e.g. "plans".' },
        kind: { type: 'string', enum: KINDS },
        category: { type: 'string', description: 'Category name or id.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const server = ctx.server!
      const name = str(args.name, 'name', 100).replace(/^#/, '')
      const kind = (args.kind ?? 'text') as Channel['kind']
      if (!KINDS.includes(kind)) throw new ToolError(`"kind" must be one of ${KINDS.join(', ')}.`)
      const category = args.category !== undefined && !NONE.has(String(args.category).toLowerCase()) ? categoryOf(ctx.host, server, args.category) : null
      const body = { name, kind, ...(category ? { categoryId: category.id } : {}) }
      return {
        summary: (category ? { key: 'createChannelIn', args: { name, kind, category: category.name } } : { key: 'createChannel', args: { name, kind } }) as Prepared['summary'],
        request: { type: 'channel.create', body },
        async run() {
          const { channel } = (await ctx.request('channel.create', body)) as { channel: Channel }
          return `Created #${channel.name} (id ${channel.id}).`
        },
      }
    },
  },
  {
    name: 'rename_channel',
    category: 'organize',
    risk: 'low',
    needsServer: true,
    description: 'Renames a channel.',
    schema: {
      type: 'object',
      properties: { server: SERVER_ARG, channel: { type: 'string', description: 'Current name or id.' }, name: { type: 'string', description: 'New name.' } },
      required: ['channel', 'name'],
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const channel = channelOf(ctx.server!, args.channel)
      const name = str(args.name, 'name', 100).replace(/^#/, '')
      const body = { id: channel.id, name }
      return {
        summary: { key: 'renameChannel', args: { from: channel.name, to: name } },
        request: { type: 'channel.update', body },
        run: async () => (await ctx.request('channel.update', body), `Renamed #${channel.name} to #${name}.`),
      }
    },
  },
  {
    name: 'move_channel',
    category: 'organize',
    risk: 'low',
    needsServer: true,
    description: 'Moves a channel into a category (or out of any category with "none"), optionally placing it before another channel there.',
    schema: {
      type: 'object',
      properties: {
        server: SERVER_ARG,
        channel: { type: 'string', description: 'Channel name or id.' },
        category: { type: 'string', description: 'Category name or id, or "none".' },
        before: { type: 'string', description: 'Put it before this channel (name or id); leave out for the end.' },
      },
      required: ['channel', 'category'],
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const server = ctx.server!
      const channel = channelOf(server, args.channel)
      const category = NONE.has(String(args.category ?? '').trim().toLowerCase()) ? null : categoryOf(ctx.host, server, args.category)
      const before = args.before !== undefined ? channelOf(server, args.before, 'before') : null
      const body = { id: channel.id, categoryId: category?.id ?? null, ...(before ? { before: before.id } : {}) }
      return {
        summary: (category ? { key: 'moveChannel', args: { channel: channel.name, category: category.name } } : { key: 'moveChannelOut', args: { channel: channel.name } }) as Prepared['summary'],
        request: { type: 'channel.move', body },
        run: async () => (await ctx.request('channel.move', body), `Moved #${channel.name}.`),
      }
    },
  },
  {
    name: 'create_category',
    category: 'organize',
    risk: 'low',
    needsServer: true,
    description: 'Creates a channel category (1–32 characters).',
    schema: { type: 'object', properties: { server: SERVER_ARG, name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    prepare(args, ctx) {
      const name = str(args.name, 'name', 32)
      const body = { name }
      return {
        summary: { key: 'createCategory', args: { name } },
        request: { type: 'category.create', body },
        async run() {
          const { category } = (await ctx.request('category.create', body)) as { category: { id: number; name: string } }
          return `Created the category "${category.name}" (id ${category.id}).`
        },
      }
    },
  },
  {
    name: 'rename_category',
    category: 'organize',
    risk: 'low',
    needsServer: true,
    description: 'Renames a category.',
    schema: { type: 'object', properties: { server: SERVER_ARG, category: { type: 'string' }, name: { type: 'string' } }, required: ['category', 'name'], additionalProperties: false },
    prepare(args, ctx) {
      const category = categoryOf(ctx.host, ctx.server!, args.category)
      const name = str(args.name, 'name', 32)
      const body = { id: category.id, name }
      return {
        summary: { key: 'renameCategory', args: { from: category.name, to: name } },
        request: { type: 'category.update', body },
        run: async () => (await ctx.request('category.update', body), `Renamed the category to "${name}".`),
      }
    },
  },
  {
    name: 'move_category',
    category: 'organize',
    risk: 'low',
    needsServer: true,
    description: 'Moves a category before another category, or to the end.',
    schema: {
      type: 'object',
      properties: { server: SERVER_ARG, category: { type: 'string' }, before: { type: 'string', description: 'Category to put it before; leave out for the end.' } },
      required: ['category'],
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const server = ctx.server!
      const category = categoryOf(ctx.host, server, args.category)
      const before = args.before !== undefined ? categoryOf(ctx.host, server, args.before, 'before') : null
      const body = { id: category.id, before: before?.id ?? null }
      return {
        summary: { key: 'moveCategory', args: { category: category.name } },
        request: { type: 'category.move', body },
        run: async () => (await ctx.request('category.move', body), `Moved the category "${category.name}".`),
      }
    },
  },
  {
    name: 'create_theme',
    category: 'organize',
    risk: 'low',
    needsServer: false,
    description: `Makes a colour theme for Iskra on this device from a description and applies it after the user approves (they see a preview). Colours are #rrggbb. Keys: ${COLOR_KEYS.join(', ')}. Give at least bgDeep, bgChat, bgSidebar, textNormal, textMuted and accent, with readable contrast. Fonts: body ${Object.keys(BODY_FONTS).join('/')}, mono ${Object.keys(MONO_FONTS).join('/')}. The user can switch back in My settings → Appearance.`,
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        scheme: { type: 'string', enum: ['dark', 'light'] },
        colors: { type: 'object', description: 'Colour key → #rrggbb.', additionalProperties: { type: 'string' } },
        radius: { type: 'integer', minimum: 0, maximum: 24 },
        avatarShape: { type: 'string', enum: ['circle', 'rounded', 'square'] },
        fonts: { type: 'object', properties: { body: { type: 'string' }, mono: { type: 'string' } }, additionalProperties: false },
      },
      required: ['name', 'colors'],
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const name = str(args.name, 'name', 40)
      const input = {
        meta: { name, ...(optStr(args.description, 'description', 200) ? { desc: optStr(args.description, 'description', 200) } : {}), ...(args.scheme ? { scheme: args.scheme } : {}) },
        colors: args.colors,
        ...(args.radius !== undefined ? { radius: args.radius } : {}),
        ...(args.avatarShape !== undefined ? { avatarShape: args.avatarShape } : {}),
        ...(args.fonts !== undefined ? { fonts: args.fonts } : {}),
      }
      const result = validateTheme(input)
      if (!result.ok) throw new ToolError(`That theme isn't valid: ${result.errors.slice(0, 5).join('; ')}`)
      const theme: ThemeFile = result.theme
      return {
        summary: { key: 'createTheme', args: { name } },
        request: { type: 'theme (this device only)', body: theme },
        preview: { theme },
        run: async () => (ctx.host.applyTheme(theme), `Applied the theme "${name}" on this device.`),
      }
    },
  },
  {
    name: 'set_up_bot',
    category: 'organize',
    risk: 'write',
    needsServer: true,
    description: "Creates a single-use bot invite (7 days) so the user can run their own bot, and shows the link to the user in the app. You never see the link: in code, read it from the ISKRA_INVITE environment variable. Needs admin. Use help_search for the SDK before writing bot code.",
    schema: {
      type: 'object',
      properties: { server: SERVER_ARG, role: { type: 'string', enum: ['guest', 'member', 'trusted'], description: 'The bot\'s level (default member).' } },
      additionalProperties: false,
    },
    prepare(args, ctx) {
      const server = ctx.server!
      const role = (args.role ?? 'member') as Role
      if (!['guest', 'member', 'trusted'].includes(role)) throw new ToolError('"role" must be guest, member or trusted.')
      const body = { role }
      return {
        summary: { key: 'botInvite', args: { role } },
        request: { type: 'bot.invite', body },
        async run() {
          const { invite } = (await ctx.request('bot.invite', body)) as { invite: { code: string } }
          ctx.host.showSecret('botInvite', server.key, ctx.host.inviteLink(server, invite.code))
          return 'A single-use bot invite (valid 7 days) was created and is shown to the user in the Assistant panel, where they can copy it. You do not have it and must not ask for it. In bot code, read it from process.env.ISKRA_INVITE (or os.environ["ISKRA_INVITE"] in Python).'
        },
      }
    },
  },
]
