# Bots and webhooks

Iskra has two ways to bring other programs into your server:

| | What it is | Good for |
|---|---|---|
| **Webhook** | A secret URL that posts messages into one channel | Build results, alerts, game-server stats, anything that can send an HTTP request |
| **Bot** | A program that joins like a person: it reads channels, answers and reacts | Dice, polls, reminders, `/commands` |

Both show a **BOT** badge, so everyone can tell them apart from people. Admins manage both in **Bots & webhooks** (in the channel list).

## Webhooks

### Make one

1. Open **Bots & webhooks** → **Webhooks**.
2. Give it a name (and optionally a picture), pick the channel it posts in, and click **Create webhook**.
3. Copy the URL. It's only shown once: the server keeps a hash of the secret, not the secret itself. Lost it? Click **New URL** (the old one stops working right away).

Treat the URL like a password: anyone who has it can post in that channel. Use the `https://` address when your server has one.

### Post a message

```sh
curl -H "Content-Type: application/json" \
  -d '{"content": "Build **passed** ✅"}' \
  https://chat.example.com/hooks/<id>/<secret>
```

The body uses the same fields as a Discord webhook, so tools that can post to Discord usually work by pasting the Iskra URL instead:

```jsonc
{
  "content": "Deploy finished",            // up to 4000 characters, formatting like chat
  "username": "Deploy bot",                // optional: a different name for this message
  "embeds": [{                             // optional: up to 10 cards
    "title": "v1.4.2 is live", "url": "https://example.com/changelog",
    "description": "3 fixes, 1 new map", "color": 5763719,
    "fields": [{ "name": "Region", "value": "EU", "inline": true }],
    "footer": { "text": "deploy #812" }, "timestamp": "2026-10-10T12:00:00Z"
  }],
  "allowed_mentions": { "parse": [] }      // optional: who may be pinged (see below)
}
```

- `?wait=true` answers with the posted message (JSON) instead of an empty `204`.
- Forms work too: `curl -d "content=hello" <url>`, or Discord's multipart `payload_json`.
- **GitHub**: in your repository's *Settings → Webhooks*, use `<url>/github` as the payload URL (content type JSON). Pushes, issues, pull requests, comments, releases and stars become short cards.
- **Grafana** and other tools with a "Discord" notification type: paste the Iskra URL as the Discord webhook URL.

What's left out on purpose: images, thumbnails and avatar URLs from the payload. Showing them would make every viewer's app fetch a third-party address (revealing their IP). Give the webhook a picture in its settings instead.

### Limits and safety

| | |
|---|---|
| Message text | Same rules as chat (1–4000 characters, no invisible control characters) |
| Embeds | Up to 10 per message, 6000 characters in total; titles 256, descriptions 4096, up to 25 fields |
| Request size | 64 KB (1 MB for `/github`) |
| Rate limit | Per webhook: 5 messages at once, then one every 2 seconds. Too fast gets `429` with `Retry-After`. |
| Mentions | Off by default: `@everyone`, `@here` and mentions of members are shown as plain text and ping nobody. Turn on **Can mention people** for a webhook you trust; the payload's `allowed_mentions` can then narrow it further. |
| Webhooks per channel | 15 |

Nobody can edit a webhook's message; admins can delete it like any other.

## Bots

A bot is an ordinary Iskra identity (its own account and device keys) that connects with the same protocol as the app and says it's a bot. The server remembers that, and:

- shows it with a **BOT** badge,
- only lets it in with a **bot invite** (made by an admin; single use), and never lets a bot invite be used by a person,
- doesn't let it join voice, create invites, or be made admin (guest, member or trusted only),
- applies the same rate limits as everyone else (2 messages a second, bursts of 10).

### Run the example bot

The [`bots/`](../bots) folder has a small SDK and **Dice**, an example bot. You need [Node.js](https://nodejs.org) 22 or newer.

1. In Iskra, open **Bots & webhooks** → **Bots**, pick a role and click **Create bot invite**. Copy the link.
2. Start the bot with it:

   ```sh
   cd bots
   npm install
   ISKRA_INVITE='<the bot invite link>' npm run dice     # PowerShell: $env:ISKRA_INVITE='<link>'; npm run dice
   ```

3. In any channel the bot can read, try `/roll 2d6`, `/coin`, `/pick pizza, tacos`, `/echo hi` or `/help`. Say "good bot" and it reacts.

The bot saves its keys and the server's address in `dice.bot.json`, so the next time `npm run dice` is enough. Keep that file private (it's the bot's identity) and back it up if you want to keep the same bot.

### Write your own

```ts
// bots/my-bot.ts
import { Bot } from './sdk/src/index'

const bot = new Bot({ name: 'Greeter', invite: process.env.ISKRA_INVITE })

bot.command('hello', 'Says hello', ({ message, reply }) => reply(`Hi ${message.authorName}!`))

bot.on('message', (message) => {
  if (message.text.includes('pizza')) void message.react('🍕')
})

await bot.start()
```

Build and run it with `node build.mjs my-bot.ts && node dist/my-bot.js` (the build bundles the SDK, which reuses the Iskra app's own crypto and connection code).

| API | What it does |
|---|---|
| `new Bot({ name, invite?, stateFile?, hearBots?, log? })` | `invite` is only needed the first time. `stateFile` defaults to `<name>.bot.json` (lowercase, spaces become dashes). Bots ignore other bots and webhooks unless `hearBots` is true, so two bots can't chat forever. |
| `bot.command(name, description, handler)` | Answers `/name args`. The handler gets `{ args, message, reply, command, bot }`. `/help` is built in. |
| `bot.on('message', m => ...)` | Every message the bot can see (not its own). `m.reply(text)`, `m.react(emoji)`, `m.authorName`, `m.channel`. |
| `bot.on('ready' \| 'memberJoined' \| 'event' \| 'status', ...)` | Connected; someone joined; any raw server event; connection state. |
| `bot.send(channelId, text, { replyTo? })` | Posts a message (waits and retries if rate-limited). |
| `bot.react(messageId, emoji)`, `bot.mention(accountKey)` | React; a mention token that shows as @Name. |
| `bot.channels`, `bot.members`, `bot.me`, `bot.channelByName(name)` | What the bot can see right now. |
| `bot.request(type, body)` | Any request from [PROTOCOL.md](../protocol/PROTOCOL.md). |
| `bot.stop()` | Disconnects. The bot reconnects by itself after network trouble until you stop it. |

### Commands

Commands are just messages, by convention:

- `/name args`: every bot that knows `name` may answer.
- `/name@BotName args`: only the bot called `BotName` answers (leave out spaces in its name).
- Bots ignore commands they don't know, so several bots can share a channel.

### Other languages

Nothing about bots is specific to Node. A bot is any client that follows [PROTOCOL.md](../protocol/PROTOCOL.md): make an Ed25519 account key and device key, certify the device, connect to `wss://<server>/ws`, and send `auth` with `profile: { name, bot: true }` and the bot invite code (the last part of the invite link).
