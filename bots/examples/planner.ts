// Planner: an example Iskra bot for getting friends together. Polls (results posted with a CSV when they close),
// reminders, and scheduled events. Shows replies, edits, reactions, files, polls, events and keeping state across restarts.
//   ISKRA_INVITE='<bot invite link>' npm run planner     (first time)
//   npm run planner                                      (after that: it remembers the server in planner.bot.json)
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Bot, RequestError } from '../sdk/src/index'
import { formatDuration, parseEvent, parsePoll, parseReminder, pollCsv, pollSummary } from './planner-rules'

const bot = new Bot({ name: 'Planner', invite: process.env.ISKRA_INVITE, stateFile: process.env.ISKRA_BOT_STATE })

// What the bot must not forget when it restarts: reminders it owes, and its polls that are still open.
interface Reminder { dueAt: number; channelId: number; messageId: number; confirmId: number; who: string; text: string }
interface Saved { reminders: Reminder[]; polls: number[] }
const savedFile = process.env.ISKRA_PLANNER_DATA ?? 'planner.data.json'
const saved: Saved = existsSync(savedFile) ? (JSON.parse(readFileSync(savedFile, 'utf8')) as Saved) : { reminders: [], polls: [] }
function save(): void {
  writeFileSync(`${savedFile}.tmp`, JSON.stringify(saved, null, 2))
  renameSync(`${savedFile}.tmp`, savedFile)
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

bot.command('poll', 'Starts a poll: `/poll Pizza or tacos? | Pizza | Tacos`, `/poll 2h Movie tonight?` (closes after a day unless you say)',
  async ({ args, message, reply }) => {
    const request = parsePoll(args)
    if (typeof request === 'string') return reply(request)
    const poll = await bot.poll(message.channelId, request.question, request.answers, { durationMs: request.durationMs })
    saved.polls.push(poll.id)
    save()
  })

bot.command('remind', 'Reminds you: `/remind 10m stretch your legs`, `/remind 1h30m pizza is ready`', async ({ args, message, reply }) => {
  const request = parseReminder(args)
  if (typeof request === 'string') return reply(request)
  const dueAt = Date.now() + request.inMs
  const confirm = await reply(`⏰ Okay, in ${formatDuration(request.inMs)} (at ${clock(dueAt)}).`)
  saved.reminders.push({ dueAt, channelId: message.channelId, messageId: message.id, confirmId: confirm.id, who: message.author, text: request.text })
  save()
})

bot.command('event', 'Plans an event: `/event 2h Game night`, `/event 1d Movie night @ Lounge`', async ({ args, message, reply }) => {
  const request = parseEvent(args)
  if (typeof request === 'string') return reply(request)
  const startAt = Math.ceil((Date.now() + request.inMs) / 60_000) * 60_000
  // "@ Lounge" names a voice channel if there is one, else it's just a place.
  const voice = request.place
    ? bot.channels.find((c) => (c.kind === 'voice' || c.kind === 'stage') && c.name.toLowerCase() === request.place!.toLowerCase())
    : undefined
  const { event } = await bot.request('event.create', {
    title: request.title,
    startAt,
    endAt: startAt + 2 * 3_600_000,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    location: voice ? { channelId: voice.id } : { text: request.place ?? `#${message.channel?.name ?? 'here'}` },
  })
  await message.react('📅')
  await reply(`📅 **${event.title}** is on, in ${formatDuration(startAt - Date.now())}. Mark yourself interested under Events to get a reminder.`)
})

bot.command('events', 'Lists what is coming up', async ({ reply }) => {
  const { events } = await bot.request('event.list', {})
  if (!events.length) return reply('Nothing planned yet. Try `/event 2h Game night`.')
  const lines = events.slice(0, 10).map((e) =>
    `• **${e.title}**: ${e.status === 'live' ? 'happening now' : `in ${formatDuration(e.startAt - Date.now())}`} (${e.interested.length} interested)`)
  return reply(lines.join('\n'))
})

// When one of the bot's polls closes: post the result, with who voted for what as a CSV file.
bot.on('pollUpdated', async ({ id, channelId, poll }) => {
  if (!poll.closedAt || !saved.polls.includes(id)) return
  saved.polls = saved.polls.filter((p) => p !== id)
  save()
  const nameOf = (key: string) => bot.members.get(key)?.name ?? 'someone who left'
  await bot.sendFile(channelId, { name: 'poll-results.csv', data: pollCsv(poll, nameOf) }, { text: pollSummary(poll), replyTo: id })
})

// Reminders are checked every few seconds (so long waits never overflow a timer), and late ones still go out after a restart.
async function remindDue(): Promise<void> {
  const now = Date.now()
  const due = saved.reminders.filter((r) => r.dueAt <= now)
  if (!due.length) return
  saved.reminders = saved.reminders.filter((r) => r.dueAt > now)
  save()
  for (const r of due) {
    const text = `⏰ ${bot.mention(r.who)} ${r.text}`
    try {
      await bot.send(r.channelId, text, { replyTo: r.messageId })
    } catch (e) {
      // The original message was deleted: remind without the reply. Anything else (channel gone, no access): give up.
      if (e instanceof RequestError && e.code === 'not_found') await bot.send(r.channelId, text).catch(() => undefined)
    }
    await bot.edit(r.confirmId, `⏰ Reminded you at ${clock(now)}.`).catch(() => undefined) // shows edits; fine if it's gone
  }
}

bot.on('ready', () => void bot.setActivity('planning · /help'))

bot.start().then(() => setInterval(() => void remindDue(), 5000), (e: Error) => {
  console.error(`Planner couldn't start: ${e.message}`)
  process.exit(1)
})

process.on('SIGINT', () => {
  bot.stop()
  process.exit(0)
})
