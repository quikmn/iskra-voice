# Starter

A template for your own Iskra bot: three commands (`/hello`, `/card` with a button, `/count` with an option), a
reaction to mentions, tests, and a GitHub Actions workflow. Copy this folder and make it yours.

```
bot.ts                       connects, and wires commands to the logic
commands.ts                  the logic, as plain functions (easy to test)
commands.test.ts             tests (node --test)
package.json                 npm start, npm test, npm run typecheck
.github/workflows/test.yml   runs the tests on every push, once this folder is its own repository
```

## Run it

1. Copy this folder anywhere and run `npm install` (Node.js 22.18 or newer: Node runs the TypeScript itself).
2. Make a bot invite: in Iskra, **Bots & webhooks → Bots → Create bot invite** (role Member).
3. `ISKRA_INVITE='<bot invite link>' npm start` (PowerShell: `$env:ISKRA_INVITE='<link>'; npm start`). After the
   first time just `npm start`: it remembers the server in `starter.bot.json`. Keep that file private (it's in `.gitignore`).
4. `npm test` and `npm run typecheck` before you push.

The desktop app runs it too (My settings → **Bots on this PC** → Starter, or your copy with **Run a bot from a
folder**), and in `bots/` of the repository it's `npm run starter`.

Name it with `--name` or `BOT_NAME` before its first start (the name is set when it joins). The SDK:
[docs/bots.md](https://iskra.foo/docs/bots).

## What it keeps

Only its keys and server address, in `<name>.bot.json`.
