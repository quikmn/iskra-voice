# iskra-bots (Python)

Write bots for [Iskra](https://iskra.foo), the self-hosted voice and text app for friend groups, in Python.

A bot is an ordinary Iskra identity that connects like the app does, with the same signed handshake over the server's
WebSocket. It can answer `/commands` (the app suggests them as people type), post cards with buttons, menus and forms,
and talk in end-to-end encrypted DMs. The crypto is libsodium (through PyNaCl), byte for byte the protocol the app
speaks, checked against the protocol's test vectors.

Python 3.11 or newer. Dependencies: `pynacl` and `websockets`.

```sh
pip install ./bots/python        # from a clone of the repository
```

```python
import os
from iskra import Bot

bot = Bot("Greeter", invite=os.environ.get("ISKRA_INVITE"))

@bot.command("hello", "Says hello")
async def hello(ctx):
    await ctx.reply(f"Hi {ctx.user_name}!")

@bot.on("dm")
async def dm(dm):
    if not dm.text.startswith("/"):
        await dm.reply("Hi! Try /hello")

bot.run()
```

Start it once with `ISKRA_INVITE='<bot invite link>'`; it keeps its keys and the server in `greeter.bot.json` (the same
file the Node SDK uses, so a bot can switch languages). Keep that file private: it *is* the bot.

Everything else (commands with options, buttons, forms, cards, files, polls, DMs, limits): the
[bot guide](https://github.com/quikmn/iskra-voice/blob/main/docs/bots.md#python). The example Dice bot is in
`examples/dice.py`.

Tests: `pip install -e ".[test]"`, then `pytest`.
