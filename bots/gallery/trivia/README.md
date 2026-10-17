# Trivia

A quiz for your server with a **weekly** scoreboard. Everyone starts at 0 each Monday; there are no levels, XP,
ranks or all-time tables.

- `/trivia start [questions]` starts a game in the channel (1-20 questions, default 5). Each question has answer
  buttons (A-E), or, for open questions, you answer by **replying** to the question. One try each; the answer and who
  got it right show when time is up (+1 point each).
- `/trivia stop` ends the game (whoever started it, or an admin). `/trivia scores` shows this week's points (only to you).
- After each game: this game's points and the week so far. When a new week starts, a results card goes to the channel
  of the last game, and the points start over.

The bot doesn't read the chat: it gets its commands, button clicks and replies to its own questions. Its bot invite
doesn't need **Can read all messages**.

## Run it

- Desktop app: My settings → **Bots on this PC** → Trivia.
- In `bots/` of the repository: `ISKRA_INVITE='<bot invite link>' npm run trivia` the first time, then `npm run trivia`.
- Your own copy of this folder: `npm install`, then `ISKRA_INVITE='<link>' npm start`. Tests: `npm test`.

## Settings

| Flag | Environment | Default | |
|---|---|---|---|
| `--questions <file>` | `TRIVIA_QUESTIONS` | the bundled `questions.json` | Your own question bank |
| `--seconds <n>` | `TRIVIA_SECONDS` | 20 | Time per question (5-120) |
| `--data <file>` | `TRIVIA_DATA` | `trivia.scores.json` | Where this week's points are kept |
| `--name <name>` | `BOT_NAME` | Trivia | The bot's name (set when it first joins) |

A question bank is a JSON array. A question with buttons has 2-5 `choices` and the index of the right `answer`
(counting from 0); an open question has the `answers` it accepts (case, accents, punctuation and a leading
"the/a/an" don't matter):

```json
[
  { "category": "Science", "question": "How many legs does a spider have?", "choices": ["6", "8", "10"], "answer": 1 },
  { "question": "Which planet is known as the Red Planet?", "answers": ["Mars"] }
]
```

## What it keeps

`trivia.scores.json`: this week's points (account key, display name and points) and the channel of the last game.
When the week's results are posted it's replaced by an empty new week, so names are kept for a week at most.
`trivia.bot.json`: the bot's own keys and server address (keep it private).
