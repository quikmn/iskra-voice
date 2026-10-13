# Bots and webhooks

Iskra has two ways to bring other programs into your server:

| | What it is | Good for |
|---|---|---|
| **Webhook** | A secret URL that posts messages into one channel | Build results, alerts, game-server stats, anything that can send an HTTP request |
| **Bot** | A program that joins like a person: it answers `/commands`, buttons and forms, and posts | Dice, polls, reminders, games, role pickers |

Both show a **BOT** badge, so everyone can tell them apart from people. Admins manage both in **Server settings → Bots & webhooks**. No programming needed? Turn on a [built-in bot](#built-in-bots).

For server owners: [hosting.md → Bots and webhooks](hosting.md#bots-and-webhooks). How bots and webhooks are kept in check: [security.md → Webhooks and bots](security.md#webhooks-and-bots). Where your server sends things: [Who Iskra talks to](privacy-connections.md).

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

## Outgoing webhooks

The other way round: your server POSTs to a web address when something happens, for things that don't want to hold a
connection open (a Minecraft chat bridge, Home Assistant, IFTTT, a small script).

In **Server settings → Bots & webhooks → Outgoing**, pick a name, the `https://` address, the events and (for messages
and reactions) the channels. Events: a new message, a reaction added, a member joined or left, a scheduled event started.
Copy the **signing secret** shown once (**New secret** makes another). **Send a test** posts a `ping`, and **Log** shows
the last 50 attempts (status only, never what was sent). Every member can see the webhook's host under
**My settings → Privacy & data → Who Iskra talks to**.

Each request is JSON (the shape is in [PROTOCOL.md](../protocol/PROTOCOL.md#outgoing-webhooks)):

```json
{ "id": "3q2-7wAAAQ...", "type": "message.created", "timestamp": 1760000000000, "server": { "name": "Friends" },
  "data": { "message": { "id": 42, "channel": { "id": 1, "name": "general", "kind": "text", "parentId": null },
            "author": { "accountKey": "...", "name": "Alice", "bot": false }, "text": "hello", "createdAt": 1760000000000,
            "replyTo": null, "attachments": [] } } }
```

### Check the signature

Every request carries `Iskra-Webhook-Id`, `Iskra-Webhook-Timestamp` (Unix seconds) and
`Iskra-Webhook-Signature: v1=<hex>`, the HMAC-SHA256 of `iskra-webhook-v1\n<timestamp>\n<id>\n<raw body>` (`\n` is a newline) keyed with
the secret's UTF-8 bytes. Check it on the raw body (before parsing), compare in constant time, and refuse timestamps more than five
minutes off. Retries keep the same id, so you can skip ids you've already handled.

```js
// Node 18+
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verify(secret, headers, rawBody) {
  const id = headers['iskra-webhook-id'], ts = headers['iskra-webhook-timestamp'], sig = headers['iskra-webhook-signature'] ?? ''
  if (!id || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false
  const expected = 'v1=' + createHmac('sha256', secret).update(`iskra-webhook-v1\n${ts}\n${id}\n${rawBody}`).digest('hex')
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}
```

```python
# Python 3
import hashlib, hmac, time

def verify(secret: str, headers, raw_body: bytes) -> bool:
    msg_id, ts = headers.get("Iskra-Webhook-Id", ""), headers.get("Iskra-Webhook-Timestamp", "")
    if not msg_id or not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        return False
    signed = f"iskra-webhook-v1\n{ts}\n{msg_id}\n".encode() + raw_body
    expected = "v1=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(headers.get("Iskra-Webhook-Signature", ""), expected)
```

Check: with the secret `whs_test`, timestamp `1760000000`, id `abc` and the body `{"type":"ping"}`, the signature is
`v1=61117e1080d5aed00a4e39e279580b31eabbedd00eda8331228b580fb2308c28` (the server tests check this vector).

### Delivery and safety

| | |
|---|---|
| Addresses | `https://` only, and only public addresses: the server checks the address after looking up the name, on every connection, and never follows redirects. Private, loopback, link-local and cloud metadata addresses are refused. |
| Your own network | For a receiver at home (Home Assistant on `192.168.x.x`, something on the same PC or on Tailscale), the **owner** can tick **Allow addresses on my own network** for that webhook; plain `http://` then works for those addresses only. Link-local and metadata addresses stay blocked. |
| Answer | Any `2xx` within 10 seconds. The body of your answer is ignored. |
| Retries | `408`, `429`, `5xx`, timeouts and network errors: again after 5 s, 30 s, 2 min and 10 min (with the same id). Other answers aren't retried. Order isn't guaranteed. |
| Turning off | After 10 deliveries in a row that failed (after their retries), the webhook turns itself off and admins are told. Turn it on again in its settings. |
| Rate | Per webhook: 30 events at once, then 5 a second, 100 waiting at most; more are skipped (and logged). |
| Never sent | Anything from end-to-end encrypted channels, direct messages and group chats (the server can't read them), and messages posted by incoming webhooks. |
| Per server | 10 outgoing webhooks |
| The secret | The server keeps each signing secret to sign with, so it's in the server's database and its backups. Keep backups private, and make a **New secret** if one may have leaked. |

## Built-in bots

Three small bots come with every server and run inside it, so there's nothing to install, host or keep running. An
admin turns each one on in **Server settings → Bots & webhooks → Bots**:

| Bot | Command | Does |
|---|---|---|
| **Dice** | `/roll 2d6+3`, `/roll d20` | Rolls dice (up to 100 dice and 10 terms; `/roll` alone is `1d6`). |
| **Polls** | `/poll Pizza or tacos? \| Pizza \| Tacos` | Starts a normal poll in a text channel (2–10 answers). |
| **Reminders** | `/remind me in 10m take the pizza out` | Reminds you about that message later (1 minute up to a year), like any reminder. |

Turned on, each is a bot member like any other: give it a role or channel overrides to choose where it answers. It
reads only its own commands, answers mistakes privately to the person who typed them, and stays out of encrypted
channels. Turning it off removes it; turning it on again brings back the same member. Details:
[PROTOCOL.md → Built-in bots](../protocol/PROTOCOL.md#built-in-bots).

## Bots

A bot is an ordinary Iskra identity (its own account and device keys) that connects with the same protocol as the app and says it's a bot. The server remembers that, and:

- shows it with a **BOT** badge,
- only lets it in with a **bot invite** (made by an admin; single use), and never lets a bot invite be used by a person,
- keeps it out of voice, DMs, group DMs and calls, and doesn't let it create invites, schedule messages or be made admin (guest, member or trusted only),
- applies the same rate limits as everyone else (2 messages a second, bursts of 10).

**What a bot can read** is the admin's choice when making the bot invite (**Can read all messages**, off by default),
and can be changed later in **Bots & webhooks → Bots**; everyone can see it (`readsMessages` on the member). By default
a bot gets only:

- its commands, button clicks and forms ([interactions](#commands)),
- messages that mention it, reply to one of its messages, or start with one of its commands (`/roll …`),
- its own messages.

It doesn't get the rest of the chat, and requests that read it (history, search, pins, threads, forum posts, docs) are
refused with `bot_no_read`. Most bots never need more; turn it on for a bot that has to read along (a logger, a
translator). Bots that joined before this choice existed keep reading everything until an admin changes it.

A bot can be given [roles](../protocol/PROTOCOL.md#roles-and-permissions) like anyone else, so a moderation bot can get *Manage messages* or *Kick members*. As for people, it can only act on members ranked below it, and a bot is never ranked above trusted.

Bots and webhooks stay out of **end-to-end encrypted channels**: a bot holds no channel keys and never counts as a reader there, so it can't read or post in them (the SDK skips their messages), and webhooks can't post into them. Commands still work there, privately: see [Commands in encrypted channels](#commands-in-encrypted-channels). A bot can read and post in a voice channel's text chat like in any channel it can see.

### Your first bot in 5 minutes

You need [Node.js](https://nodejs.org) 22 or newer, [Git](https://git-scm.com), and a server where you're an admin. Any server works, including one you run on your own computer.

1. **Get the SDK.** It lives in the Iskra repository, next to the app code it reuses:

   ```sh
   git clone https://github.com/quikmn/iskra-voice.git
   cd iskra-voice/bots
   npm install
   ```

2. **Make a bot invite.** In Iskra, open **Bots & webhooks** → **Bots**, choose **Member** as the bot's role (a guest usually can't post), leave **Can read all messages** off (this bot doesn't need it) and click **Create bot invite**. Copy the link. It works once, for 7 days.

3. **Write the bot.** Save this as `bots/my-bot.ts`:

   ```ts
   import { Bot } from './sdk/src/index'

   const bot = new Bot({ name: 'Greeter', invite: process.env.ISKRA_INVITE })

   bot.commands([
     { name: 'hello', description: 'Says hello', handler: ({ userName, reply }) => reply(`Hi ${userName}!`) },
     {
       name: 'score',
       description: 'Shows a score card',
       options: [{ name: 'team', description: 'Which team', type: 'string', required: true }],
       handler: ({ options, reply }) => reply({
         cards: [{ title: `Team ${options.team}`, color: 0x57f287, fields: [{ name: 'Points', value: '12', inline: true }] }],
         components: [{ type: 'row', items: [{ type: 'button', customId: 'cheer', label: 'Cheer 🎉' }] }],
       }),
     },
   ])

   // Someone clicked the button: answer only them.
   bot.onComponent('cheer', ({ userName, reply }) => reply(`${userName} cheers!`, { private: true }))

   // Messages that mention the bot (it doesn't read the rest of the chat).
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

5. **Try it.** Type `/` in a channel: the app lists Greeter's commands. Pick `/hello`, or `/score` (it shows the
   `<team>` option as you type) and see the card; click **Cheer 🎉**. `/help` lists every command (only you see that
   answer). Mention `@Greeter` with the word pizza and it reacts.

The bot saves its keys and the server's address in `greeter.bot.json`, so from now on `node dist/my-bot.js` is enough (no invite). Keep that file private: it *is* the bot. Run `node build.mjs my-bot.ts` again after each change. The build bundles the SDK, which reuses the Iskra app's own crypto and connection code.

### The example bots

| | Run it | What it shows |
|---|---|---|
| **Dice** ([`examples/dice.ts`](../bots/examples/dice.ts)) | `npm run dice` | `/roll 2d6` (answers with a card and a **Roll again** button; `/roll d20 yes` answers only you), `/coin`, `/pick pizza, tacos`, `/echo`; commands with options; a button handler; reacting to "good bot" when mentioned; welcoming new members |
| **Planner** ([`examples/planner.ts`](../bots/examples/planner.ts)) | `npm run planner` | `/poll Pizza or tacos? \| Pizza \| Tacos` (posts the result and a CSV file when it closes), `/remind 10m stretch`, `/event 2h Game night`, `/events` (a card); usage hints, edits, files, polls, events, an activity, and keeping state across restarts |

Start either one the first time with `ISKRA_INVITE='<bot invite link>' npm run planner` (PowerShell: `$env:ISKRA_INVITE='<link>'; npm run planner`). Each needs its own bot invite.

### The SDK

| API | What it does |
|---|---|
| `new Bot({ name, invite?, stateFile?, hearBots?, log? })` | `invite` is only needed the first time. `stateFile` defaults to `<name>.bot.json` (lowercase, spaces become dashes). Bots ignore other bots and webhooks unless `hearBots` is true, so two bots can't chat forever. |
| `bot.command(name, description, handler, { usage?, options?, role?, permission? }?)` | Answers `/name`. The handler gets `{ options, args, user, userName, channelId, reply, defer, showModal, react, interaction, message?, command, bot }` (see [Commands](#commands)). `/help` is built in and lists the descriptions. |
| `bot.commands([{ name, description, usage?, options?, role?, permission?, handler }, ...])` | Several commands at once. Every command is registered with the server when the bot connects, so the app suggests it when people type `/` and sends it straight to the bot. |
| `reply(content, { private? })`, `defer()`, `showModal(modal)` | In command, button and form handlers: answer in public (a message that says who asked) or only to the asker; "thinking…" for slow work; show a [form](#buttons-menus-and-forms). Up to 5 answers per interaction, within 15 minutes. |
| `bot.onComponent(customId or /pattern/, ctx => ...)` | A click on one of the bot's buttons or select menus: `{ customId, values, user, userName, messageId?, reply, update, defer, showModal }`. `update(content)` replaces the message the button is on. |
| `bot.onModalSubmit(customId or /pattern/, ctx => ...)` | A form the bot showed, filled in: `{ customId, fields, user, userName, reply, defer }`. |
| `bot.on('message', m => ...)` | Messages the bot may read (not its own): by default those that mention it, reply to it or start with one of its commands; every message it can see if an admin let it [read all messages](#bots). `m.text`, `m.author`, `m.authorName`, `m.channel`, `m.attachments`, `m.reply(text)`, `m.react(emoji)`. |
| `bot.on('messageEdited' \| 'messageDeleted' \| 'reactions' \| 'pollUpdated', ...)` | A message was edited or deleted; a message's reactions changed (the whole new list); someone voted or a poll closed. |
| `bot.on('ready' \| 'memberJoined' \| 'event' \| 'status', ...)` | Connected (again); someone joined; any raw server event; connection state. |
| `bot.send(channelId, text, { replyTo?, attachments?, cards?, components? })` or `bot.send(channelId, { text?, cards?, components?, attachments?, replyTo? })` | Posts a message (up to 4000 characters; waits and retries if rate-limited), optionally with [cards](#cards) and [buttons or a menu](#buttons-menus-and-forms). A thread's id works as a channel id. `reply(...)` takes the same. |
| `bot.edit(messageId, text)` or `bot.edit(messageId, { text?, cards?, components? })`, `bot.delete(messageId)` | Edit the bot's own message (cards and components replace the old ones, `[]` removes them); delete its own (or others', with *Manage messages* and a higher rank). |
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

A bot describes its commands; the SDK does it each time the bot connects (`bot.commands.set` in
[PROTOCOL.md](../protocol/PROTOCOL.md#bot-interactions)). When someone types `/` at the start of a message, the app
lists the commands of the bots that can answer in that channel: the bot, the command and its description. Arrow keys
move, Tab or Enter complete, Esc closes. After the name it shows the options as hints (`/roll <dice> [times]`) and an
option's choices to pick from.

**Sending a command doesn't post it.** The app checks the options and sends the command straight to the bot as an
*interaction*; the server checks them again, and who may use the command where. The channel only shows the bot's
answer, with "Viktor used /roll" above it. The rest of the channel never sees the command, and the bot doesn't need to
read the chat to get it.

```ts
bot.commands([{
  name: 'roll',
  description: 'Rolls dice',                    // one line, up to 100 characters in the app (/help shows it all)
  options: [                                    // up to 25; required ones first
    { name: 'dice', description: 'Like 2d6', type: 'string', required: true },
    { name: 'times', description: 'How often', type: 'integer' },
    { name: 'secret', description: 'Only you see it', type: 'boolean' },
  ],
  role: 'member',                               // optional: the lowest level that may use it
  handler: async ({ options, userName, reply }) => {
    // options: { dice: '2d6', times: 3, secret: true }, checked by the server
    await reply(`${userName} asked for ${options.dice}`, { private: options.secret === true })
  },
}])
```

- **Options** are typed: `string` (1–1000 characters, one line), `integer`, `number`, `boolean` (yes/no), `user` (an
  account key), `channel` (a channel id) and `role` (a role id). People type them in order, one word each; the last
  text option takes the rest of the line (`/say #general hello there`). With `choices` (up to 25) only those values are
  accepted, so leave choices out when any value should work and put examples in the description. `args` holds the
  text as typed, for bots that parse it themselves (or give a `usage` line instead of options:
  `usage: 'Pizza or tacos? | Pizza | Tacos'`).
- **Who may use it**: `role` (`member`, `trusted` or `admin`) and `permission` (like `manageMessages`) are enforced by
  the server, and the app doesn't list commands someone can't use. Which channels a bot answers in follows its own
  roles: it must be able to post there, so admins limit a bot with roles and channel permissions like anyone else.
- **Answers**: `reply(...)` posts a message, or with `{ private: true }` shows it only to the person who asked (never
  stored; they can dismiss it). Answer within about 3 seconds, or call `defer()` first: the app shows "Dice is
  thinking…" until you reply. An interaction takes up to 5 answers within 15 minutes; its token works only for this
  bot and this one interaction.
- An offline bot can't be asked (the app says so). A handler that throws is logged on the bot's console (with the error
  code) and doesn't stop the bot.

Typing a command as plain text still works, for bots that don't take interactions and from older apps: a message
`/name args` (or `/name@BotName args` to pick one bot) reaches the bot as a message, and the handler gets the same
context with `message` set and empty `options`. Bots ignore commands they don't know, so several bots can share a
channel. Limits: 50 commands per bot, names of 1–32 characters (`a–z`, `0–9`, `_`, `-`), 16 KB for the whole list.

#### Commands in encrypted channels

In an [end-to-end encrypted channel](../protocol/PROTOCOL.md#end-to-end-encrypted-channels) the server can't read the
messages and bots aren't in the channel's chain. Commands still work there, without leaking anything:

- The app lists commands of bots that take interactions and can read the channel by their roles, and says before you
  send: "Commands go to the bot unencrypted, not through this channel. Only you will see the answer." The command and
  its options go to the bot like any request; the channel's messages and keys never do.
- Every answer is private: shown only to you, never stored, so nothing unencrypted lands in the channel.

### Buttons, menus and forms

Bot messages (and private answers) can carry up to 5 rows of **components**: up to 5 buttons per row, or one select
menu. A click goes to the bot as an interaction; the bot answers like a command, or `update`s the message.

```ts
await reply({
  text: 'Game night: who is in?',
  components: [
    { type: 'row', items: [
      { type: 'button', customId: 'rsvp:yes', label: "I'm in", style: 'success' },
      { type: 'button', customId: 'rsvp:no', label: "Can't", style: 'danger' },
      { type: 'button', label: 'Rules', style: 'link', url: 'https://example.com/rules' },
    ] },
    { type: 'row', items: [{ type: 'select', customId: 'game', placeholder: 'Pick a game', maxValues: 2, options: [
      { label: 'Catan', value: 'catan' }, { label: 'Codenames', value: 'codenames' }, { label: 'Uno', value: 'uno' },
    ] }] },
  ],
})

bot.onComponent(/^rsvp:/, ({ customId, userName, update }) => update(`${userName} said ${customId.slice(5)}`))
bot.onComponent('game', ({ values, reply }) => reply(`You picked ${values.join(' and ')}`, { private: true }))

// A form, shown to the person who used the command (or clicked).
bot.command('plan', 'Plans a game night', ({ showModal }) => showModal({
  customId: 'plan', title: 'Plan a game night',
  fields: [{ customId: 'title', label: 'Title', maxLength: 60 }, { customId: 'notes', label: 'Notes', style: 'paragraph', required: false }],
}))
bot.onModalSubmit('plan', ({ fields, reply }) => reply(`📅 ${fields.title} is planned`))
```

| | Limits |
|---|---|
| Rows | Up to 5; a row has 1–5 buttons or one select menu |
| `customId` | 1–100 printable ASCII characters, unique in the message |
| Buttons | `label` 1–80 characters; `style` `primary`, `secondary` (default), `success`, `danger` or `link`. A link button has a `url` (http/https) instead of a `customId`: the app shows the address and opens it only when clicked, and the bot never hears of it |
| Select menus | 1–25 options (`label`, `value`, `description?`, `default?`); `minValues` 0–25 and `maxValues` 1–25 (default 1) |
| Forms | A `title` (up to 45 characters) and 1–5 fields (`short`: one line, up to 1000 characters, default 200; `paragraph`: up to 4000); each form can be sent once |
| All components | 8 KB per message |

Only bots can add components, and only to their own messages. The server checks every click before the bot hears of
it: the button must really be on the message and enabled, and picked values must be the menu's own.

### Cards

Bots can attach cards to their messages, in the same format and with the same limits as [webhook embeds](#post-a-message):
a title (with a link), a description, fields, a colour, an author, a footer and a time.

```ts
await message.reply({
  text: 'Your roll',                            // optional when there are cards
  cards: [{
    title: '🎲 2d6', description: '**7**', color: 0x695bff,
    fields: [{ name: 'Dice', value: '3, 4', inline: true }],
    thumbnail: { url: picture.url },            // a file the bot uploaded: const picture = await bot.upload({ name, data })
    footer: { text: 'Good luck' },
  }],
})
```

Unlike webhooks, cards can have a `thumbnail` and an `image`, but only from the server itself: a file the bot uploaded
(`bot.upload`, then use its `url`) or a small `data:image/png|jpeg|gif|webp;base64,...` URL (up to 16 KB). Addresses on
other sites are refused, so nobody's app ever loads something from a third party. Only bots can send cards.

### What bots can't do (yet)

- **Voice:** bots can't join voice channels, so no music bots for now.
- **DMs:** DMs are end-to-end encrypted to people's devices, so bots can't send or read them.
- **Encrypted channels:** bots can't read or post there; commands work, with private answers (see above).

### When it won't start

| The bot says | What to do |
|---|---|
| `That doesn't look like an Iskra invite link.` | Copy the whole link from **Bots & webhooks → Bots**; it contains `#/join/`. |
| `No server yet: start the bot once with a bot invite link …` | First start: set `ISKRA_INVITE`. Already ran it? You're in another folder, so it can't find its `<name>.bot.json`. |
| `The server didn't accept this invite. A bot needs a bot invite …` | You used an invite for people, or a bot invite that was already used or expired. Make a new **bot** invite. |
| `This bot is no longer a member of the server …` | An admin removed it. Make a new bot invite and start it with that (it keeps its keys). |
| `forbidden` errors in the log | The bot's role can't do that there: check the channel's write level, or give the bot a role. |
| `The server didn't take the command list (bad_request): …` | A command, option or choice breaks a [limit](#commands); the message says which. Commands still work as text. |
| Its commands don't show up when typing `/` | The bot must be able to read **and** post in that channel (in an encrypted channel: read it). Commands with a `role` or `permission` show only for people who have it. |
| `forbidden` with `bot_no_read` | The bot was invited without **Can read all messages**, so it gets its commands and mentions only. An admin can change that in **Bots & webhooks → Bots**. |
| `Nothing answers the button "…"` in the log | Add a `bot.onComponent(...)` for that `customId` (or a pattern that matches it). |
| `rate_limited` | The SDK already waits and retries sends; slow down loops that call `bot.request` directly. |

### Other languages

Nothing about bots is specific to Node. A bot is any client that follows [PROTOCOL.md](../protocol/PROTOCOL.md): make an Ed25519 account key and device key, certify the device, connect to `wss://<server>/ws`, and send `auth` with `profile: { name, bot: true }` and the bot invite code (the last part of the invite link).
