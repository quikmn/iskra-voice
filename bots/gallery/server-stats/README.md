# Server stats

A weekly card for your server: how many members, how many joined this week, how many messages, and the busiest
channels. **Counts only:** it never keeps who wrote what, who is most active, or anything else about a person.

- Every Monday (09:00 by default, this computer's time zone) it posts last week's card in `#general` (or your
  channel). If the bot was off then, the card comes as soon as it's back.
- `/stats` shows this week so far (only to you).

To count every message it needs **Can read all messages** on its bot invite (or turned on later in Bots & webhooks →
Bots). It reads them only to add one to the channel's count. Without it, it counts only messages sent to it, and the
card says so. Bots' and webhooks' messages don't count.

## Run it

- Desktop app: My settings → **Bots on this PC** → Server stats (the invite it makes there can read all messages).
- In `bots/` of the repository: `ISKRA_INVITE='<bot invite link>' npm run server-stats` the first time.
- Your own copy of this folder: `npm install`, then `ISKRA_INVITE='<link>' npm start`. Tests: `npm test`.

## Settings

| Flag | Environment | Default | |
|---|---|---|---|
| `--channel <name>` | `STATS_CHANNEL` | general | Where the weekly card goes |
| `--hour <0-23>` | `STATS_HOUR` | 9 | Monday at this hour |
| `--data <file>` | `STATS_DATA` | `stats.json` | The counts |
| `--name <name>` | `BOT_NAME` | Stats | The bot's name |

## What it keeps

`stats.json`: this week's message count per channel id, how many joined, and last week's counts until its card is
posted. Nothing about people. `stats.bot.json`: its keys (keep it private).
