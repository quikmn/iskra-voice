// Server stats: a bot from the Iskra bot gallery that posts a weekly card: how many members, how many joined, and
// messages per channel. Counts only: it never keeps who wrote what or who is most active. See README.md.
//   ISKRA_INVITE='<bot invite link>' npm run server-stats     (in bots/; first time)
//   npm run server-stats                                     (after that)
// For the full message count, tick "Can read all messages" on its bot invite (it reads only to count).
// Settings (flag or environment variable): --channel / STATS_CHANNEL (where the card goes, default "general"),
// --hour / STATS_HOUR (Monday at this hour, this computer's time zone, default 9), --data / STATS_DATA (default stats.json).
import { resolve } from 'node:path'
import { Bot } from 'iskra-bots'
import { Counter, statsCard, type WeekCounts } from './stats.ts'

/** `--name value` on the command line, else the environment variable, else the default. */
function setting(flag: string, env: string, fallback: string): string {
  const at = process.argv.indexOf(`--${flag}`)
  return (at >= 0 ? process.argv[at + 1] : undefined) ?? process.env[env] ?? fallback
}

const channelName = setting('channel', 'STATS_CHANNEL', 'general').replace(/^#/, '')
const hour = Math.min(23, Math.max(0, Number(setting('hour', 'STATS_HOUR', '9')) || 0))
const counter = new Counter(resolve(setting('data', 'STATS_DATA', 'stats.json')))
const bot = new Bot({ name: setting('name', 'BOT_NAME', 'Stats'), invite: process.env.ISKRA_INVITE, stateFile: process.env.ISKRA_BOT_STATE })

function card(counts: WeekCounts, partial: boolean) {
  return statsCard({
    week: counts.week,
    counts,
    members: [...bot.members.values()].filter((m) => !m.bot).length,
    channelNames: new Map(bot.channels.map((c) => [c.id, c.name])),
    readsAll: bot.me?.readsMessages === true,
    partial,
  })
}

// Counting: one number per channel. Bots' and webhooks' messages are left out (the SDK doesn't pass them on).
bot.on('message', (message) => counter.message(message.channelId))
bot.on('memberJoined', (member) => {
  if (!member.bot) counter.joinedOne()
})

bot.commands([
  {
    name: 'stats',
    description: 'Shows this week\'s numbers so far (only to you)',
    handler: ({ reply }) => {
      counter.roll()
      return reply({ cards: [card(counter.data, true)] }, { private: true })
    },
  },
])

/** Every minute: save the counts, and post last week's card once it's due. */
async function tick(): Promise<void> {
  counter.save()
  const finished = counter.due(new Date(), hour)
  if (!finished || !bot.me) return
  const channel = bot.channelByName(channelName)
  if (!channel) {
    console.error(`There's no #${channelName} I can see: set STATS_CHANNEL to the channel for the weekly card.`)
    return
  }
  try {
    await bot.send(channel.id, { cards: [card(finished, false)] })
    counter.posted()
  } catch (e) {
    console.error(`Couldn't post the weekly card: ${(e as Error).message}`)
  }
}

bot.start().then(
  () => {
    if (bot.me?.readsMessages !== true) console.log('Note: I can only count messages sent to me. Let me read all messages (Bots & webhooks → Bots) for the full count.')
    console.log(`The weekly card goes to #${channelName} on Mondays at ${hour}:00.`)
    void tick()
    setInterval(() => void tick(), 60_000).unref()
  },
  (e: Error) => {
    console.error(`Stats couldn't start: ${e.message}`)
    process.exit(1)
  },
)

function quit(): void {
  counter.save()
  bot.stop()
  process.exit(0)
}
process.on('SIGINT', quit)
process.on('SIGTERM', quit)
