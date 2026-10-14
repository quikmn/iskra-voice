// Music: an example voice bot that plays the songs people upload, with a queue.
//   ISKRA_INVITE='<bot invite link>' npm run music     (first time; the admin ticks "Can join voice channels")
//   npm run music                                     (after that)
// People add songs by attaching audio files (MP3, Ogg, FLAC, WAV) to a message that mentions @Music, by sending them to
// the bot in a DM, or with `/play <link to a file on this server>`. /queue, /skip, /pause, /resume, /stop, /volume,
// /remove, /clear; admins choose who may control it with /music-control. Optional: your own songs and radio streams in
// MUSIC_DIR (default ./music; a stations.json there lists streams: [{ "name": "Lo-fi radio", "url": "https://..." }]).
// It never plays YouTube, Spotify or any address someone types, only files on the server and what you put in MUSIC_DIR.
import { dirname, join, resolve } from 'node:path'
import { Bot } from '../sdk/src/index'
import { music } from './music-bot'

const stateFile = resolve(process.env.ISKRA_BOT_STATE ?? 'music.bot.json')
const bot = new Bot({ name: 'Music', invite: process.env.ISKRA_INVITE, stateFile })
music(bot, { folder: resolve(process.env.MUSIC_DIR ?? 'music'), settingsFile: join(dirname(stateFile), 'music.settings.json') })

bot.start().catch((e: Error) => {
  console.error(`Music couldn't start: ${e.message}`)
  process.exit(1)
})

process.on('SIGINT', () => {
  bot.stop()
  process.exit(0)
})
