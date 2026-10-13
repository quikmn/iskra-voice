// "Rent a server on DigitalOcean": creates an Iskra server in the user's own DigitalOcean account through its API v2.
// The user's API token lives only here, in the main process's memory: it's sent only to api.digitalocean.com over
// HTTPS, never logged, never written to disk, never handed back to the page, and forgotten when the flow ends.
// The page makes the setup text (user data, with the one-time owner claim) and claims the server once it answers.
// No Electron imports, so the unit tests run in plain Node with a fake API.

export const DO_API = 'https://api.digitalocean.com'
/** Ubuntu 24.04 LTS, what the setup text is written for. */
export const IMAGE = 'ubuntu-24-04-x64'
export const TAG = 'iskra'
/** The smallest size that runs Iskra (the server and LiveKit) comfortably. */
export const MIN_MEMORY_MB = 1024
/** DigitalOcean's limit for user data. */
const MAX_USER_DATA = 64 * 1024

/** What's open from the internet. No SSH unless the user asks: nobody needs to log in to run Iskra. */
export const INBOUND_PORTS = [
  { protocol: 'tcp', ports: '80' },
  { protocol: 'tcp', ports: '443' },
  { protocol: 'tcp', ports: '7881' },
  { protocol: 'udp', ports: '7882' },
] as const

export type DoErrorCode = 'token' | 'scope' | 'limit' | 'rate' | 'network' | 'server' | 'invalid' | 'timeout' | 'cancelled' | 'busy' | 'denied' | 'unavailable'

export class DoError extends Error {
  constructor(readonly code: DoErrorCode, readonly detail = '', readonly status = 0) {
    super(code)
  }
}

export interface DoSize {
  slug: string
  memory: number
  vcpus: number
  disk: number
  price_monthly: number
  regions: string[]
  available: boolean
}

export interface DoRegion {
  slug: string
  name: string
  available: boolean
  sizes: string[]
}

export interface SizeChoice {
  slug: string
  memoryMb: number
  vcpus: number
  diskGb: number
  priceMonthly: number
}

export interface RegionChoice {
  slug: string
  name: string
  size: SizeChoice
}

/** The cheapest basic size with enough memory, available in this region. */
export function chooseSize(sizes: DoSize[], region: string): SizeChoice | null {
  const fits = sizes
    .filter((s) => s.available && s.slug.startsWith('s-') && s.memory >= MIN_MEMORY_MB && s.regions.includes(region))
    .filter((s) => Number.isFinite(s.price_monthly) && s.price_monthly > 0)
    .sort((a, b) => a.price_monthly - b.price_monthly || a.memory - b.memory)
  const s = fits[0]
  return s ? { slug: s.slug, memoryMb: s.memory, vcpus: s.vcpus, diskGb: s.disk, priceMonthly: s.price_monthly } : null
}

/** Regions where a new server can go, each with its size and price, by name. */
export function regionChoices(sizes: DoSize[], regions: DoRegion[]): RegionChoice[] {
  const out: RegionChoice[] = []
  for (const r of regions) {
    if (!r.available || typeof r.slug !== 'string' || !/^[a-z0-9]{2,10}$/.test(r.slug)) continue
    const size = chooseSize(sizes.filter((s) => !Array.isArray(r.sizes) || r.sizes.includes(s.slug)), r.slug)
    if (size) out.push({ slug: r.slug, name: String(r.name ?? r.slug).slice(0, 60), size })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** "Game Night" → "iskra-game-night": a valid hostname, which DigitalOcean asks for. */
export function dropletName(name: string): string {
  const slug = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return slug ? `iskra-${slug}` : 'iskra-server'
}

/** 1.2.3.4 → https://1-2-3-4.sslip.io, the name the setup text gives the server (and its certificate). */
export function serverAddress(ip: string): string | null {
  const parts = ip.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null
  return `https://${parts.map(Number).join('-')}.sslip.io`
}

export interface CreateOptions {
  name: string
  region: string
  size: string
  userData: string
  /** Also open SSH (22/tcp). Off unless the user asks. */
  ssh?: boolean
}

export function dropletRequest(o: CreateOptions): Record<string, unknown> {
  return {
    name: dropletName(o.name),
    region: o.region,
    size: o.size,
    image: IMAGE,
    user_data: o.userData,
    tags: [TAG],
    monitoring: false,
    backups: false,
    ipv6: false,
  }
}

const everywhere = { addresses: ['0.0.0.0/0', '::/0'] }

export function firewallRequest(name: string, dropletId: number, ssh: boolean): Record<string, unknown> {
  const inbound = [...(ssh ? [{ protocol: 'tcp', ports: '22' }] : []), ...INBOUND_PORTS]
  return {
    name: `${dropletName(name)}-firewall`,
    droplet_ids: [dropletId],
    inbound_rules: inbound.map((r) => ({ protocol: r.protocol, ports: r.ports, sources: everywhere })),
    // Out: everything (updates, Let's Encrypt, link previews). A firewall without outbound rules blocks all of it.
    outbound_rules: [
      { protocol: 'tcp', ports: '1-65535', destinations: everywhere },
      { protocol: 'udp', ports: '1-65535', destinations: everywhere },
      { protocol: 'icmp', destinations: everywhere },
    ],
  }
}

/** DigitalOcean's own error text, shortened, and never with the token in it. */
function cleanDetail(text: unknown, token: string): string {
  if (typeof text !== 'string') return ''
  return (token ? text.split(token).join('…') : text).replace(/[\r\n]+/g, ' ').slice(0, 200)
}

type Fetch = typeof fetch

export class DoClient {
  readonly #token: string
  readonly #base: string
  readonly #fetch: Fetch

  constructor(token: string, base = DO_API, fetcher: Fetch = fetch) {
    this.#token = token
    this.#base = base
    this.#fetch = fetcher
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response
    try {
      const timeout = AbortSignal.timeout(30_000)
      response = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      })
    } catch {
      if (signal?.aborted) throw new DoError('cancelled')
      throw new DoError('network')
    }
    if (response.status === 204 || (method === 'DELETE' && response.ok)) return undefined as T
    const json = (await response.json().catch(() => null)) as { id?: string; message?: string } | null
    if (response.ok && json) return json as T
    const detail = cleanDetail(json?.message, this.#token)
    const status = response.status
    if (status === 401) throw new DoError('token', detail, status)
    if (status === 403) throw new DoError('scope', detail, status)
    if (status === 429) throw new DoError('rate', detail, status)
    if (status === 422 && /limit/i.test(detail)) throw new DoError('limit', detail, status)
    if (status >= 500) throw new DoError('server', detail, status)
    throw new DoError('invalid', detail, status)
  }
}

export interface Created {
  dropletId?: number
  dropletName?: string
  firewallId?: string
}

export type RentStep = 'droplet' | 'firewall' | 'booting' | 'installing' | 'ready'

export interface RentProgress {
  step: RentStep
  ip?: string
  url?: string
}

export interface Rented {
  ip: string
  url: string
  dropletId: number
  dropletName: string
  region: string
  size: string
}

export interface RentalOptions {
  base?: string
  fetch?: Fetch
  /** Where the server answers once installed; tests point it at a local server. */
  serverUrl?: (ip: string) => string | null
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
  bootTimeoutMs?: number
  installTimeoutMs?: number
  /** The token is forgotten after this long, whatever happens. */
  tokenLifetimeMs?: number
}

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })

const validToken = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(token)

/** One rental at a time: the token, what's been created so far (to delete on failure), and the progress. */
export class DoRental {
  #client: DoClient | null = null
  #expiry: ReturnType<typeof setTimeout> | null = null
  #abort: AbortController | null = null
  #running: Promise<unknown> | null = null
  #created: Created = {}
  readonly #o: Required<Omit<RentalOptions, 'fetch'>> & { fetch?: Fetch }

  constructor(options: RentalOptions = {}) {
    this.#o = {
      base: DO_API,
      serverUrl: serverAddress,
      sleep: realSleep,
      now: Date.now,
      bootTimeoutMs: 5 * 60_000,
      installTimeoutMs: 25 * 60_000,
      tokenLifetimeMs: 2 * 60 * 60_000,
      ...options,
    }
  }

  get connected(): boolean {
    return this.#client !== null
  }

  get busy(): boolean {
    return this.#abort !== null
  }

  /** What was created, for the page to say what's there. */
  get created(): Created {
    return { ...this.#created }
  }

  /** Checks the token by listing sizes and regions (two read scopes), and keeps it for create and clean up. */
  async connect(token: unknown): Promise<RegionChoice[]> {
    if (this.busy) throw new DoError('busy')
    const trimmed = typeof token === 'string' ? token.trim() : token
    if (!validToken(trimmed)) throw new DoError('token')
    const client = new DoClient(trimmed, this.#o.base, this.#o.fetch)
    const [sizes, regions] = await Promise.all([
      client.request<{ sizes?: DoSize[] }>('GET', '/v2/sizes?per_page=200'),
      client.request<{ regions?: DoRegion[] }>('GET', '/v2/regions?per_page=200'),
    ])
    const choices = regionChoices(Array.isArray(sizes.sizes) ? sizes.sizes : [], Array.isArray(regions.regions) ? regions.regions : [])
    if (choices.length === 0) throw new DoError('invalid', 'No region has a size for Iskra.')
    this.#client = client
    this.#created = {}
    if (this.#expiry) clearTimeout(this.#expiry)
    this.#expiry = setTimeout(() => this.forget(), this.#o.tokenLifetimeMs)
    this.#expiry.unref?.()
    return choices
  }

  /**
   * Creates the server and its firewall, then waits for it to boot, install and answer over HTTPS. Cancelling stops
   * the waiting, never a create request already sent: what it made is always recorded, so clean up can delete it.
   */
  async create(options: CreateOptions, onProgress: (p: RentProgress) => void): Promise<Rented> {
    const client = this.#client
    if (!client) throw new DoError('token')
    if (this.busy) throw new DoError('busy')
    if (!/^[a-z0-9]{2,10}$/.test(options.region) || !/^[a-z0-9-]{2,40}$/.test(options.size)) throw new DoError('invalid')
    if (typeof options.userData !== 'string' || !options.userData.startsWith('#!/bin/bash') || options.userData.length > MAX_USER_DATA) throw new DoError('invalid')
    if (this.#created.dropletId) throw new DoError('busy') // clean up (or finish) the last one first
    const abort = new AbortController()
    this.#abort = abort
    const running = this.#create(client, options, onProgress, abort.signal)
    this.#running = running
    try {
      return await running
    } finally {
      this.#abort = null
      this.#running = null
    }
  }

  async #create(client: DoClient, options: CreateOptions, onProgress: (p: RentProgress) => void, signal: AbortSignal): Promise<Rented> {
    const stopped = () => {
      if (signal.aborted) throw new DoError('cancelled')
    }
    try {
      onProgress({ step: 'droplet' })
      const name = dropletName(options.name)
      const made = await client.request<{ droplet?: { id?: number } }>('POST', '/v2/droplets', dropletRequest(options))
      const dropletId = made.droplet?.id
      if (typeof dropletId !== 'number') throw new DoError('server', 'No server id.')
      this.#created.dropletId = dropletId
      this.#created.dropletName = name
      stopped()

      onProgress({ step: 'firewall' })
      const fw = await client.request<{ firewall?: { id?: string } }>('POST', '/v2/firewalls', firewallRequest(options.name, dropletId, options.ssh === true))
      if (typeof fw.firewall?.id === 'string') this.#created.firewallId = fw.firewall.id
      stopped()

      onProgress({ step: 'booting' })
      const ip = await this.#waitForIp(client, dropletId, signal)
      const url = this.#o.serverUrl(ip)
      if (!url) throw new DoError('server', `No public IPv4 address (${ip}).`)
      onProgress({ step: 'installing', ip, url })
      await this.#waitForHealth(url, signal)
      onProgress({ step: 'ready', ip, url })
      return { ip, url, dropletId, dropletName: name, region: options.region, size: options.size }
    } catch (e) {
      if (signal.aborted) throw new DoError('cancelled')
      throw e instanceof DoError ? e : new DoError('network')
    }
  }

  async #waitForIp(client: DoClient, id: number, signal: AbortSignal): Promise<string> {
    const deadline = this.#o.now() + this.#o.bootTimeoutMs
    for (;;) {
      const { droplet } = await client.request<{ droplet?: { status?: string; networks?: { v4?: { ip_address?: string; type?: string }[] } } }>('GET', `/v2/droplets/${id}`, undefined, signal)
      const ip = droplet?.networks?.v4?.find((n) => n.type === 'public')?.ip_address
      if (droplet?.status === 'active' && typeof ip === 'string' && serverAddress(ip)) return ip
      if (this.#o.now() > deadline) throw new DoError('timeout', 'boot')
      await this.#o.sleep(5000, signal)
      if (signal.aborted) throw new DoError('cancelled')
    }
  }

  /** The server's /health over HTTPS (certificate checked), so Let's Encrypt has already said yes. */
  async #waitForHealth(url: string, signal: AbortSignal): Promise<void> {
    const fetcher = this.#o.fetch ?? fetch
    const deadline = this.#o.now() + this.#o.installTimeoutMs
    for (;;) {
      try {
        const response = await fetcher(`${url}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'error' })
        if (response.ok) return
      } catch {
        // Installing, starting, or still getting its certificate.
      }
      if (signal.aborted) throw new DoError('cancelled')
      if (this.#o.now() > deadline) throw new DoError('timeout', 'install')
      await this.#o.sleep(10_000, signal)
      if (signal.aborted) throw new DoError('cancelled')
    }
  }

  /** Stops waiting. What was created stays until cleanUp (or the user keeps it). */
  cancel(): void {
    this.#abort?.abort()
  }

  /** Deletes what this rental created (the firewall, then the server). Already gone counts as deleted. */
  async cleanUp(): Promise<{ droplet: boolean; firewall: boolean }> {
    const client = this.#client
    if (!client) throw new DoError('token')
    this.cancel()
    await this.#running?.catch(() => undefined) // a create request on its way: delete what it makes too
    const gone = async (path: string) => {
      try {
        await client.request('DELETE', path)
        return true
      } catch (e) {
        if (e instanceof DoError && e.status === 404) return true
        throw e
      }
    }
    const { dropletId, firewallId } = this.#created
    const firewall = firewallId ? await gone(`/v2/firewalls/${encodeURIComponent(firewallId)}`) : true
    if (firewall) delete this.#created.firewallId
    const droplet = dropletId ? await gone(`/v2/droplets/${dropletId}`) : true
    if (droplet) this.#created = {}
    return { droplet, firewall }
  }

  /** Done (or closed): the token goes, and with it any way to change the account from here. */
  forget(): void {
    this.cancel()
    this.#client = null
    this.#created = {}
    if (this.#expiry) clearTimeout(this.#expiry)
    this.#expiry = null
  }
}

/**
 * Tests only: a fake API and server on this computer. Never in a packaged app, and only plain-HTTP loopback
 * addresses, so the token can't be sent anywhere else.
 */
export function testOverrides(env: NodeJS.ProcessEnv, packaged: boolean): Pick<RentalOptions, 'base' | 'serverUrl'> {
  if (packaged || env.ISKRA_E2E !== '1') return {}
  const loopback = (v: string | undefined) => (v && /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(v) ? v : undefined)
  const base = loopback(env.ISKRA_DO_API)
  const server = loopback(env.ISKRA_DO_SERVER_URL)
  return { ...(base ? { base } : {}), ...(server ? { serverUrl: () => server } : {}) }
}

/** What the page hears back: a code it translates, and DigitalOcean's own words if any. */
export function errorReply(e: unknown): { ok: false; error: DoErrorCode; detail: string } {
  return e instanceof DoError ? { ok: false, error: e.code, detail: e.detail } : { ok: false, error: 'network', detail: '' }
}
