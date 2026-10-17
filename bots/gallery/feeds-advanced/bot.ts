// Feeds-advanced: a feed bot from the Iskra bot gallery. RSS/Atom/YouTube feeds with keyword filters, and Twitch
// "went live" alerts with your own Twitch app, in a channel or as a DM to each person who follows a streamer.
// It adds to the built-in Feeds bot (Server settings → Bots & webhooks), which needs no install. See README.md.
//   ISKRA_INVITE='<bot invite link>' npm run feeds-advanced     (in bots/; first time)
//   npm run feeds-advanced                                     (after that)
// Settings (flag or environment variable): --data / FEEDS_DATA (default feeds.json), --minutes / FEEDS_MINUTES
// (how often feeds are read, default 10), TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET (your Twitch app; without them,
// Twitch commands say so).
import { resolve } from 'node:path'
import { Bot, type AnswerContext, type Card } from 'iskra-bots'
import { checkAddress, fetchFeed, keywords, LIMITS, parseFeed, passes, Store, twitchLogin, type Feed, type FeedItem } from './feeds.ts'
import { Twitch, wentLive, type LiveStream } from './twitch.ts'

/** `--name value` on the command line, else the environment variable, else the default. */
function setting(flag: string, env: string, fallback: string): string {
  const at = process.argv.indexOf(`--${flag}`)
  return (at >= 0 ? process.argv[at + 1] : undefined) ?? process.env[env] ?? fallback
}

const store = new Store(resolve(setting('data', 'FEEDS_DATA', 'feeds.json')))
const minutes = Math.max(5, Number(setting('minutes', 'FEEDS_MINUTES', '10')) || 10)
// Only for trying it out against a feed on your own computer: lets the bot fetch private network addresses.
const allowPrivate = process.env.FEEDS_ALLOW_PRIVATE === '1'
const twitch = process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET ? new Twitch(process.env.TWITCH_CLIENT_ID, process.env.TWITCH_CLIENT_SECRET) : null

const bot = new Bot({ name: setting('name', 'BOT_NAME', 'Feeds Plus'), invite: process.env.ISKRA_INVITE, stateFile: process.env.ISKRA_BOT_STATE })
const isStaff = (user: string) => ['admin', 'owner'].includes(bot.members.get(user)?.role ?? '')
const COLOR = 0xff8a3d

function itemCard(item: FeedItem, feed: Feed): Card {
  const host = new URL(feed.url).hostname.replace(/^www\./, '')
  return {
    title: item.title.slice(0, 256),
    ...(item.link ? { url: item.link } : {}),
    ...(item.summary ? { description: item.summary.length > 300 ? `${item.summary.slice(0, 299)}…` : item.summary } : {}),
    color: COLOR,
    footer: { text: host },
  }
}

/** Reads one feed and posts what's new and passes its filters (at most 5 at a time, so a feed can't flood the channel). */
async function readFeed(feed: Feed): Promise<void> {
  try {
    const items = parseFeed(await fetchFeed(feed.url, allowPrivate))
    const fresh = store.newItems(feed, items).filter((i) => passes(i, feed.include, feed.exclude))
    feed.error = null
    store.save()
    for (const item of fresh.slice(-5)) await bot.send(feed.channelId, { cards: [itemCard(item, feed)] })
  } catch (e) {
    feed.error = (e as Error).message.slice(0, 200)
    store.save()
  }
}

let readingFeeds = false
async function readAll(): Promise<void> {
  if (readingFeeds) return
  readingFeeds = true
  try {
    for (const feed of [...store.state.feeds]) await readFeed(feed)
  } finally {
    readingFeeds = false
  }
}

async function checkTwitch(): Promise<void> {
  const logins = store.watched()
  if (!twitch || logins.length === 0) return
  let streams: LiveStream[]
  try {
    streams = await twitch.live(logins)
  } catch (e) {
    console.error(`Twitch: ${(e as Error).message}`)
    return
  }
  const { started, live } = wentLive(store.state.live, streams)
  store.state.live = live
  store.save()
  for (const s of started) {
    const card: Card = { title: `🔴 ${s.name} is live`, url: `https://twitch.tv/${s.login}`, description: s.title.slice(0, 300), color: 0x9146ff, ...(s.game ? { footer: { text: s.game } } : {}) }
    for (const alert of store.state.alerts.filter((a) => a.login === s.login)) await bot.send(alert.channelId, { cards: [card] }).catch(() => undefined)
    // People who followed this streamer themselves get a DM (end-to-end encrypted, like any DM).
    for (const user of store.state.follows[s.login] ?? []) {
      if (bot.members.has(user)) await bot.sendDm(user, { text: `🔴 **${s.name}** is live: ${s.title}\nhttps://twitch.tv/${s.login}` }).catch(() => undefined)
    }
  }
}

async function addFeed(ctx: AnswerContext, url: string, include: string, exclude: string): Promise<unknown> {
  if (store.state.feeds.length >= LIMITS.feeds) return ctx.reply(`That's the most feeds I follow (${LIMITS.feeds}). Remove one first.`, { private: true })
  const problem = await checkAddress(url, allowPrivate)
  if (problem) return ctx.reply(problem, { private: true })
  await ctx.defer()
  let items: FeedItem[]
  try {
    items = parseFeed(await fetchFeed(url, allowPrivate))
  } catch (e) {
    return ctx.reply(`I couldn't read that feed: ${(e as Error).message}`, { private: true })
  }
  if (items.length === 0) return ctx.reply('That address has no RSS or Atom items. Is it the feed itself (often ending in /feed, .rss or .xml)?', { private: true })
  const feed: Feed = { id: store.state.nextId++, url, channelId: ctx.channelId, include: keywords(include), exclude: keywords(exclude), seen: [] }
  store.newItems(feed, items) // what's there now counts as seen: only new items get posted
  store.state.feeds.push(feed)
  store.save()
  const filters = [feed.include.length ? `only with ${feed.include.join(', ')}` : '', feed.exclude.length ? `never with ${feed.exclude.join(', ')}` : ''].filter(Boolean).join('; ')
  return ctx.reply(`📰 Feed #${feed.id} added: new items from ${new URL(url).hostname} will show up here${filters ? ` (${filters})` : ''}.`)
}

function feedList(): string {
  if (store.state.feeds.length === 0) return 'No feeds yet. `/feed add <address>` in a channel adds one.'
  return store.state.feeds.map((f) => {
    const channel = bot.channels.find((c) => c.id === f.channelId)?.name ?? '?'
    const filters = [f.include.length ? `+${f.include.join(',')}` : '', f.exclude.length ? `-${f.exclude.join(',')}` : ''].filter(Boolean).join(' ')
    return `**#${f.id}** ${f.url} → #${channel}${filters ? ` (${filters})` : ''}${f.error ? ` ⚠️ ${f.error}` : ''}`
  }).join('\n')
}

bot.commands([
  {
    name: 'feed',
    description: 'Feeds with keyword filters: add one to this channel, list them, or remove one',
    role: 'admin',
    options: [
      { name: 'action', description: 'add, list or remove', type: 'string', required: true, choices: [
        { name: 'add', value: 'add' }, { name: 'list', value: 'list' }, { name: 'remove', value: 'remove' },
      ] },
      { name: 'target', description: 'The feed address (add) or its number (remove)', type: 'string' },
      { name: 'include', description: 'Only items with one of these words (comma-separated)', type: 'string' },
      { name: 'exclude', description: 'Never items with these words (comma-separated)', type: 'string' },
    ],
    handler: async (ctx) => {
      const [typedAction = '', typedTarget = '', ...rest] = ctx.args.trim().split(/\s+/)
      const action = String(ctx.options.action ?? typedAction).toLowerCase()
      const target = String(ctx.options.target ?? typedTarget).trim()
      if (ctx.dm) return ctx.reply('Feeds are set up in a channel: use `/feed` there.')
      if (action === 'add') {
        if (!target) return ctx.reply('Usage: `/feed add <address> [include words] [exclude words]`', { private: true })
        return addFeed(ctx, target, String(ctx.options.include ?? rest[0] ?? ''), String(ctx.options.exclude ?? rest[1] ?? ''))
      }
      if (action === 'list') return ctx.reply(feedList(), { private: true })
      if (action === 'remove') {
        const id = Number(target.replace(/^#/, ''))
        const before = store.state.feeds.length
        store.state.feeds = store.state.feeds.filter((f) => f.id !== id)
        if (store.state.feeds.length === before) return ctx.reply(`There's no feed #${target}. \`/feed list\` shows the numbers.`, { private: true })
        store.save()
        return ctx.reply(`🗑️ Feed #${id} removed.`)
      }
      return ctx.reply('Try `/feed add <address>`, `/feed list` or `/feed remove <number>`.', { private: true })
    },
  },
  {
    name: 'twitch',
    description: 'Twitch live alerts: follow a streamer yourself (a DM), or (admins) announce one in this channel',
    options: [
      { name: 'action', description: 'follow, unfollow, mine, add, remove or list', type: 'string', required: true, choices: [
        { name: 'follow', value: 'follow' }, { name: 'unfollow', value: 'unfollow' }, { name: 'mine', value: 'mine' },
        { name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' },
      ] },
      { name: 'streamer', description: 'Their Twitch name or twitch.tv link', type: 'string' },
    ],
    handler: async (ctx) => {
      const [typedAction = '', typedLogin = ''] = ctx.args.trim().split(/\s+/)
      const action = String(ctx.options.action ?? typedAction).toLowerCase()
      const raw = String(ctx.options.streamer ?? typedLogin)
      if (!twitch) return ctx.reply('Twitch alerts need the bot\'s operator to set up a Twitch app (TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET).', { private: true })
      const login = twitchLogin(raw)
      const needsLogin = ['follow', 'unfollow', 'add', 'remove'].includes(action)
      if (needsLogin && !login) return ctx.reply('Give a Twitch name, like `/twitch follow shroud`.', { private: true })
      switch (action) {
        case 'follow': {
          const result = store.follow(login!, ctx.user)
          store.save()
          if (result === 'full') return ctx.reply(`You follow ${LIMITS.followsPerPerson} streamers already: \`/twitch unfollow\` one first.`, { private: true })
          return ctx.reply(result === 'added' ? `🔔 I'll DM you when **${login}** goes live. \`/twitch unfollow ${login}\` stops it.` : `You already follow **${login}**.`, { private: true })
        }
        case 'unfollow':
          if (!store.unfollow(login!, ctx.user)) return ctx.reply(`You don't follow **${login}**.`, { private: true })
          store.save()
          return ctx.reply(`🔕 No more DMs about **${login}**.`, { private: true })
        case 'mine': {
          const mine = Object.entries(store.state.follows).filter(([, users]) => users.includes(ctx.user)).map(([l]) => l)
          return ctx.reply(mine.length ? `You follow: ${mine.join(', ')}` : 'You follow nobody yet: `/twitch follow <name>`.', { private: true })
        }
        case 'add':
        case 'remove':
        case 'list':
          if (!isStaff(ctx.user)) return ctx.reply('Only admins announce streamers in a channel. `/twitch follow` gets you a DM instead.', { private: true })
          if (action === 'list') return ctx.reply(store.state.alerts.map((a) => `${a.login} → #${bot.channels.find((c) => c.id === a.channelId)?.name ?? '?'}`).join('\n') || 'No streamers announced in channels yet.', { private: true })
          if (ctx.dm) return ctx.reply('Use this in the channel the alerts should go to.')
          if (action === 'add') {
            if (store.state.alerts.length >= LIMITS.alerts) return ctx.reply(`That's the most (${LIMITS.alerts}).`, { private: true })
            if (store.state.alerts.some((a) => a.login === login && a.channelId === ctx.channelId)) return ctx.reply('Already announced here.', { private: true })
            store.state.alerts.push({ login: login!, channelId: ctx.channelId })
            store.save()
            return ctx.reply(`📣 When **${login}** goes live, I'll say so here.`)
          }
          store.state.alerts = store.state.alerts.filter((a) => !(a.login === login && a.channelId === ctx.channelId))
          store.save()
          return ctx.reply(`**${login}** won't be announced here any more.`)
      }
      return ctx.reply('Try `/twitch follow <name>`, `/twitch mine`, or for admins `/twitch add <name>`.', { private: true })
    },
  },
])

// People who leave the server stop getting DMs: their follows are dropped.
bot.on('event', (type, body) => {
  if (type !== 'member.removed' && type !== 'member.deleted') return
  const accountKey = (body as { accountKey?: string }).accountKey
  if (!accountKey) return
  for (const login of Object.keys(store.state.follows)) store.unfollow(login, accountKey)
  store.save()
})

bot.start().then(
  () => {
    console.log(`Following ${store.state.feeds.length} feed(s), every ${minutes} minutes.${twitch ? '' : ' Twitch is off (no TWITCH_CLIENT_ID/SECRET).'}`)
    void readAll()
    setInterval(() => void readAll(), minutes * 60_000).unref()
    if (twitch) {
      void checkTwitch()
      setInterval(() => void checkTwitch(), 2 * 60_000).unref()
    }
  },
  (e: Error) => {
    console.error(`Feeds Plus couldn't start: ${e.message}`)
    process.exit(1)
  },
)

process.on('SIGINT', () => {
  bot.stop()
  process.exit(0)
})
