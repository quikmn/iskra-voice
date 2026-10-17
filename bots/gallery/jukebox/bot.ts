// Jukebox: a voice bot from the Iskra bot gallery. Plays the audio files in a folder (and radio streams you list) in a
// voice channel, with /play, /skip, /stop and /songs, and a "Now playing" card with buttons. See README.md.
//   ISKRA_INVITE='<bot invite link>' npm run jukebox     (in bots/; first time; the admin ticks "Can join voice channels")
//   npm run jukebox                                     (after that)
// Music: --dir <folder> or JUKEBOX_DIR (default ./music) with MP3, Ogg, FLAC or WAV files, plus an optional
// stations.json there: [{ "name": "Lo-fi radio", "url": "https://example.org/stream.mp3" }]
// Play only music you have the right to play. Jukebox never fetches anything people type: only files in the folder
// and the stations you listed.
import { resolve } from 'node:path'
import { Bot } from 'iskra-bots'
import { jukebox } from './jukebox.ts'
import { library } from './rules.ts'

/** `--name value` on the command line, else the environment variable, else the default. */
function setting(flag: string, env: string, fallback: string): string {
  const at = process.argv.indexOf(`--${flag}`)
  return (at >= 0 ? process.argv[at + 1] : undefined) ?? process.env[env] ?? fallback
}

const folder = resolve(setting('dir', 'JUKEBOX_DIR', 'music'))
const bot = new Bot({ name: setting('name', 'BOT_NAME', 'Jukebox'), invite: process.env.ISKRA_INVITE, stateFile: process.env.ISKRA_BOT_STATE })
jukebox(bot, folder)
bot.start().then(
  () => console.log(`Playing from ${folder} (${library(folder).length} songs and stations).`),
  (e: Error) => {
    console.error(`Jukebox couldn't start: ${e.message}`)
    process.exit(1)
  },
)

process.on('SIGINT', () => {
  bot.stop()
  process.exit(0)
})
