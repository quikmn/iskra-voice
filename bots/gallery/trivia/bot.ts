// Trivia: a quiz bot from the Iskra bot gallery, with a weekly scoreboard (no levels or XP). See README.md.
//   ISKRA_INVITE='<bot invite link>' npm run trivia     (in bots/; first time)
//   npm run trivia                                     (after that: it remembers the server in trivia.bot.json)
// Settings (flag or environment variable): --questions / TRIVIA_QUESTIONS (a JSON file; default: questions.json next
// to this file), --seconds / TRIVIA_SECONDS (time per question, default 20), --data / TRIVIA_DATA (where the weekly
// points are kept, default trivia.scores.json).
import { resolve } from 'node:path'
import { Bot, type AnswerContext } from 'iskra-bots'
import {
  gameOverCard, loadQuestions, parseQuestions, pickQuestions, questionCard, revealCard, Round, Scoreboard, weeklyCard, type Question,
} from './trivia.ts'
import bundled from './questions.json' with { type: 'json' }

/** `--name value` on the command line, else the environment variable, else the default. */
function setting(flag: string, env: string, fallback: string): string {
  const at = process.argv.indexOf(`--${flag}`)
  return (at >= 0 ? process.argv[at + 1] : undefined) ?? process.env[env] ?? fallback
}

const questionsFile = setting('questions', 'TRIVIA_QUESTIONS', '')
const seconds = Math.min(120, Math.max(5, Number(setting('seconds', 'TRIVIA_SECONDS', '20')) || 20))
const scoresFile = resolve(setting('data', 'TRIVIA_DATA', 'trivia.scores.json'))

// The question bank: your own file if you name one, else the questions that come with the bot (questions.json).
const bank = questionsFile ? loadQuestions(resolve(questionsFile)) : parseQuestions(JSON.stringify(bundled))
for (const problem of bank.problems) console.warn(`Question bank: ${problem}`)
if (bank.questions.length === 0) {
  console.error('Trivia has no questions: check the question file.')
  process.exit(1)
}

const bot = new Bot({ name: setting('name', 'BOT_NAME', 'Trivia'), invite: process.env.ISKRA_INVITE, stateFile: process.env.ISKRA_BOT_STATE })
const board = new Scoreboard(scoresFile)

/** One game per channel: its questions, the one being asked, and this game's points. */
interface Game {
  starter: string
  questions: Question[]
  number: number
  round: Round | null
  /** The message of the question being asked (replies to it are answers). */
  messageId: number | null
  points: Map<string, { name: string; points: number }>
  stopped: boolean
}
const games = new Map<number, Game>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function play(channelId: number, game: Game): Promise<void> {
  for (let i = 0; i < game.questions.length && !game.stopped; i++) {
    const q = game.questions[i]
    game.number = i + 1
    game.round = new Round(q)
    const posted = await bot.send(channelId, questionCard(q, game.number, game.questions.length, seconds))
    game.messageId = posted.id
    // Wait for the time to run out (or the game to be stopped), checking every half second.
    for (let waited = 0; waited < seconds * 1000 && !game.stopped; waited += 500) await sleep(500)
    const winners = game.round.close()
    for (const w of winners) {
      const mine = game.points.get(w.user) ?? { name: w.name, points: 0 }
      mine.points += 1
      game.points.set(w.user, mine)
      board.add(w.user, w.name, 1, channelId)
    }
    await bot.edit(posted.id, revealCard(q, game.number, game.questions.length, winners)).catch(() => undefined)
    if (i + 1 < game.questions.length && !game.stopped) await sleep(3000)
  }
  games.delete(channelId)
  await bot.send(channelId, { cards: [gameOverCard(game.points, board.standings())] })
}

const isStaff = (user: string) => ['admin', 'owner'].includes(bot.members.get(user)?.role ?? '')

bot.commands([
  {
    name: 'trivia',
    description: 'Trivia: start a game, stop it, or see this week\'s scores',
    options: [
      { name: 'action', description: 'start, stop or scores', type: 'string', required: true, choices: [
        { name: 'start', value: 'start' }, { name: 'stop', value: 'stop' }, { name: 'scores', value: 'scores' },
      ] },
      { name: 'questions', description: 'How many questions (1-20, default 5)', type: 'integer' },
    ],
    handler: async (ctx) => {
      const [typedAction, typedCount] = ctx.args.trim().split(/\s+/)
      const action = String(ctx.options.action ?? typedAction ?? '').toLowerCase()
      if (ctx.dm) return ctx.reply('Trivia is played in a channel: try `/trivia start` there.')
      if (action === 'start') return start(ctx, Number(ctx.options.questions ?? typedCount ?? 5))
      if (action === 'stop') return stop(ctx)
      if (action === 'scores') return ctx.reply({ cards: [{ title: '📋 Trivia this week', description: board.standings().slice(0, 10).map((r) => `${r.place}. ${r.name}: ${r.points}`).join('\n') || 'No points yet this week.', color: 0xf5a524 }] }, { private: true })
      return ctx.reply('Try `/trivia start`, `/trivia stop` or `/trivia scores`.', { private: true })
    },
  },
])

async function start(ctx: AnswerContext, wanted: number): Promise<unknown> {
  if (games.has(ctx.channelId)) return ctx.reply('A game is already on in this channel.', { private: true })
  const count = Math.min(20, Math.max(1, Number.isFinite(wanted) ? Math.round(wanted) : 5))
  const game: Game = { starter: ctx.user, questions: pickQuestions(bank.questions, count), number: 0, round: null, messageId: null, points: new Map(), stopped: false }
  games.set(ctx.channelId, game)
  await ctx.reply(`🎉 ${ctx.userName} started trivia: ${game.questions.length} questions, ${seconds} seconds each. Get ready!`)
  await sleep(2000)
  void play(ctx.channelId, game).catch((e: Error) => {
    games.delete(ctx.channelId)
    console.error(`Trivia stopped: ${e.message}`)
  })
}

function stop(ctx: AnswerContext): Promise<unknown> {
  const game = games.get(ctx.channelId)
  if (!game) return ctx.reply('No game is on in this channel.', { private: true })
  if (game.starter !== ctx.user && !isStaff(ctx.user)) return ctx.reply('Only whoever started the game (or an admin) can stop it.', { private: true })
  game.stopped = true
  return ctx.reply(`⏹ ${ctx.userName} stopped the game.`)
}

// Answer buttons: "trivia:<question number>:<choice>". Only the person who clicked hears back.
bot.onComponent(/^trivia:\d+:\d+$/, async (ctx) => {
  const [, number, choice] = ctx.customId.split(':')
  const game = games.get(ctx.channelId)
  const round = game && game.number === Number(number) ? game.round : null
  const result = round ? round.choose(ctx.user, ctx.userName, Number(choice)) : 'closed'
  const answer = { locked: 'Locked in! 🔒', again: 'You already answered this one.', closed: 'Too late for this question.' }[result]
  await ctx.reply(answer, { private: true })
})

// Open questions: replies to the question message (a bot gets replies to its own messages without reading the chat).
bot.on('message', (message) => {
  const game = games.get(message.channelId)
  if (!game?.round || !message.replyTo || message.replyTo.id !== game.messageId) return
  const result = game.round.reply(message.author, message.authorName, message.text)
  if (result === 'right' || result === 'wrong') void message.react('📝') // counted; the answer is shown when time is up
})

// Once a week: the results card for the week that ended, in the channel of the last game; then everyone starts at 0.
async function weekly(): Promise<void> {
  const before = board.standings()
  const finished = board.rollover()
  if (!finished || finished.channelId === null) return
  await bot.send(finished.channelId, { cards: [weeklyCard(finished, before)] }).catch((e: Error) => console.error(`Couldn't post the weekly results: ${e.message}`))
}
setInterval(() => void weekly(), 10 * 60_000).unref()

bot.start().then(
  () => {
    console.log(`${bank.questions.length} questions; this week's points are kept in ${scoresFile}.`)
    void weekly()
  },
  (e: Error) => {
    console.error(`Trivia couldn't start: ${e.message}`)
    process.exit(1)
  },
)

process.on('SIGINT', () => {
  bot.stop()
  process.exit(0)
})
