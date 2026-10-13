// Dice: an example Iskra bot. Rolls dice (with a "Roll again" button), flips coins, picks for you, echoes, and reacts.
//   ISKRA_INVITE='<bot invite link>' npm run dice     (first time)
//   npm run dice                                     (after that: it remembers the server in dice.bot.json)
import { Bot } from '../sdk/src/index'
import { pick, roll, rollAgain, rollCard } from './dice-rules'

const bot = new Bot({ name: 'Dice', invite: process.env.ISKRA_INVITE, stateFile: process.env.ISKRA_BOT_STATE })

// Commands are registered with the server, so the app suggests them (with their options) when someone types "/", checks
// the options, and sends them straight to the bot. The bot doesn't need to read the chat for any of this.
bot.commands([
  {
    name: 'roll',
    description: 'Rolls dice',
    options: [
      // No `choices` here: with choices, only those values are allowed (the server checks), and any dice should work.
      { name: 'dice', description: 'Like d20, 2d6 or 3d8+2 (default d6)', type: 'string' },
      { name: 'secret', description: 'Only you see the result', type: 'boolean' },
    ],
    handler: async ({ options, args, userName, react, reply }) => {
      // Options come checked from the app; `args` is the text, for commands typed by hand ("/roll 3d8+2").
      const result = roll(typeof options.dice === 'string' ? options.dice : args.split(/\s+/)[0] ?? '')
      if (!result) return reply('Try `/roll 2d6`, `/roll d20` or `/roll 3d8+2` (up to 100 dice with 2–1000 sides).', { private: true })
      await react('🎲')
      // The total in the text, the details in a card, and a button to roll the same again.
      await reply({ text: `${userName} rolled **${result.total}**`, cards: [rollCard(result)], components: rollAgain(result) },
        { private: options.secret === true })
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
    handler: ({ options, args, reply }) => reply(String(options.text ?? args)),
  },
])

// "Roll again": whoever clicks rolls the same dice, as a new message (privately, under a private roll).
bot.onComponent(/^roll:/, async ({ customId, userName, responseId, reply }) => {
  const result = roll(customId.slice('roll:'.length))
  if (!result) return
  await reply({ text: `${userName} rolled **${result.total}**`, cards: [rollCard(result)], components: rollAgain(result) },
    { private: responseId !== undefined })
})

// Messages that mention the bot or reply to it (an admin can let a bot read everything, but Dice doesn't need to).
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
