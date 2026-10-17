"""Iskra bot SDK for Python. See docs/bots.md ("Python").

    from iskra import Bot

    bot = Bot("Greeter", invite=os.environ.get("ISKRA_INVITE"))

    @bot.command("hello", "Says hello")
    async def hello(ctx):
        await ctx.reply(f"Hi {ctx.user_name}!")

    bot.run()
"""
from .bot import (
    AnswerContext, Bot, CommandContext, ComponentContext, IncomingDm, IncomingMessage, ModalContext, rejection_help,
)
from .commands import Command, parse_command
from .connection import Connection, ConnectionStatus
from .dm_files import DmError, DmFile
from .errors import Rejected, RequestError
from .identity import DeviceCert, Identity, certify_device, create_identity, sign_auth, verify_device_cert
from .invite import InviteLink, parse_invite
from .state import identity_of, load_state, new_state, save_state
from .types import (
    BotCommand, Card, Channel, CommandOption, ComponentButton, ComponentRow, ComponentSelect, FileInfo, Interaction, Member,
    Message, MessageContent, Modal, ModalField, Poll, SelectOption, Thread,
)

__version__ = "0.1.0"

__all__ = [
    "AnswerContext", "Bot", "BotCommand", "Card", "Channel", "Command", "CommandContext", "CommandOption", "ComponentButton",
    "ComponentContext", "ComponentRow", "ComponentSelect", "Connection", "ConnectionStatus", "DeviceCert", "DmError", "DmFile",
    "FileInfo", "Identity", "IncomingDm", "IncomingMessage", "Interaction", "InviteLink", "Member", "Message", "MessageContent",
    "Modal", "ModalContext", "ModalField", "Poll", "Rejected", "RequestError", "SelectOption", "Thread", "certify_device",
    "create_identity", "identity_of", "load_state", "new_state", "parse_command", "parse_invite", "rejection_help", "save_state",
    "sign_auth", "verify_device_cert",
]
