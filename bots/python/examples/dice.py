"""Dice: an example Iskra bot in Python. Rolls dice (with a "Roll again" button), flips coins, picks for you, echoes,
reacts, welcomes people and answers DMs. The same bot as bots/examples/dice.ts.

    ISKRA_INVITE='<bot invite link>' python examples/dice.py     (first time)
    python examples/dice.py                                     (after that: it remembers the server in dice.bot.json)
"""
from __future__ import annotations

import os
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))  # dice_rules next to this file

from dice_rules import pick, roll, roll_again, roll_card  # noqa: E402

from iskra import Bot  # noqa: E402

bot = Bot("Dice", invite=os.environ.get("ISKRA_INVITE"), state_file=os.environ.get("ISKRA_BOT_STATE"))


# Commands are registered with the server, so the app suggests them (with their options) when someone types "/", checks
# the options, and sends them straight to the bot. The bot doesn't need to read the chat for any of this.
@bot.command("roll", "Rolls dice", options=[
    # No "choices" here: with choices, only those values are allowed (the server checks), and any dice should work.
    {"name": "dice", "description": "Like d20, 2d6 or 3d8+2 (default d6)", "type": "string"},
    {"name": "secret", "description": "Only you see the result", "type": "boolean"},
])
async def roll_command(ctx):
    # Options come checked from the app; `args` is the text, for commands typed by hand ("/roll 3d8+2").
    dice = ctx.options.get("dice")
    result = roll(dice if isinstance(dice, str) else (ctx.args.split() or [""])[0])
    if result is None:
        await ctx.reply("Try `/roll 2d6`, `/roll d20` or `/roll 3d8+2` (up to 100 dice with 2–1000 sides).", private=True)
        return
    await ctx.react("🎲")
    # The total in the text, the details in a card, and a button to roll the same again.
    await ctx.reply({"text": f"{ctx.user_name} rolled **{result.total}**", "cards": [roll_card(result)], "components": roll_again(result)},
                    private=ctx.options.get("secret") is True)


@bot.command("coin", "Flips a coin")
async def coin(ctx):
    await ctx.reply("🪙 Heads!" if random.random() < 0.5 else "🪙 Tails!")


@bot.command("pick", "Picks one for you", usage="pizza, tacos, sushi")
async def pick_command(ctx):
    choice = pick(ctx.args)
    await ctx.reply(f"I pick **{choice}**" if choice else "Give me at least two things, separated by commas.")


@bot.command("echo", "Says it back", options=[{"name": "text", "description": "What to say", "type": "string", "required": True}])
async def echo(ctx):
    await ctx.reply(str(ctx.options.get("text", ctx.args)))


# "Roll again": whoever clicks rolls the same dice, as a new message (privately, under a private roll).
@bot.on_component(re.compile(r"^roll:"))
async def again(ctx):
    result = roll(ctx.custom_id.removeprefix("roll:"))
    if result:
        await ctx.reply({"text": f"{ctx.user_name} rolled **{result.total}**", "cards": [roll_card(result)], "components": roll_again(result)},
                        private=ctx.response_id is not None)


# Messages that mention the bot or reply to it (an admin can let a bot read everything, but Dice doesn't need to).
@bot.on("message")
async def good_bot(message):
    if re.search(r"\bgood bot\b", message.text, re.IGNORECASE):
        await message.react("🤖")


# Direct messages (end-to-end encrypted to the bot): commands work there too; anything else gets a hint.
@bot.on("dm")
async def hint(dm):
    if not dm.text.startswith("/"):
        await dm.reply("Hi! I roll dice. Try `/roll 2d6`, `/coin` or `/help`.")


@bot.on("member_joined")
async def welcome(member):
    general = bot.channel_by_name("general")
    if general and not member.get("bot"):
        await bot.send(general["id"], f"Welcome, {bot.mention(member['accountKey'])}! Type `/roll` if you feel lucky.")


if __name__ == "__main__":
    bot.run()
