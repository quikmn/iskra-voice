// "/" in the composer: which bot commands match what's typed, what picking one inserts, and which option comes next.
// Pure functions (tested in commandMatch.test.ts); the popup is CommandSuggest.tsx.
import type { BotCommand, CommandOption } from '../../core/protocol'

export interface CommandEntry {
  /** The bot's account key. */
  bot: string
  botName: string
  command: BotCommand
  /** The bot takes it as an interaction (sent with `interaction.invoke`, not as a message). */
  interactions?: boolean
  /** Handled by the app itself (appCommands.ts), never sent. */
  app?: boolean
}

/** What the composer text means for suggestions. */
export type CommandQuery =
  | { kind: 'name'; query: string; target: string | null }
  | { kind: 'args'; name: string; target: string | null; args: string }

/** The command being typed: only when the message starts with "/" and the caret is in it. */
export function commandQueryAt(text: string, caret: number): CommandQuery | null {
  if (!text.startsWith('/') || text.includes('\n')) return null
  const head = /^\/([\w-]{0,32})(?:@(\S{0,32}))?/u.exec(text)
  if (!head) return null
  if (caret <= head[0].length && text.length === head[0].length) {
    return { kind: 'name', query: head[1].toLowerCase(), target: head[2] ?? null }
  }
  if (caret !== text.length) return null // hints only follow the end of the text
  if (!/\s/u.test(text[head[0].length] ?? '')) return null
  return { kind: 'args', name: head[1].toLowerCase(), target: head[2] ?? null, args: text.slice(head[0].length).replace(/^\s+/u, '') }
}

/**
 * Which bot a typed command goes to instead of being posted (null: post it as a message). `listed` is the command from
 * this channel's suggestions, `unlisted` finds one before they've loaded. In an encrypted channel a command leaves the
 * encryption, so only one whose suggestion (with that note) is on screen goes to a bot: never an unlisted one, and not
 * after Esc closed it; otherwise it stays an encrypted message.
 */
export function commandTarget(
  listed: CommandEntry | null, encrypted: boolean, closed: boolean, unlisted: () => CommandEntry | null,
): CommandEntry | null {
  if (listed) return listed.interactions && !(encrypted && closed) ? listed : null
  return encrypted ? null : unlisted()
}

/** A bot's name as it can follow "@" (no spaces). */
export const botHandle = (name: string) => name.replace(/\s+/gu, '')

const sameBot = (entry: CommandEntry, target: string | null) =>
  target === null || target === '' || botHandle(entry.botName).toLowerCase().startsWith(target.toLowerCase())

/** Commands whose name starts with the query come first, then ones that contain it; at most `limit`. */
export function matchCommands(entries: CommandEntry[], query: string, target: string | null = null, limit = 8): CommandEntry[] {
  const q = query.toLowerCase()
  const score = (e: CommandEntry) => (e.command.name.startsWith(q) ? 0 : e.command.name.includes(q) ? 1 : 2)
  return entries
    .filter((e) => score(e) < 2 && sameBot(e, target))
    .sort((a, b) => score(a) - score(b) || a.command.name.localeCompare(b.command.name) || a.botName.localeCompare(b.botName))
    .slice(0, limit)
}

/** The text that picking a command puts in the composer: "/roll " (or "/roll@Dice " when two bots share the name). */
export function completeCommand(entry: CommandEntry, entries: CommandEntry[]): string {
  const shared = entries.some((e) => e.bot !== entry.bot && e.command.name === entry.command.name)
  return `/${entry.command.name}${shared ? `@${botHandle(entry.botName)}` : ''} `
}

/** The command an "args" query refers to. */
export function findCommand(entries: CommandEntry[], name: string, target: string | null): CommandEntry | null {
  return entries.find((e) => e.command.name === name && (target === null || botHandle(e.botName).toLowerCase() === target.toLowerCase())) ?? null
}

/** "/roll <dice> [times]", or the usage hint when the bot gave one. */
export function signature(command: BotCommand): string {
  if (command.usage) return `/${command.name} ${command.usage}`
  const options = (command.options ?? []).map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`))
  return [`/${command.name}`, ...options].join(' ')
}

/**
 * Which option is being typed: one word per option, except that the last string option takes the rest.
 * Returns its index and the word typed so far, or null when every option is filled in.
 */
export function activeOption(command: BotCommand, args: string): { index: number; option: CommandOption; word: string } | null {
  const options = command.options ?? []
  if (options.length === 0) return null
  const words = args.split(/\s+/u)
  const index = Math.min(words.length - 1, options.length - 1)
  const option = options[index]
  if (words.length > options.length && option.type !== 'string') return null
  const word = index === options.length - 1 && option.type === 'string' ? words.slice(index).join(' ') : words[index]
  return { index, option, word }
}

/** An option's choices that start with what's typed. */
export function matchChoices(option: CommandOption, word: string): { name: string; value: string | number }[] {
  const w = word.toLowerCase()
  return (option.choices ?? []).filter((c) => String(c.value).toLowerCase().startsWith(w) || c.name.toLowerCase().startsWith(w))
}

/** The composer text with the word being typed replaced by a choice's value. */
export function completeChoice(text: string, word: string, value: string | number): string {
  return `${text.slice(0, text.length - word.length)}${value} `
}
