// Starboard, Birthdays and Welcome: pure helpers for their settings form and how their posts read.
import type { BirthdayConfig, BuiltinConfigs, MoreBuiltinBotId, StarboardConfig, WelcomeConfig } from '../core/protocol'

export const MORE_BUILTIN_BOTS: readonly MoreBuiltinBotId[] = ['starboard', 'birthdays', 'welcome']
export const MAX_TEMPLATE = 1000
export const MIN_THRESHOLD = 1
export const MAX_THRESHOLD = 50

export function isMoreBuiltin(id: string): id is MoreBuiltinBotId {
  return (MORE_BUILTIN_BOTS as readonly string[]).includes(id)
}

/** The welcome text as the server will fill it: {name} as the newcomer's name (a mention there), {server}, {memberCount}. */
export function fillTemplate(template: string, name: string, server: string, memberCount: number): string {
  return template.split('{name}').join(name).split('{server}').join(server).split('{memberCount}').join(String(memberCount))
}

/** "09:00"-style, as the server takes it. */
export function validTime(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
}

/** Only what changed, ready for builtin.bots.config.set (channelId null turns posting off). */
export function configPatch<K extends MoreBuiltinBotId>(saved: BuiltinConfigs[K], draft: BuiltinConfigs[K]): Partial<BuiltinConfigs[K]> {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(draft) as (keyof BuiltinConfigs[K])[]) {
    if (key === 'serverTimeZone') continue
    if (draft[key] !== saved[key]) patch[key as string] = draft[key]
  }
  return patch as Partial<BuiltinConfigs[K]>
}

/** What's wrong with a draft (an i18n key under moreBots.settings.invalid), or null. */
export function configProblem(bot: MoreBuiltinBotId, draft: StarboardConfig | BirthdayConfig | WelcomeConfig): string | null {
  if (bot === 'starboard') {
    const c = draft as StarboardConfig
    if (!Number.isInteger(c.threshold) || c.threshold < MIN_THRESHOLD || c.threshold > MAX_THRESHOLD) return 'threshold'
    if (!c.emoji.trim()) return 'emoji'
  } else if (bot === 'birthdays') {
    if (!validTime((draft as BirthdayConfig).time)) return 'time'
  } else {
    const c = draft as WelcomeConfig
    if (c.message.trim().length > MAX_TEMPLATE || c.privateMessage.trim().length > MAX_TEMPLATE) return 'template'
  }
  return null
}

/** Days in a month for a birthday (29 February allowed). */
export function daysIn(month: number): number {
  return new Date(Date.UTC(2024, month, 0)).getUTCDate()
}

/** "14 March" in the app's language (no year: birthdays never have one). */
export function birthdayLabel(month: number, day: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, month - 1, day)))
}

/** The months' names for the birthday picker. */
export function monthNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' })
  return Array.from({ length: 12 }, (_, i) => format.format(new Date(Date.UTC(2024, i, 1))))
}

/** "Anna, Bob and Cleo" in the app's language. */
export function nameList(names: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

/** Time zones to pick from (the browser's list), with the given ones first if missing. */
export function timeZones(...extra: (string | null | undefined)[]): string[] {
  let zones: string[] = []
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    zones = []
  }
  const wanted = extra.filter((z): z is string => !!z && !zones.includes(z))
  return [...wanted, ...zones]
}
