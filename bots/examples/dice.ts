// Dice: an example Iskra bot. Rolls dice, flips coins, picks for you, echoes, and reacts.
//   ISKRA_INVITE='<bot invite link>' npm run dice     (first time)
//   npm run dice                                     (after that: it remembers the server in dice.bot.json)
import { Bot } from '../sdk/src/index'
import { pick, roll, rollCard } from './dice-rules'

const bot = new Bot({ name: 'Dice', invite: process.env.ISKRA_INVITE, stateFile: process.env.ISKRA_BOT_STATE })

// Commands are registered with the server, so the app suggests them (with their options) when someone types "/".
bot.commands([
  {
    name: 'roll',
    description: 'Rolls dice',
    options: [{ name: 'dice', description: 'Like d20, 2d6 or 3d8+2 (default d6)', type: 'string', choices: [
      { name: 'Six-sided', value: 'd6' }, { name: 'Twenty-sided', value: 'd20' }, { name: 'Two dice', value: '2d6' },
    ] }],
    handler: async ({ args, message, reply }) => {
      const result = roll(args)
      if (!result) return reply('Try `/roll 2d6`, `/roll d20` or `/roll 3d8+2` (up to 100 dice with 2–1000 sides).')
      await message.react('🎲')
      // The total in the text, the details in a card (`describe(result)` gives them as one line of text).
      await reply({
        text: `${message.authorName} rolled **${result.total}**`,
        cards: [rollCard(result)],
      })
    },
  },
  { name: 'coin', description: 'Flips a coin', handler: ({ reply }) => reply(Math.random() < 0.5 ? '🪙 Heads!' : '🪙 Tails!') },
  {
    name: 'pick',
    description: 'Picks one for you',
    usage: 'pizza, tacos, sushi',
    handler: ({ args, reply }) => {
      const choice = pick(args)
      return reply(choice ? `I pick **${choice}**` : 'Give me at least two things, separated by commas.')
    },
  },
  {
    name: 'echo',
    description: 'Says it back',
    options: [{ name: 'text', description: 'What to say', type: 'string', required: true }],
    handler: ({ args, reply }) => (args ? reply(args) : undefined),
  },
])

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
