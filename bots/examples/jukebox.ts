// Jukebox: an example voice bot. Plays the audio files in a folder (and radio streams you list) in a voice channel,
// with /play, /skip, /stop and /songs, and a "Now playing" card with buttons.
//   ISKRA_INVITE='<bot invite link>' npm run jukebox     (first time; the admin ticks "Can join voice channels")
//   npm run jukebox                                     (after that)
// Music: JUKEBOX_DIR (default ./music) with MP3, Ogg, FLAC or WAV files, plus an optional stations.json there:
//   [{ "name": "Lo-fi radio", "url": "https://example.org/stream.mp3" }]
// Play only music you have the right to play. Jukebox never fetches anything people type: only files in the folder
// and the stations you listed.
import { resolve } from 'node:path'
import { Bot } from '../sdk/src/index'
import { jukebox } from './jukebox-bot'
import { library } from './jukebox-rules'

const folder = resolve(process.env.JUKEBOX_DIR ?? 'music')
const bot = new Bot({ name: 'Jukebox', invite: process.env.ISKRA_INVITE, stateFile: process.env.ISKRA_BOT_STATE })
jukebox(bot, folder)
await bot.start()
console.log(`Playing from ${folder} (${library(folder).length} songs and stations).`)
