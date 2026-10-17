// Your bot's logic, kept apart from the connection (bot.ts) so tests can check it without a server. Put the rules of
// your bot here as plain functions: they take what people typed and return what to answer.
import type { Card, ComponentRow } from 'iskra-bots'

/** "Good morning, Ann!" by the hour of the day (0-23). */
export function greeting(name: string, hour: number): string {
  const part = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  return `${part}, ${name}!`
}

/** A card with a button; clicks come back to bot.onComponent('starter:wave', ...). */
export function helloCard(name: string): { text: string; cards: Card[]; components: ComponentRow[] } {
  return {
    text: '',
    cards: [{ title: '👋 Hello', description: `${name} says hi to everyone.`, color: 0x695bff }],
    components: [{ type: 'row', items: [{ type: 'button', customId: 'starter:wave', label: 'Wave back', style: 'primary' }] }],
  }
}

/** "/count apples, pears, apples" → "apples ×2, pears ×1". */
export function tally(text: string): string | null {
  const words = text.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean)
  if (words.length === 0) return null
  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w, n]) => `${w} ×${n}`).join(', ')
}
