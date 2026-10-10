// Dice: an example Iskra bot. Rolls dice, flips coins, picks for you, echoes, and reacts.
//   ISKRA_INVITE='<bot invite link>' npm run dice     (first time)
//   npm run dice                                     (after that: it remembers the server in dice.bot.json)
import { Bot } from '../sdk/src/index'
import { describe, pick, roll } from './dice-rules'

const bot = new Bot({ name: 'Dice', invite: process.env.ISKRA_INVITE, stateFile: process.env.ISKRA_BOT_STATE })

bot.command('roll', 'Rolls dice: `/roll`, `/roll d20`, `/roll 3d6+2`', async ({ args, message, reply }) => {
  const result = roll(args)
  if (!result) return reply('Try `/roll 2d6`, `/roll d20` or `/roll 3d8+2` (up to 100 dice with 2–1000 sides).')
  await message.react('🎲')
  await reply(`${message.authorName} rolled ${describe(result)}`)
})

bot.command('coin', 'Flips a coin', ({ reply }) => reply(Math.random() < 0.5 ? '🪙 Heads!' : '🪙 Tails!'))

bot.command('pick', 'Picks one: `/pick pizza, tacos, sushi`', ({ args, reply }) => {
  const choice = pick(args)
  return reply(choice ? `I pick **${choice}**` : 'Give me at least two things, separated by commas.')
})

bot.command('echo', 'Says it back', ({ args, reply }) => (args ? reply(args) : undefined))

// Reacting to ordinary messages, not just commands.
bot.on('message', (message) => {
  if (/\bgood bot\b/i.test(message.text)) void message.react('🤖')
})

bot.on('memberJoined', (member) => {
  const general = bot.channelByName('general')
  if (general && !member.bot) void bot.send(general.id, `Welcome, ${bot.mention(member.accountKey)}! Type \`/roll\` if you feel lucky.`)
})

bot.start().catch((e: Error) => {
  console.error(`Dice couldn't start: ${e.message}`)
  process.exit(1)
})

process.on('SIGINT', () => {
  bot.stop()
  process.exit(0)
})
