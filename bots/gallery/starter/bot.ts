// Starter: a template for your own Iskra bot. Copy this folder, rename the bot, and change the commands.
//   npm install                                  (once, in a copy of this folder)
//   ISKRA_INVITE='<bot invite link>' npm start   (first time; PowerShell: $env:ISKRA_INVITE='<link>'; npm start)
//   npm start                                    (after that: it remembers the server in <name>.bot.json; keep that file private)
//   npm test                                     (the tests in commands.test.ts)
// Settings: --name / BOT_NAME (default "Starter").
import { Bot } from 'iskra-bots'
import { greeting, helloCard, tally } from './commands.ts'

/** `--name value` on the command line, else the environment variable, else the default. */
function setting(flag: string, env: string, fallback: string): string {
  const at = process.argv.indexOf(`--${flag}`)
  return (at >= 0 ? process.argv[at + 1] : undefined) ?? process.env[env] ?? fallback
}

const bot = new Bot({ name: setting('name', 'BOT_NAME', 'Starter'), invite: process.env.ISKRA_INVITE, stateFile: process.env.ISKRA_BOT_STATE })

// Commands: the app lists them when people type "/", checks the options, and sends them straight to the bot.
bot.commands([
  { name: 'hello', description: 'Says hello', handler: ({ userName, reply }) => reply(greeting(userName, new Date().getHours())) },
  { name: 'card', description: 'Shows a card with a button', handler: ({ userName, reply }) => reply(helloCard(userName)) },
  {
    name: 'count',
    description: 'Counts words, separated by commas',
    options: [{ name: 'words', description: 'Like: apples, pears, apples', type: 'string', required: true }],
    handler: ({ options, args, reply }) => reply(tally(String(options.words ?? args)) ?? 'Give me some words, separated by commas.', { private: true }),
  },
])

// The card's button: answer only the person who clicked.
bot.onComponent('starter:wave', ({ userName, reply }) => reply(`${userName} waves back 👋`))

// Messages that mention the bot or reply to it (it doesn't read the rest of the chat unless an admin lets it).
bot.on('message', (message) => {
  if (/\bthanks?\b/i.test(message.text)) void message.react('💜')
})

bot.start().catch((e: Error) => {
  console.error(`${bot.name} couldn't start: ${e.message}`)
  process.exit(1)
})

process.on('SIGINT', () => {
  bot.stop()
  process.exit(0)
})
