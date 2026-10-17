// Tags, Suggestions, Giveaways and Counting: their settings (admins), tags, suggestion votes and decisions, giveaway
// entries, and your own state on the cards you see (fetched in batches). Turning them on and off goes through
// builtinBots.ts like the other built-in bots.
import { create } from 'zustand'
import type { Bots3Configs, Bots3Id, CardsMine, GiveawayStatus, SuggestionStatus, Tag } from '../core/protocol'
import { connectionFor, onWelcomeHook } from './store'

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error('offline')
  return c
}

// ── Settings ─────────────────────────────────────────────────────────────

export async function getBots3Config<K extends Bots3Id>(serverKey: string, bot: K): Promise<Bots3Configs[K]> {
  const { config } = await connection(serverKey).request('builtin.bots.config.get', { bot } as never)
  return config as unknown as Bots3Configs[K]
}

export async function setBots3Config<K extends Bots3Id>(serverKey: string, bot: K, patch: Partial<Bots3Configs[K]>): Promise<Bots3Configs[K]> {
  const { config } = await connection(serverKey).request('builtin.bots.config.set', { bot, ...patch } as never)
  return config as unknown as Bots3Configs[K]
}

// ── Tags ─────────────────────────────────────────────────────────────────

export async function listTags(serverKey: string): Promise<{ tags: Tag[]; max: number; canManage: boolean }> {
  return connection(serverKey).request('tags.list', {})
}

export async function saveTag(serverKey: string, name: string, text: string): Promise<Tag> {
  return (await connection(serverKey).request('tags.set', { name, text })).tag
}

export async function removeTag(serverKey: string, name: string): Promise<void> {
  await connection(serverKey).request('tags.remove', { name })
}

// ── Suggestions ──────────────────────────────────────────────────────────

export async function createSuggestion(serverKey: string, text: string): Promise<{ messageId: number; channelId: number }> {
  return connection(serverKey).request('suggestion.create', { text })
}

export async function voteSuggestion(serverKey: string, messageId: number, vote: 1 | -1 | 0): Promise<void> {
  const result = await connection(serverKey).request('suggestion.vote', { messageId, vote })
  setMine(serverKey, (m) => ({ ...m, votes: { ...m.votes, [messageId]: result.vote } }))
}

export async function decideSuggestion(serverKey: string, messageId: number, status: SuggestionStatus, reason: string): Promise<void> {
  await connection(serverKey).request('suggestion.decide', reason.trim() ? { messageId, status, reason: reason.trim() } : { messageId, status })
}

export async function suggestionAuthor(serverKey: string, messageId: number): Promise<string | null> {
  return (await connection(serverKey).request('suggestion.author', { messageId })).accountKey
}

export async function postSuggestPrompt(serverKey: string): Promise<void> {
  await connection(serverKey).request('suggestions.prompt', {})
}

// ── Giveaways ────────────────────────────────────────────────────────────

export async function enterGiveaway(serverKey: string, messageId: number, entered: boolean): Promise<void> {
  const result = await connection(serverKey).request('giveaway.enter', { messageId, entered })
  setMine(serverKey, (m) => ({ ...m, entered: { ...m.entered, [messageId]: result.entered } }))
}

export async function giveawayAction(serverKey: string, messageId: number, action: 'end' | 'cancel' | 'reroll'): Promise<GiveawayStatus> {
  const c = connection(serverKey)
  const result = action === 'end' ? await c.request('giveaway.end', { messageId })
    : action === 'cancel' ? await c.request('giveaway.cancel', { messageId }) : await c.request('giveaway.reroll', { messageId })
  return result.giveaway.status
}

// ── Your state on cards ──────────────────────────────────────────────────

export interface Mine {
  votes: Record<number, 1 | -1 | 0>
  entered: Record<number, boolean>
  staff: { suggestions: boolean; giveaways: boolean }
}

const EMPTY: Mine = { votes: {}, entered: {}, staff: { suggestions: false, giveaways: false } }

export const useCardsMine = create<Record<string, Mine>>(() => ({}))

function setMine(serverKey: string, change: (m: Mine) => Mine) {
  useCardsMine.setState((s) => ({ [serverKey]: change(s[serverKey] ?? EMPTY) }))
}

/** Asked-for ids per server, sent together on the next tick (at most 100 per request). */
const waiting = new Map<string, Set<number>>()
const asked = new Map<string, Set<number>>()

/** Makes sure your vote or entry on this card is known (one request for all the cards on screen). */
export function wantCard(serverKey: string, messageId: number): void {
  const done = asked.get(serverKey) ?? new Set<number>()
  asked.set(serverKey, done)
  if (done.has(messageId)) return
  done.add(messageId)
  const queue = waiting.get(serverKey) ?? new Set<number>()
  const first = queue.size === 0
  queue.add(messageId)
  waiting.set(serverKey, queue)
  if (first) setTimeout(() => void flush(serverKey), 0)
}

async function flush(serverKey: string): Promise<void> {
  const ids = [...(waiting.get(serverKey) ?? [])]
  waiting.delete(serverKey)
  const c = connectionFor(serverKey)
  if (!c) {
    for (const id of ids) asked.get(serverKey)?.delete(id)
    return
  }
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100)
    try {
      const result: CardsMine = await c.request('builtin.cards.mine', { messageIds: part })
      setMine(serverKey, (m) => mergeMine(m, part, result))
    } catch {
      for (const id of part) asked.get(serverKey)?.delete(id) // try again when the card is shown next
    }
  }
}

/** Folds a `builtin.cards.mine` answer in: the asked cards not mentioned have no vote and no entry. */
export function mergeMine(m: Mine, ids: number[], result: CardsMine): Mine {
  const votes = { ...m.votes }
  const entered = { ...m.entered }
  for (const id of ids) {
    votes[id] = result.votes[String(id)] ?? 0
    entered[id] = result.entered.includes(id)
  }
  return { votes, entered, staff: result.staff }
}

/** Forgets what was fetched (a reconnect, a role change): cards ask again. */
export function forgetCards(serverKey: string): void {
  asked.delete(serverKey)
}

onWelcomeHook((serverKey) => forgetCards(serverKey))
