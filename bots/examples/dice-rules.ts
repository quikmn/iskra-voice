// The dice bot's rules, kept apart from the bot so they're easy to test.
import type { Card, ComponentRow } from '../sdk/src/index'

export interface Roll {
  count: number
  sides: number
  modifier: number
  rolls: number[]
  total: number
}

/** "d20", "2d6", "3d8+2", "d100-5". Null if it isn't dice notation (or is silly: at most 100 dice of 2–1000 sides). */
export function roll(spec: string, random: () => number = Math.random): Roll | null {
  const match = /^(\d{0,3})d(\d{1,4})([+-]\d{1,4})?$/i.exec(spec.trim() || 'd6')
  if (!match) return null
  const count = match[1] ? Number(match[1]) : 1
  const sides = Number(match[2])
  const modifier = match[3] ? Number(match[3]) : 0
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(random() * sides))
  return { count, sides, modifier, rolls, total: rolls.reduce((a, b) => a + b, 0) + modifier }
}

export function describe(r: Roll): string {
  const mod = r.modifier ? ` ${r.modifier > 0 ? '+' : '-'} ${Math.abs(r.modifier)}` : ''
  const shown = r.rolls.length > 20 ? `${r.rolls.slice(0, 20).join(', ')}, …` : r.rolls.join(' + ')
  const notation = `${r.count}d${r.sides}${r.modifier ? (r.modifier > 0 ? '+' : '') + r.modifier : ''}`
  return r.rolls.length === 1 && !r.modifier ? `${notation}: **${r.total}**` : `${notation}: ${shown}${mod} = **${r.total}**`
}

/** "pizza, tacos, sushi" or "pizza or tacos" → one of them. */
export function pick(options: string, random: () => number = Math.random): string | null {
  const items = options.split(/,|\bor\b/).map((s) => s.trim()).filter(Boolean)
  return items.length < 2 ? null : items[Math.floor(random() * items.length)]
}

/** A roll as a card: the notation and total, every die in a field (up to 25 shown). */
export function rollCard(r: Roll): Card {
  const notation = `${r.count}d${r.sides}${r.modifier ? (r.modifier > 0 ? '+' : '') + r.modifier : ''}`
  const shown = r.rolls.length > 25 ? `${r.rolls.slice(0, 25).join(', ')}, …` : r.rolls.join(', ')
  return {
    title: `🎲 ${notation}`,
    description: `**${r.total}**`,
    color: r.rolls.every((x) => x === r.sides) ? 0x57f287 : r.rolls.every((x) => x === 1) ? 0xed4245 : 0x695bff,
    fields: [
      { name: r.count === 1 ? 'Die' : 'Dice', value: shown, inline: true },
      ...(r.modifier ? [{ name: 'Modifier', value: `${r.modifier > 0 ? '+' : ''}${r.modifier}`, inline: true }] : []),
    ],
  }
}

/** "2d6+1": what was rolled, as dice notation. */
export const notation = (r: Roll) => `${r.count}d${r.sides}${r.modifier ? (r.modifier > 0 ? '+' : '') + r.modifier : ''}`

/** The "Roll again" button under a roll: its customId says what to roll ("roll:2d6"). */
export function rollAgain(r: Roll): ComponentRow[] {
  return [{ type: 'row', items: [{ type: 'button', customId: `roll:${notation(r)}`, label: 'Roll again', style: 'primary' }] }]
}
