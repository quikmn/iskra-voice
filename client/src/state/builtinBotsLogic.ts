// Built-in bots (Dice, Polls, Reminders): pure helpers for their command hints and how their answers read.
import type { BotCommand, BuiltinBotId, BuiltinReply } from '../core/protocol'

export const BUILTIN_BOTS: readonly BuiltinBotId[] = ['dice', 'polls', 'reminders']

type T = (key: string, args?: Record<string, unknown>) => string

/** A built-in bot's command with its description and usage in the app's language (the server's are English). */
export function localizeCommand(command: BotCommand, t: T): BotCommand {
  if (command.name !== 'roll' && command.name !== 'poll' && command.name !== 'remind') return command
  return {
    ...command,
    description: t(`builtinBots.commands.${command.name}.description`),
    usage: t(`builtinBots.commands.${command.name}.usage`),
  }
}

export interface DieFace {
  value: number
  /** The lowest or highest the die can show (worth a second look). */
  edge: 'min' | 'max' | null
}

export interface RollTerm {
  op: '+' | '-' | null
  /** "2d6", or the number added. */
  label: string
  dice: DieFace[] | null
}

/** A roll as terms to show: each group of dice with its faces, then the number added (if any). */
export function rollTerms(reply: Extract<BuiltinReply, { kind: 'roll' }>): RollTerm[] {
  const terms: RollTerm[] = reply.groups.map((g, i) => ({
    op: g.sign < 0 ? '-' : i > 0 ? '+' : null,
    label: `${g.count}d${g.sides}`,
    dice: g.rolls.map((value) => ({ value, edge: value === 1 ? 'min' : value === g.sides ? 'max' : null })),
  }))
  if (reply.modifier !== 0) terms.push({ op: reply.modifier < 0 ? '-' : '+', label: String(Math.abs(reply.modifier)), dice: null })
  return terms
}

/** The one-line answers (everything but a roll's dice), in the app's language. */
export function replyLine(reply: BuiltinReply, name: string, t: T, when: (ms: number) => string, error: (e: unknown) => string): string {
  switch (reply.kind) {
    case 'roll': return t('builtinBots.reply.roll', { name, expression: reply.expression })
    case 'roll.invalid': return t('builtinBots.reply.rollInvalid', { name, input: reply.input })
    case 'poll.usage': return t('builtinBots.reply.pollUsage', { name })
    case 'remind': return t('builtinBots.reply.remind', { name, when: when(reply.dueAt) })
    case 'remind.usage': return t('builtinBots.reply.remindUsage', { name })
    case 'error': return t('builtinBots.reply.error', { name, message: error(reply.error) })
  }
}

/** Reminder data written by the Reminders bot ("bot." + base64url JSON): the note and where it was set, or null. */
export function botReminderAbout(data: string): { note: string; where: string; at: number } | null {
  if (!data.startsWith('bot.')) return null
  try {
    const b64 = data.slice(4).replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    const at = raw.at
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return null
    return {
      note: typeof raw.note === 'string' ? raw.note.slice(0, 500) : '',
      where: typeof raw.where === 'string' ? raw.where.slice(0, 120) : '',
      at,
    }
  } catch {
    return null
  }
}
