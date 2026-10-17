# Jukebox

A voice bot: `/play [song]` joins your voice channel and plays the audio files in a folder, and internet radio
stations you list. `/skip`, `/stop`, `/songs`, and a "Now playing" card with **Pause**, **Skip** and **Stop** buttons
it keeps up to date. Only people in its voice channel control it; it stops when everyone leaves.

**No YouTube, Spotify or other streaming services, by design.** Play files you have the right to play and streams
whose operators allow it. People only pick from what you put in the folder: Jukebox never fetches an address someone
types. For songs people upload, see the Music example (`bots/examples/music.ts`).

## Run it

Its bot invite needs **Can join voice channels**. Voice needs LiveKit's Node package and audio decoders (native code,
prebuilt for Windows x64, macOS and Linux), so Jukebox runs from the repository or your own copy rather than from the
desktop app's built-in list:

- In `bots/` of the repository: `npm install`, then `ISKRA_INVITE='<bot invite link>' npm run jukebox` the first time.
- Your own copy of this folder: `npm install` (the SDK brings the voice packages), then `ISKRA_INVITE='<link>' npm start`.
  Tests: `npm test`.
- The desktop app runs your copy too: My settings → **Bots on this PC** → **Run a bot from a folder** (after `npm install`).

## Settings

| Flag | Environment | Default | |
|---|---|---|---|
| `--dir <folder>` | `JUKEBOX_DIR` | `./music` | MP3, Ogg, FLAC or WAV files, and an optional `stations.json`: `[{ "name": "Lo-fi radio", "url": "https://example.org/stream.mp3" }]` |
| `--name <name>` | `BOT_NAME` | Jukebox | The bot's name |

## What it keeps

Nothing but its keys in `jukebox.bot.json` (keep it private). The queue lives in memory.
