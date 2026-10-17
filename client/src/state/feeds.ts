// Feeds: the built-in bot's subscriptions (admins) and the Twitch app credentials (the owner). Loaded when the settings
// open; turning the bot on and off goes through builtinBots.ts like the other built-in bots.
import type { FeedFields, FeedKind, FeedSubscription, FeedTwitch } from '../core/protocol'
import { connectionFor } from './store'

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error('Not connected')
  return c
}

export function getFeeds(serverKey: string): Promise<{ subscriptions: FeedSubscription[]; twitch: FeedTwitch; max: number }> {
  return connection(serverKey).request('feeds.get', {})
}

export async function addFeed(serverKey: string, kind: FeedKind, source: string, fields: FeedFields): Promise<FeedSubscription> {
  const body = { kind, source: source.trim(), ...fields, template: fields.template.trim(), mentionRoleId: fields.mention === 'role' ? fields.mentionRoleId : null }
  return (await connection(serverKey).request('feeds.add', body)).subscription
}

export async function updateFeed(serverKey: string, id: number, patch: Partial<FeedFields & { paused: boolean }>): Promise<FeedSubscription> {
  return (await connection(serverKey).request('feeds.update', { id, ...patch })).subscription
}

export async function removeFeed(serverKey: string, id: number): Promise<void> {
  await connection(serverKey).request('feeds.remove', { id })
}

export async function checkFeed(serverKey: string, id: number): Promise<FeedSubscription> {
  return (await connection(serverKey).request('feeds.check', { id })).subscription
}

/** Empty id and secret remove them. */
export async function setTwitchApp(serverKey: string, clientId: string, clientSecret: string): Promise<FeedTwitch> {
  return (await connection(serverKey).request('feeds.twitch.set', { clientId: clientId.trim(), clientSecret: clientSecret.trim() })).twitch
}
