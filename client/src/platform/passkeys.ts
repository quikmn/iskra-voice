// Passkeys for the app lock: WebAuthn with the PRF extension. The PRF output (a secret only that passkey can
// produce, after the person's fingerprint, face, PIN or security key touch) derives the key that wraps the data key
// (core/vault.ts). We never check WebAuthn signatures: nothing here proves anything to a server, the PRF secret is
// what protects the keys. See "Keys on the device" in protocol/PROTOCOL.md.
//
// Where the ceremony runs: the browser itself (rpId = the page's host), or the desktop app, whose app:// page can't
// use WebAuthn, so its main process runs it in a small window on https://app.iskra.foo (desktop/src/passkeys.ts).
import { b64u, fromB64u } from '../core/crypto'
import { desktop } from './desktop'
import { nativePlatform } from './native'

/** The desktop app's and the phone app's passkeys belong to the web app's domain (see the AASA / assetlinks files). */
export const APP_RP_ID = 'app.iskra.foo'

/** JSON form of a ceremony, so the desktop app can run it in another process. Byte strings are b64u. */
export interface CreateRequest {
  rpId: string
  userId: string
  userName: string
  displayName: string
  challenge: string
  exclude: string[]
  prfSalt: string
}

export interface CreateResult {
  id: string
  /** The authenticator said it supports PRF. */
  prfEnabled: boolean
  /** Some authenticators evaluate PRF while creating; otherwise a get() follows. */
  prfFirst?: string
}

export interface GetRequest {
  rpId: string
  challenge: string
  /** Credential id → its PRF input. */
  salts: Record<string, string>
}

export interface GetResult {
  id: string
  prfFirst?: string
}

export interface Ceremonies {
  create(request: CreateRequest): Promise<CreateResult>
  get(request: GetRequest): Promise<GetResult>
}

export type PasskeyProblem = 'unsupported' | 'no-prf' | 'cancelled' | 'exists' | 'failed'

export class PasskeyError extends Error {
  readonly problem: PasskeyProblem
  constructor(problem: PasskeyProblem, message: string = problem) {
    super(message)
    this.problem = problem
  }
}

/** Maps a WebAuthn DOMException to what we tell the person. */
export function problemOf(e: unknown): PasskeyProblem {
  if (e instanceof PasskeyError) return e.problem
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled'
  if (name === 'InvalidStateError') return 'exists'
  if (name === 'SecurityError' || name === 'NotSupportedError') return 'unsupported'
  return 'failed'
}

const bytes = (text: string) => fromB64u(text) as Uint8Array<ArrayBuffer>
const asB64u = (buffer: ArrayBuffer | ArrayBufferView) =>
  b64u(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))

interface PrfOutputs { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } }

/** Ceremonies through this page's own navigator.credentials. */
export function browserCeremonies(credentials: CredentialsContainer = navigator.credentials): Ceremonies {
  return {
    async create(r) {
      const credential = await credentials.create({
        publicKey: {
          rp: { id: r.rpId, name: 'Iskra' },
          user: { id: bytes(r.userId), name: r.userName, displayName: r.displayName },
          challenge: bytes(r.challenge),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
          excludeCredentials: r.exclude.map((id) => ({ type: 'public-key' as const, id: bytes(id) })),
          attestation: 'none',
          extensions: { prf: { eval: { first: bytes(r.prfSalt) } } } as AuthenticationExtensionsClientInputs,
        },
      }) as PublicKeyCredential | null
      if (!credential) throw new PasskeyError('cancelled')
      const prf = (credential.getClientExtensionResults() as { prf?: PrfOutputs }).prf
      const first = prf?.results?.first
      return { id: asB64u(credential.rawId), prfEnabled: !!prf?.enabled || !!first, ...(first ? { prfFirst: asB64u(first) } : {}) }
    },
    async get(r) {
      const ids = Object.keys(r.salts)
      const credential = await credentials.get({
        publicKey: {
          rpId: r.rpId,
          challenge: bytes(r.challenge),
          allowCredentials: ids.map((id) => ({ type: 'public-key' as const, id: bytes(id) })),
          userVerification: 'required',
          extensions: { prf: { evalByCredential: Object.fromEntries(ids.map((id) => [id, { first: bytes(r.salts[id]) }])) } } as AuthenticationExtensionsClientInputs,
        },
      }) as PublicKeyCredential | null
      if (!credential) throw new PasskeyError('cancelled')
      const first = (credential.getClientExtensionResults() as { prf?: PrfOutputs }).prf?.results?.first
      return { id: asB64u(credential.rawId), ...(first ? { prfFirst: asB64u(first) } : {}) }
    },
  }
}

/** Ceremonies through the desktop app's main process (an error comes back as { ok: false, name }). */
export function desktopCeremonies(bridge: NonNullable<NonNullable<typeof desktop>['passkey']>): Ceremonies {
  const run = async (op: 'create' | 'get', request: CreateRequest | GetRequest) => {
    const result = await bridge.run(op, request)
    if (!result?.ok) throw Object.assign(new Error(result?.message || 'Passkey failed'), { name: result?.name || 'Error' })
    return result
  }
  return {
    async create(r) {
      const out = await run('create', r)
      return { id: String(out.id), prfEnabled: out.prfEnabled === true, ...(typeof out.prfFirst === 'string' ? { prfFirst: out.prfFirst } : {}) }
    },
    async get(r) {
      const out = await run('get', r)
      return { id: String(out.id), ...(typeof out.prfFirst === 'string' ? { prfFirst: out.prfFirst } : {}) }
    },
  }
}

/** Where passkeys work in this app, and with which relying party id. Null: not here. */
export function passkeyPlatform(): { ceremonies: Ceremonies; rpId: string; where: 'browser' | 'desktop' | 'ios' | 'android' } | null {
  if (desktop) return desktop.passkey ? { ceremonies: desktopCeremonies(desktop.passkey), rpId: APP_RP_ID, where: 'desktop' } : null
  if (typeof window === 'undefined' || !window.PublicKeyCredential || !navigator.credentials) return null
  const native = nativePlatform()
  // The phone app runs on capacitor://localhost; its passkeys are app.iskra.foo's (associated domains).
  if (native) return { ceremonies: browserCeremonies(), rpId: APP_RP_ID, where: native }
  return { ceremonies: browserCeremonies(), rpId: location.hostname, where: 'browser' }
}

/** False when the browser says it can't do PRF (only some can tell); true or unknown otherwise. */
export async function prfMaybeSupported(): Promise<boolean> {
  const pkc = (globalThis as { PublicKeyCredential?: { getClientCapabilities?: () => Promise<Record<string, boolean>> } }).PublicKeyCredential
  try {
    const caps = await pkc?.getClientCapabilities?.()
    return caps?.['extension:prf'] !== false
  } catch {
    return true
  }
}

const random = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)))

/**
 * Makes a passkey and gets its PRF output for <paramref name="salt"/>. Throws PasskeyError: 'no-prf' when the
 * authenticator can't do PRF (then the app lock stays with the passphrase).
 */
export async function createPasskey(
  ceremonies: Ceremonies, rpId: string, user: { id: string; name: string }, salt: Uint8Array, exclude: string[],
): Promise<{ id: string; prf: Uint8Array }> {
  let created: CreateResult
  try {
    created = await ceremonies.create({
      rpId, userId: user.id, userName: `Iskra · ${user.name}`, displayName: user.name, challenge: random(32), exclude, prfSalt: b64u(salt),
    })
  } catch (e) {
    throw new PasskeyError(problemOf(e), (e as Error)?.message)
  }
  if (created.prfFirst) return { id: created.id, prf: fromB64u(created.prfFirst) }
  if (!created.prfEnabled) throw new PasskeyError('no-prf')
  // PRF wasn't evaluated while creating: ask the new passkey once more.
  const got = await getPasskeySecret(ceremonies, rpId, { [created.id]: b64u(salt) })
  if (got.id !== created.id) throw new PasskeyError('failed')
  return got
}

/** Asks for one of <paramref name="salts"/>' passkeys and returns which one answered, with its PRF output. */
export async function getPasskeySecret(ceremonies: Ceremonies, rpId: string, salts: Record<string, string>): Promise<{ id: string; prf: Uint8Array }> {
  let got: GetResult
  try {
    got = await ceremonies.get({ rpId, challenge: random(32), salts })
  } catch (e) {
    throw new PasskeyError(problemOf(e), (e as Error)?.message)
  }
  if (!got.prfFirst) throw new PasskeyError('no-prf')
  if (!(got.id in salts)) throw new PasskeyError('failed')
  return { id: got.id, prf: fromB64u(got.prfFirst) }
}
