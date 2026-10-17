// Which other sites this viewer has agreed to load a watch party's video from (unit-tested; no React here). The
// privacy texts promise an ask per site: with a queue, moving on to an item from another site asks again, and the host
// is only ever pre-agreed for the site of what they started themselves (not for what others queue).
import type { WatchParty } from '../core/protocol'

/** The sites agreed to for this party so far: the host's own starting site, or nothing. */
export function startedSites(party: Pick<WatchParty, 'host' | 'updatedBy' | 'updatedAt' | 'startedAt'>, me: string | null | undefined, site: string | null): ReadonlySet<string> {
  // The party as watch.start left it (nothing moved it on yet), started by me: I pasted that link.
  const mine = !!me && party.host === me && party.updatedBy === me && party.updatedAt === party.startedAt
  return mine && site ? new Set([site]) : new Set()
}

/** Ask before loading: another site, not allowed for good on this device, and not yet agreed to for this party. */
export const needsGate = (site: string | null, agreed: ReadonlySet<string>, always: boolean): boolean => !!site && !always && !agreed.has(site)

export function withAgreedSite(agreed: ReadonlySet<string>, site: string): ReadonlySet<string> {
  if (agreed.has(site)) return agreed
  return new Set([...agreed, site])
}
