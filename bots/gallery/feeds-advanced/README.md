# Feeds-advanced

Feeds with **keyword filters**, and **Twitch** alerts that people can follow for themselves.

Iskra's built-in **Feeds** bot (Server settings → Bots & webhooks → Bots) already posts RSS, YouTube and Twitch in
channels with nothing to install: start there. This bot adds what the built-in one doesn't:

- **Keyword filters:** only items with one of your words, never items with others (whole words, in the title and summary).
- **Twitch for each person:** anyone can `/twitch follow <streamer>` and gets a DM (end-to-end encrypted) when they
  go live. It uses **your own** Twitch app keys.

## Commands

| Command | Who | |
|---|---|---|
| `/feed add <address> [include] [exclude]` | admins | Follow an RSS, Atom or YouTube channel feed in this channel. Words are comma-separated: `/feed add https://blog.example/feed rust,zig` |
| `/feed list`, `/feed remove <number>` | admins | The feeds, with any error from their last read |
| `/twitch follow <name>`, `/twitch unfollow <name>`, `/twitch mine` | everyone | Your own live alerts, as DMs |
| `/twitch add <name>`, `/twitch remove <name>`, `/twitch list` | admins | Announce a streamer in this channel |

Only new items are posted (nothing old when you add a feed), at most 5 per feed per read.

## Run it

- Desktop app: My settings → **Bots on this PC** → Feeds-advanced (the Twitch keys go in its settings there).
- In `bots/` of the repository: `ISKRA_INVITE='<bot invite link>' npm run feeds-advanced` the first time.
- Your own copy of this folder: `npm install`, then `ISKRA_INVITE='<link>' npm start`. Tests: `npm test`.

## Settings

| Flag | Environment | Default | |
|---|---|---|---|
| `--minutes <n>` | `FEEDS_MINUTES` | 10 | How often feeds are read (at least 5) |
| `--data <file>` | `FEEDS_DATA` | `feeds.json` | What it remembers |
| `--name <name>` | `BOT_NAME` | Feeds Plus | The bot's name |
| | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | | Your Twitch app ([dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)). Without them Twitch is off. It asks Twitch who's live every 2 minutes. |
| | `FEEDS_ALLOW_PRIVATE=1` | off | Only for testing with a feed on your own network |

## Where it connects, and safety

The bot fetches the feed addresses admins add and, with keys, `id.twitch.tv` and `api.twitch.tv`, from **your**
computer: those sites see your IP address, like any feed reader. It never sends anything about your server or its
people. It only fetches `http(s)` addresses on the internet: addresses on your own network (localhost, 192.168.x,
10.x, …) are refused, also after a redirect, so nobody can point it at your router. Feeds are read as text (2 MB at
most, 15 seconds); pictures are never fetched.

## What it keeps

`feeds.json`: the feeds (address, channel, filters, the ids of the last 300 items it saw), the streamers announced in
channels, and who follows which streamer (account keys; removed when they unfollow or leave the server).
`feeds-plus.bot.json`: its keys. Keep both private; your Twitch secret stays in your environment.
