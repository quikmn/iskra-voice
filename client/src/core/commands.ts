// The bot command convention (see docs/bots.md): a message "/name args", or "/name@BotName args" to pick one bot.
// Shared by the bot SDK; the server doesn't treat commands specially.

export interface Command {
  /** Lower-cased command name, without the slash. */
  name: string
  /** The bot named after "@", if any. */
  target: string | null
  /** Everything after the name, trimmed. */
  args: string
}

/** The command a message invokes, by the bot convention "/name args" or "/name@Bot args". */
export function parseCommand(text: string): Command | null {
  const match = /^\/([A-Za-z0-9][\w-]{0,31})(?:@(\S{1,32}))?(?:\s+([\s\S]*))?$/u.exec(text.trim())
  if (!match) return null
  return { name: match[1].toLowerCase(), target: match[2] ?? null, args: (match[3] ?? '').trim() }
}
