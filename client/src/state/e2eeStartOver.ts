// Encrypted channels whose chain was started over (PROTOCOL.md "Starting over"). No network or store here, so it's easy to
// test: what a device does when the server shows a different chain, keeping old chains for old messages, and what the
// person is shown before they choose to start over.
//
// A device whose account is in its verified chain never switches to another chain by itself (security review M3): the
// server only starts a chain over when nobody in the old one can read the channel, so from inside the chain a new one
// looks exactly like a malicious server handing the channel to an account it controls. When the new chain verifies, it
// is kept as an offer; the person may start over by hand after looking at who signed it.
import { decryptChannelMessage, verifyChannelChain, type ChannelChange, type ChannelContent, type ChannelEnvelope, type ChannelHeader, type ChannelView } from '../core/channelChain'
import { sameKey, type GroupChange } from '../core/group'

export const CHAIN_REPLACED = "This channel's encryption was replaced by the server while you were still in it. Messages stay locked until this is sorted out."
export const STARTED_OVER = 'The people in this channel started its encryption over. Check their safety numbers before trusting new messages.'

/** A chain this device used before (kept to read the messages sent under it). */
export interface PastChain {
  chain: string
  changes: GroupChange[]
  view: ChannelView
  keys: Map<number, Uint8Array>
  endedAt: number
  /** Left by the person's own choice (start over), not because they were out of it. */
  startedOver: boolean
}

/** A different chain the server showed while this account was in its verified one. Verified, but not trusted. */
export interface StartOverOffer {
  chain: string
  changes: GroupChange[]
  view: ChannelView
  seenAt: number
}

/** "You started encryption over on …": kept with the channel, so a later swap can't pass as the same chain. */
export interface StartOverRecord {
  at: number
  from: string
  to: string
}

export interface ChainState {
  chain: string | null
  changes: GroupChange[]
  view: ChannelView | null
  keys: Map<number, Uint8Array>
  past: PastChain[]
  offer: StartOverOffer | null
  restarts: StartOverRecord[]
  problem?: string
}

export const MAX_PAST_CHAINS = 8

/**
 * Whether a new chain id may replace the one we verified without asking: only when this account isn't in it (it was
 * removed, or never in it). Inside the chain, a replacement is never taken on the server's word.
 */
export function mayReplaceChain(current: { chain: string | null; members: readonly string[] | undefined }, next: string, mine: string): boolean {
  return !current.chain || current.chain === next || !mine || !(current.members ?? []).some((m) => sameKey(m, mine))
}

function archive(rec: ChainState, now: number, startedOver: boolean): void {
  if (rec.chain && rec.view && (rec.keys.size > 0 || startedOver))
    rec.past = [{ chain: rec.chain, changes: rec.changes, view: rec.view, keys: new Map(rec.keys), endedAt: now, startedOver }, ...rec.past.filter((p) => p.chain !== rec.chain)].slice(0, MAX_PAST_CHAINS)
}

/**
 * Adds verified changes. A different chain id while this account is in the verified chain becomes an offer (and a
 * problem: sending stays off); otherwise the old chain is kept for old messages and the new one taken.
 */
export function receiveChain(rec: ChainState, chain: string, changes: GroupChange[], mine: string, now = Date.now()): void {
  if (!mayReplaceChain({ chain: rec.chain, members: rec.view?.members }, chain, mine)) {
    rec.problem = CHAIN_REPLACED // the verified chain and its keys stay as they are
    if (rec.past.some((p) => p.chain === chain)) return // a chain we left never comes back as an offer
    const same = rec.offer?.chain === chain ? rec.offer : null
    try {
      const view = verifyChannelChain(chain, changes) // the whole chain, from its creation
      rec.offer = { chain, changes: strip(changes), view, seenAt: same?.seenAt ?? now }
    } catch {
      try {
        if (same) rec.offer = { ...same, view: verifyChannelChain(chain, changes, same.view), changes: [...same.changes, ...strip(changes)] }
      } catch {
        /* doesn't verify: nothing to offer */
      }
    }
    return
  }
  if (rec.chain !== chain) {
    archive(rec, now, false)
    rec.chain = chain
    rec.changes = []
    rec.view = null
    rec.keys = new Map()
  }
  try {
    rec.view = verifyChannelChain(chain, changes, rec.view)
    rec.changes = [...rec.changes, ...strip(changes)]
    rec.problem = undefined
  } catch (e) {
    rec.problem = (e as Error).message
  }
}

const strip = (changes: GroupChange[]) => changes.map(({ payload, sig }) => ({ payload, sig }))

/**
 * The person chose to start over: the offered chain becomes the verified one, the old chain and its keys are kept for
 * old messages, and the choice is recorded. Only ever called from an explicit action.
 */
export function acceptStartOver(rec: ChainState, now = Date.now()): StartOverRecord {
  const offer = rec.offer
  if (!offer) throw new Error('There is nothing to start over with.')
  const record: StartOverRecord = { at: now, from: rec.chain ?? '', to: offer.chain }
  archive(rec, now, true)
  rec.chain = offer.chain
  rec.changes = offer.changes
  rec.view = offer.view
  rec.keys = new Map()
  rec.offer = null
  rec.problem = undefined
  rec.restarts = [...rec.restarts, record].slice(-20)
  return record
}

/** The chain (current or kept) a message's envelope was sent under, with the keys this device has for it. */
export function chainFor(rec: ChainState, chain: string): { view: ChannelView; keys: Map<number, Uint8Array> } | null {
  if (rec.view && rec.view.chain === chain) return { view: rec.view, keys: rec.keys }
  const past = rec.past.find((p) => p.chain === chain)
  return past ? { view: past.view, keys: past.keys } : null
}

/** Decrypts a message with whichever chain it was sent under (old messages keep working after a start-over). */
export function decryptInChain(rec: ChainState, envelope: ChannelEnvelope, routed: { from: string; version: number }): (ChannelContent & { header: ChannelHeader }) | null {
  const chain = typeof envelope?.header?.chain === 'string' ? envelope.header.chain : rec.view?.chain ?? ''
  const found = chainFor(rec, chain)
  if (!found) return null
  return decryptChannelMessage(envelope, routed, found.view, (v) => found.keys.get(v))
}

// ── What the person sees before starting over ──────────────────────────────

/** Why a signer's key can be trusted: it was in your old chain, or it's a friend's or DM contact's key you knew. */
export type SignerTrust = 'old-chain' | 'contact' | 'new'

export interface Signer {
  key: string
  /** Made the new chain's first change. */
  created: boolean
  trust: SignerTrust
  /** Key transparency has a serious finding about this key. */
  warning: boolean
}

export interface StartOverCheck {
  signers: Signer[]
  /** The new chain lists you (someone added you); until then there's nothing to read. */
  listed: boolean
  /** New keys that carry the name of someone from your old chain. */
  lookalikes: string[]
  /** Starting over is refused (a serious key warning, or you're not in the new chain yet). */
  blocked: null | 'not-listed' | 'key-warning'
  /** The person must say they compared safety numbers (no signer is a key they knew). */
  confirm: boolean
}

export interface TrustContext {
  same: (a: string, b: string) => boolean
  /** Friends and DM contacts (keys this device already knew). */
  isContact: (key: string) => boolean
  /** A serious key-transparency finding about the key. */
  warned: (key: string) => boolean
  nameOf: (key: string) => string | undefined
}

/**
 * Who vouches for an offered chain: everyone who signed one of its changes (the creator, whoever added you, anyone who
 * handed out a key). A change signs its `prev`, so each signature covers the whole chain before it.
 */
export function checkStartOver(offer: Pick<ChannelView, 'members'> & { changes: Pick<ChannelChange, 'by' | 'action'>[] }, old: readonly string[], mine: string, ctx: TrustContext): StartOverCheck {
  const signers: Signer[] = []
  for (const change of offer.changes) {
    if (ctx.same(change.by, mine) || signers.some((s) => ctx.same(s.key, change.by))) continue
    const trust: SignerTrust = old.some((o) => ctx.same(o, change.by)) ? 'old-chain' : ctx.isContact(change.by) ? 'contact' : 'new'
    signers.push({ key: change.by, created: change.action === 'create', trust, warning: ctx.warned(change.by) })
  }
  const listed = offer.members.some((m) => ctx.same(m, mine))
  const norm = (s: string | undefined) => (s ?? '').normalize('NFKC').trim().toLocaleLowerCase()
  const oldNames = new Set(old.filter((o) => !ctx.same(o, mine)).map((o) => norm(ctx.nameOf(o))).filter(Boolean))
  const lookalikes = offer.members.filter((m) => !old.some((o) => ctx.same(o, m)) && oldNames.has(norm(ctx.nameOf(m))))
  const blocked = !listed ? 'not-listed' : signers.some((s) => s.warning) ? 'key-warning' : null
  const confirm = lookalikes.length > 0 || !signers.some((s) => s.trust !== 'new')
  return { signers, listed, lookalikes, blocked, confirm }
}
