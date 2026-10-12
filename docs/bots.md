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
- keeps it out of voice, DMs, group DMs and calls, and doesn't let it create invites, schedule messages or be made admin (guest, member or trusted only),
- applies the same rate limits as everyone else (2 messages a second, bursts of 10).

A bot can be given [roles](../protocol/PROTOCOL.md#roles-and-permissions) like anyone else, so a moderation bot can get *Manage messages* or *Kick members*. As for people, it can only act on members ranked below it, and a bot is never ranked above trusted.

Bots and webhooks stay out of **end-to-end encrypted channels**: a bot holds no channel keys and never counts as a reader there, so it can't read or post in them (the SDK skips their messages), and webhooks can't post into them. A bot can read and post in a voice channel's text chat like in any channel it can see.

### Your first bot in 5 minutes

You need [Node.js](https://nodejs.org) 22 or newer, [Git](https://git-scm.com), and a server where you're an admin. Any server works, including one you run on your own computer.

1. **Get the SDK.** It lives in the Iskra repository, next to the app code it reuses:

   ```sh
   git clone https://github.com/quikmn/iskra-voice.git
   cd iskra-voice/bots
   npm install
   ```

2. **Make a bot invite.** In Iskra, open **Bots & webhooks** → **Bots**, choose **Member** as the bot's role (a guest usually can't post) and click **Create bot invite**. Copy the link. It works once, for 7 days.

3. **Write the bot.** Save this as `bots/my-bot.ts`:

   ```ts
   import { Bot } from './sdk/src/index'

   const bot = new Bot({ name: 'Greeter', invite: process.env.ISKRA_INVITE })

   bot.command('hello', 'Says hello', ({ message, reply }) => reply(`Hi ${message.authorName}!`))

   bot.on('message', (message) => {
     if (message.text.includes('pizza')) void message.react('🍕')
   })

   await bot.start()
   ```

4. **Start it** with the invite link:

   ```sh
   node build.mjs my-bot.ts
   ISKRA_INVITE='<the bot invite link>' node dist/my-bot.js
   ```

   In PowerShell: `$env:ISKRA_INVITE='<the bot invite link>'; node dist/my-bot.js`. It prints `[Greeter] Online in "<server>" as Greeter (member)`.

5. **Try it.** Type `/hello` in a channel, or `/help` to see every command. Mention pizza and it reacts.

The bot saves its keys and the server's address in `greeter.bot.json`, so from now on `node dist/my-bot.js` is enough (no invite). Keep that file private: it *is* the bot. Run `node build.mjs my-bot.ts` again after each change. The build bundles the SDK, which reuses the Iskra app's own crypto and connection code.

### The example bots

| | Run it | What it shows |
|---|---|---|
| **Dice** ([`examples/dice.ts`](../bots/examples/dice.ts)) | `npm run dice` | `/roll 2d6`, `/coin`, `/pick pizza, tacos`, `/echo`; reacting to "good bot"; welcoming new members |
| **Planner** ([`examples/planner.ts`](../bots/examples/planner.ts)) | `npm run planner` | `/poll Pizza or tacos? \| Pizza \| Tacos` (posts the result and a CSV file when it closes), `/remind 10m stretch`, `/event 2h Game night`, `/events`; edits, files, polls, events, an activity, and keeping state across restarts |

Start either one the first time with `ISKRA_INVITE='<bot invite link>' npm run planner` (PowerShell: `$env:ISKRA_INVITE='<link>'; npm run planner`). Each needs its own bot invite.

### The SDK

| API | What it does |
|---|---|
| `new Bot({ name, invite?, stateFile?, hearBots?, log? })` | `invite` is only needed the first time. `stateFile` defaults to `<name>.bot.json` (lowercase, spaces become dashes). Bots ignore other bots and webhooks unless `hearBots` is true, so two bots can't chat forever. |
| `bot.command(name, description, handler)` | Answers `/name args`. The handler gets `{ args, message, reply, command, bot }`. `/help` is built in and lists the descriptions. |
| `bot.on('message', m => ...)` | Every message the bot can see (not its own). `m.text`, `m.author`, `m.authorName`, `m.channel`, `m.attachments`, `m.reply(text)`, `m.react(emoji)`. |
| `bot.on('messageEdited' \| 'messageDeleted' \| 'reactions' \| 'pollUpdated', ...)` | A message was edited or deleted; a message's reactions changed (the whole new list); someone voted or a poll closed. |
| `bot.on('ready' \| 'memberJoined' \| 'event' \| 'status', ...)` | Connected (again); someone joined; any raw server event; connection state. |
| `bot.send(channelId, text, { replyTo?, attachments? })` | Posts a message (up to 4000 characters; waits and retries if rate-limited). A thread's id works as a channel id. |
| `bot.edit(messageId, text)`, `bot.delete(messageId)` | Edit the bot's own message; delete its own (or others', with *Manage messages* and a higher rank). |
| `bot.react(messageId, emoji, on?)` | Add a reaction (`on = false` takes it away). Server emoji as `<:name:id>` (ids from `emoji.list`). |
| `bot.sendFile(channelId, { name, data }, { text?, replyTo? })`, `bot.upload({ name, data })` | Send a file (`data` is a string or bytes), or upload one to attach later with `send(..., { attachments: [file.id] })`. |
| `bot.poll(channelId, question, answers, { multi?, durationMs? })` | Start a poll; votes arrive as `pollUpdated`. |
| `bot.thread(messageId, name)` | Start a thread from a message. |
| `bot.setActivity(text \| null)` | Show an activity under the bot's name. |
| `bot.mention(accountKey)` | A mention token that shows as @Name and notifies them. |
| `bot.channels`, `bot.members`, `bot.me`, `bot.channelByName(name)` | What the bot can see right now (kept up to date). |
| `bot.request(type, body)` | Any request in [PROTOCOL.md](../protocol/PROTOCOL.md), typed: events (`event.create`), pins (`chat.pin`), roles (`member.roles.set`), search and so on. Errors are `RequestError`s with a `code` (`forbidden`, `not_found`, `rate_limited`, …). |
| `bot.stop()` | Disconnects. The bot reconnects by itself after network trouble or a server restart until you stop it. |

### Commands

Commands are just messages, by convention:

- `/name args`: every bot that knows `name` may answer.
- `/name@BotName args`: only the bot called `BotName` answers (leave out spaces in its name).
- Bots ignore commands they don't know, so several bots can share a channel.

Everyone in the channel sees the command and the answer, like any message. A command that throws is logged on the bot's console (with the error code) and doesn't stop the bot.

### What bots can't do (yet)

- **Voice:** bots can't join voice channels, so no music bots for now.
- **DMs:** DMs are end-to-end encrypted to people's devices, so bots can't send or read them.
- **Encrypted channels:** see above.
- **Cards (embeds):** only webhooks can post them; a bot's messages are text, files, polls, stickers and GIFs.
- **Private answers, buttons and menus:** there are no "only you can see this" replies or clickable message components yet; answers are ordinary messages.

### When it won't start

| The bot says | What to do |
|---|---|
| `That doesn't look like an Iskra invite link.` | Copy the whole link from **Bots & webhooks → Bots**; it contains `#/join/`. |
| `No server yet: start the bot once with a bot invite link …` | First start: set `ISKRA_INVITE`. Already ran it? You're in another folder, so it can't find its `<name>.bot.json`. |
| `The server didn't accept this invite. A bot needs a bot invite …` | You used an invite for people, or a bot invite that was already used or expired. Make a new **bot** invite. |
| `This bot is no longer a member of the server …` | An admin removed it. Make a new bot invite and start it with that (it keeps its keys). |
| `forbidden` errors in the log | The bot's role can't do that there: check the channel's write level, or give the bot a role. |
| `rate_limited` | The SDK already waits and retries sends; slow down loops that call `bot.request` directly. |

### Other languages

Nothing about bots is specific to Node. A bot is any client that follows [PROTOCOL.md](../protocol/PROTOCOL.md): make an Ed25519 account key and device key, certify the device, connect to `wss://<server>/ws`, and send `auth` with `profile: { name, bot: true }` and the bot invite code (the last part of the invite link).
