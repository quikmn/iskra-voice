# iskra-bots

Write bots for [Iskra](https://iskra.foo), the self-hosted voice and text app for friend groups.

A bot is an ordinary Iskra identity that connects like the app does. It can answer `/commands` (the app suggests them
as people type), post cards with buttons, menus and forms, talk in end-to-end encrypted DMs, and play audio in voice
channels. The SDK is the app's own connection and crypto code, so a bot speaks exactly the protocol the app does.

```sh
npm install iskra-bots
```

Node.js 22 or newer.

## A bot in a few lines

```js
// greeter.mjs
import { Bot } from 'iskra-bots'

const bot = new Bot({ name: 'Greeter', invite: process.env.ISKRA_INVITE })

bot.commands([
  { name: 'hello', description: 'Says hello', handler: ({ userName, reply }) => reply(`Hi ${userName}!`) },
])

// Direct messages are end-to-end encrypted to the bot. Commands typed in a DM reach the same handlers.
bot.on('dm', (dm) => {
  if (!dm.text.startsWith('/')) void dm.reply('Hi! Try /hello')
})

await bot.start()
```

1. In Iskra, an admin opens **Server settings → Bots & webhooks → Bots** and clicks **Create bot invite**.
2. Start the bot once with that link: `ISKRA_INVITE='<link>' node greeter.mjs`
   (PowerShell: `$env:ISKRA_INVITE='<link>'; node greeter.mjs`).
3. The bot keeps its keys and the server's address in `greeter.bot.json`. Later starts need no invite. Keep that
   file private: it *is* the bot.

## What's in it

| | |
|---|---|
| Commands | `bot.command(name, description, handler, { options, role, permission })`, `bot.commands([...])` |
| Answers | `reply(text or { text, cards, components }, { private })`, `defer()`, `showModal(form)` |
| Buttons, menus, forms | `bot.onComponent(customId, ...)`, `bot.onModalSubmit(customId, ...)` |
| Messages | `bot.on('message', ...)`, `bot.send`, `bot.edit`, `bot.delete`, `bot.react`, `bot.sendFile`, `bot.poll`, `bot.thread` |
| DMs | `bot.on('dm', ...)`, `bot.sendDm(accountKey, text)`, `bot.downloadDmFile(file)` |
| Voice | `bot.joinVoice(channelId)`, then `voice.play(file, stream or bytes)`, `pause`, `resume`, `setVolume`, `stop`, `leave` |
| Anything else | `bot.request(type, body)`: every request in the protocol, typed |

The full guide, with every option and limit: [docs/bots.md](https://github.com/quikmn/iskra-voice/blob/main/docs/bots.md).
Example bots (dice, a planner, a music bot) are in [bots/examples](https://github.com/quikmn/iskra-voice/tree/main/bots/examples).

## Voice

Voice uses LiveKit's SDK for Node (`@livekit/rtc-node`, native and prebuilt for Windows x64, macOS and Linux x64/arm64)
and WebAssembly decoders for MP3, Ogg Opus, Ogg Vorbis and FLAC. They're optional dependencies: npm installs them
where it can, and a bot that never joins voice doesn't load them. An admin has to let a bot join voice.

Bots play files and streams their operator has the right to play. No YouTube, Spotify or other streaming services:
the SDK has no extractors for them and never will.

## DMs and privacy

DMs to a bot are end-to-end encrypted to the bot's own keys, so the server can't read them and whoever runs the bot
can. People can block a bot, and can turn off DMs from bots (a bot may then only answer someone who wrote to it first).

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0), like the rest of Iskra.
