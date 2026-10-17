# Bot gallery

Ready-made Iskra bots you can run as they are or copy and change. Each folder is a small bot with its own README,
tests and `package.json`. They run on **your** computer or server and connect out to your Iskra server like the app
does; nothing is hosted for you and nothing listens on a port.

| Bot | What it does | Needs |
|---|---|---|
| [Trivia](trivia/) | `/trivia start`: questions with answer buttons (or answers by reply), points for the week, a results card every Monday. No levels or XP. | A bot invite |
| [Feeds-advanced](feeds-advanced/) | RSS, Atom and YouTube feeds with keyword filters; Twitch "went live" alerts in a channel or as a DM to each person who follows a streamer. | A bot invite; your own Twitch app for Twitch |
| [Server stats](server-stats/) | A weekly card: members, new people, messages per channel. Counts only. | A bot invite with **Can read all messages** for full counts |
| [Jukebox](jukebox/) | Plays the music in a folder and radio stations you list in a voice channel. | A bot invite with **Can join voice channels**; the voice packages |
| [Starter](starter/) | A template: commands, a card with a button, tests and a GitHub Actions workflow. Copy it to start your own. | A bot invite |
| [Starter (Python)](starter-python/) | The same template with the Python SDK. | Python 3.11+ |

## Run one

**In the desktop app:** My settings → **Bots on this PC** → pick a gallery bot, give it a bot invite (the app can make
one on a server where you're an admin) and press **Start**. The app runs it with its own built-in Node.js, so there's
nothing to install; it can start with the app.

**From this repository** (Node.js 22.18 or newer), in `bots/`:

```sh
npm install
ISKRA_INVITE='<bot invite link>' npm run trivia      # first time; after that just: npm run trivia
```

(`npm run feeds-advanced`, `npm run server-stats`, `npm run jukebox`, `npm run starter`; PowerShell:
`$env:ISKRA_INVITE='<link>'; npm run trivia`.)

**As your own copy:** copy the folder anywhere, then `npm install` and `ISKRA_INVITE='<link>' npm start`. Node runs
the TypeScript directly (`node bot.ts`), with the SDK from npm ([`iskra-bots`](https://www.npmjs.com/package/iskra-bots)).
`npm test` runs its tests.

Each bot keeps its keys in `<name>.bot.json` next to where it runs: that file *is* the bot, so keep it private and out
of git. Settings come from command-line flags or environment variables; each README lists them.
