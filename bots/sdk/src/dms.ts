// Direct messages for bots: the same end-to-end encryption as the app (core/dm.ts). The bot has its own device key and
// publishes signed prekeys like an app, so messages to it are forward secret; whoever runs the bot reads them.
import { b64u } from '../../../client/src/core/crypto'
import { currentPrekey, revokedSet, rotatePrekeys, signPrekey, type PrekeyPair } from '../../../client/src/core/devices'
import { decryptDm, encryptDm, type DmContent } from '../../../client/src/core/dm'
import { decryptFile, type DmFile } from '../../../client/src/core/dmFiles'
import type { Identity } from '../../../client/src/core/identity'
import type { Card, DeviceBundle, Requests, WireDm } from '../../../client/src/core/protocol'

/** Prekeys as kept in the state file (b64u keys). */
export interface StoredPrekey {
  publicKey: string
  secretKey: string
  created: number
  retiredAt?: number
}

export const toStored = (p: PrekeyPair): StoredPrekey => ({
  publicKey: b64u(p.publicKey), secretKey: b64u(p.secretKey), created: p.created, ...(p.retiredAt !== undefined ? { retiredAt: p.retiredAt } : {}),
})

type Request = <K extends keyof Requests>(type: K, body: Requests[K][0]) => Promise<Requests[K][1]>

const BUNDLE_TTL_MS = 5 * 60_000

/** A decrypted DM: what was said, by whom, and the encrypted attachments (open them with `bot.downloadDmFile`). */
export interface DecryptedDm {
  /** The server's id for the envelope. */
  serverId: number
  /** The id inside the encrypted header (the same on every server). */
  id: string
  from: string
  text: string
  sentAt: number
  files: DmFile[]
}

export class DmKeys {
  private readonly bundles = new Map<string, { at: number; bundle: DeviceBundle }>()

  private readonly identity: Identity
  private readonly request: Request
  private readonly save: (prekeys: PrekeyPair[]) => void

  constructor(identity: Identity, request: Request, save: (prekeys: PrekeyPair[]) => void) {
    this.identity = identity
    this.request = request
    this.save = save
  }

  private get me(): string {
    return b64u(this.identity.account.publicKey)
  }

  /** Rotates the prekeys when due (weekly; old secrets deleted after 30 days) and publishes the current one. */
  async publishPrekey(now = Date.now()): Promise<void> {
    const { prekeys, changed } = rotatePrekeys(this.identity.prekeys ?? [], now)
    this.identity.prekeys = prekeys
    if (changed) this.save(prekeys)
    const current = currentPrekey(prekeys)
    if (current) await this.request('prekey.publish', signPrekey(this.identity, current))
  }

  forgetBundles(): void {
    this.bundles.clear()
  }

  private async bundle(accountKey: string): Promise<DeviceBundle> {
    const cached = this.bundles.get(accountKey)
    if (cached && Date.now() - cached.at < BUNDLE_TTL_MS) return cached.bundle
    const bundle = await this.request('dm.devices', { accountKey })
    this.bundles.set(accountKey, { at: Date.now(), bundle })
    return bundle
  }

  /** An envelope for `peer`'s devices (and the bot's own, so its history stays readable). */
  async encrypt(peer: string, content: DmContent): Promise<import('../../../client/src/core/dm').DmEnvelope> {
    const [theirs, ours] = await Promise.all([this.bundle(peer), this.bundle(this.me)])
    return encryptDm(this.identity, peer, theirs.devices, ours.devices, content, Date.now(), {
      prekeys: [...(theirs.prekeys ?? []), ...(ours.prekeys ?? [])],
      revokedDevices: [...revokedSet(peer, theirs.revoked), ...revokedSet(this.me, ours.revoked)],
    })
  }

  /** Decrypts a DM the server relayed. Throws a DmError when it can't be read (never returns unchecked text). */
  open(wire: WireDm): DecryptedDm {
    const content = decryptDm(this.identity, wire.envelope, wire.from, wire.to)
    return { serverId: wire.id, id: content.header.id, from: wire.from, text: content.text, sentAt: content.header.sentAt, files: content.files ?? [] }
  }

  /** Downloads and decrypts an attachment (checked against its hash and size; anything off throws). */
  async download(serverUrl: string, file: DmFile): Promise<Uint8Array> {
    const { url } = await this.request('dm.file.url', { id: file.id })
    const response = await fetch(serverUrl + url)
    if (!response.ok) throw new Error(`Downloading "${file.name}" failed: HTTP ${response.status}`)
    return decryptFile(new Uint8Array(await response.arrayBuffer()), file)
  }
}

/** Cards as text, for DMs (which carry text only). */
export function cardsAsText(cards: Card[] | undefined): string {
  return (cards ?? []).map((card) => {
    const lines: string[] = []
    if (card.title) lines.push(`**${card.title}**${card.url ? ` (${card.url})` : ''}`)
    if (card.description) lines.push(card.description)
    for (const field of card.fields ?? []) lines.push(`**${field.name}:** ${field.value}`)
    if (card.footer?.text) lines.push(card.footer.text)
    return lines.join('\n')
  }).filter(Boolean).join('\n\n')
}
