// Typed commands for bots that take interactions: the composer text becomes the command's options (checked here so the
// person hears about a typo at once; the server checks again), and who may use which command.
// Pure functions, tested in commandInvoke.test.ts.
import { roleRank, type BotCommand, type CommandOption, type Member, type OptionValue, type Role } from '../../core/protocol'

export interface InvokeLookup {
  members: { accountKey: string; name: string }[]
  /** Channels the person can read. */
  channels: { id: number; name: string }[]
  roles: { id: number; name: string }[]
}

export type ParsedOptions =
  | { ok: true; options: Record<string, OptionValue> }
  | { ok: false; option: string; reason: 'missing' | 'invalid' }

const TRUE = new Set(['true', 'yes', 'y', 'on', '1', 'ja'])
const FALSE = new Set(['false', 'no', 'n', 'off', '0', 'nej'])

/**
 * One word per option, in order; the last string option takes the rest of the text. Mentions should already be
 * tokens (`<@key>`, `<@&id>`), as the composer makes them.
 */
export function parseOptions(command: BotCommand, args: string, lookup: InvokeLookup): ParsedOptions {
  const declared = command.options ?? []
  const words = args.trim() ? args.trim().split(/\s+/u) : []
  const options: Record<string, OptionValue> = {}
  for (let i = 0; i < declared.length; i++) {
    const option = declared[i]
    const last = i === declared.length - 1
    const word = last && option.type === 'string' ? words.slice(i).join(' ') : words[i]
    if (word === undefined || word === '') {
      if (option.required) return { ok: false, option: option.name, reason: 'missing' }
      continue
    }
    const value = parseValue(option, word, lookup)
    if (value === null) return { ok: false, option: option.name, reason: 'invalid' }
    options[option.name] = value
  }
  return { ok: true, options }
}

export function parseValue(option: CommandOption, word: string, lookup: InvokeLookup): OptionValue | null {
  let value: OptionValue | null
  switch (option.type) {
    case 'string':
      value = word.length <= 1000 ? word : null
      break
    case 'integer': {
      const n = /^[+-]?\d+$/u.test(word) ? Number(word) : NaN
      value = Number.isSafeInteger(n) ? n : null
      break
    }
    case 'number': {
      const n = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/iu.test(word.replace(',', '.')) ? Number(word.replace(',', '.')) : NaN
      value = Number.isFinite(n) ? n : null
      break
    }
    case 'boolean':
      value = TRUE.has(word.toLowerCase()) ? true : FALSE.has(word.toLowerCase()) ? false : null
      break
    case 'user': {
      const token = /^<@([A-Za-z0-9_-]{43})>$/u.exec(word)?.[1]
      const name = word.replace(/^@/u, '').toLowerCase()
      value = token && lookup.members.some((m) => m.accountKey === token) ? token
        : lookup.members.find((m) => m.name.toLowerCase() === name)?.accountKey ?? null
      break
    }
    case 'channel': {
      const name = word.replace(/^#/u, '').toLowerCase()
      value = lookup.channels.find((c) => String(c.id) === word || c.name.toLowerCase() === name)?.id ?? null
      break
    }
    case 'role': {
      const id = /^<@&(\d+)>$/u.exec(word)?.[1]
      const name = word.replace(/^@/u, '').toLowerCase()
      value = lookup.roles.find((r) => (id ? String(r.id) === id : r.name.toLowerCase() === name))?.id ?? null
      break
    }
  }
  if (value === null || !option.choices?.length) return value
  // A choice may be typed by its value or its name.
  const choice = option.choices.find((c) => c.value === value || String(c.value).toLowerCase() === word.toLowerCase() || c.name.toLowerCase() === word.toLowerCase())
  return choice ? choice.value : null
}

/** Whether this person may use the command (the server checks too; apps hide the ones they can't). */
export function mayUse(command: BotCommand, me: Pick<Member, 'role'> | null | undefined, has: (permission: string) => boolean): boolean {
  if (!me) return false
  if (command.role && roleRank(me.role) < roleRank(command.role as Role)) return false
  if (command.permission && roleRank(me.role) < roleRank('admin') && !has(command.permission)) return false
  return true
}
