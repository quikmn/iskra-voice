# Starter (Python)

The [Starter](../starter/) template with the Python SDK: `/hello`, `/card` with a button, `/count` with an option, a
reaction to mentions, and tests.

```
bot.py             connects, and wires commands to the logic
commands.py        the logic, as plain functions (easy to test)
test_commands.py   tests (pytest)
requirements.txt   the SDK (from the Iskra repository) and pytest, pinned
```

## Run it

1. Copy this folder, then (Python 3.11 or newer) `python -m venv .venv`, activate it, and `pip install -r requirements.txt`.
2. Make a bot invite: in Iskra, **Bots & webhooks → Bots → Create bot invite** (role Member).
3. `ISKRA_INVITE='<bot invite link>' python bot.py` (PowerShell: `$env:ISKRA_INVITE='<link>'; python bot.py`). After
   that `python bot.py`: it remembers the server in `starter.bot.json` (keep it private; it's in `.gitignore`).
4. `python -m pytest` runs the tests.

The desktop app can run it too (My settings → **Bots on this PC** → **Run a bot from a folder**): it uses the Python
installed on your computer, which needs the packages from `requirements.txt`.

Settings: `BOT_NAME` (default Starter). The Python SDK: [docs/bots.md → Python](https://iskra.foo/docs/bots#python).

## What it keeps

Only its keys and server address, in `<name>.bot.json`.
