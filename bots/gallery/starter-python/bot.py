"""Starter (Python): a template for your own Iskra bot. Copy this folder, rename the bot, and change the commands.

    pip install -r requirements.txt                    (once; Python 3.11 or newer)
    ISKRA_INVITE='<bot invite link>' python bot.py     (first time; PowerShell: $env:ISKRA_INVITE='<link>'; python bot.py)
    python bot.py                                      (after that: it remembers the server in <name>.bot.json; keep it private)
    python -m pytest                                   (the tests in test_commands.py)

Settings: BOT_NAME (default "Starter").
"""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))  # commands.py next to this file

from commands import greeting, hello_card, tally  # noqa: E402

from iskra import Bot  # noqa: E402

bot = Bot(os.environ.get("BOT_NAME", "Starter"), invite=os.environ.get("ISKRA_INVITE"), state_file=os.environ.get("ISKRA_BOT_STATE"))


# Commands: the app lists them when people type "/", checks the options, and sends them straight to the bot.
@bot.command("hello", "Says hello")
async def hello(ctx):
    await ctx.reply(greeting(ctx.user_name, datetime.now().hour))


@bot.command("card", "Shows a card with a button")
async def card(ctx):
    await ctx.reply(hello_card(ctx.user_name))


@bot.command("count", "Counts words, separated by commas",
             options=[{"name": "words", "description": "Like: apples, pears, apples", "type": "string", "required": True}])
async def count(ctx):
    await ctx.reply(tally(str(ctx.options.get("words", ctx.args))) or "Give me some words, separated by commas.", private=True)


# The card's button.
@bot.on_component("starter:wave")
async def wave(ctx):
    await ctx.reply(f"{ctx.user_name} waves back 👋")


# Messages that mention the bot or reply to it (it doesn't read the rest of the chat unless an admin lets it).
@bot.on("message")
async def thanks(message):
    if re.search(r"\bthanks?\b", message.text, re.IGNORECASE):
        await message.react("💜")


if __name__ == "__main__":
    bot.run()
