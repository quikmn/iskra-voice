import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { chooseSize, DoError, dropletName, DoRental, firewallRequest, regionChoices, serverAddress, testOverrides, type DoRegion, type DoSize } from './digitalocean'

const TOKEN = 'dop_v1_' + 'a1'.repeat(32)
const BASE = 'https://api.digitalocean.com'

const SIZES: DoSize[] = [
  { slug: 's-1vcpu-512mb-10gb', memory: 512, vcpus: 1, disk: 10, price_monthly: 4, regions: ['ams3', 'fra1', 'nyc3'], available: true },
  { slug: 's-1vcpu-1gb', memory: 1024, vcpus: 1, disk: 25, price_monthly: 6, regions: ['ams3', 'fra1', 'nyc3'], available: true },
  { slug: 's-1vcpu-2gb', memory: 2048, vcpus: 1, disk: 50, price_monthly: 12, regions: ['ams3', 'fra1', 'nyc3', 'sgp1'], available: true },
  { slug: 'c-2', memory: 4096, vcpus: 2, disk: 25, price_monthly: 3, regions: ['ams3'], available: true },
  { slug: 's-1vcpu-1gb-amd', memory: 1024, vcpus: 1, disk: 25, price_monthly: 7, regions: ['ams3'], available: false },
]
const REGIONS: DoRegion[] = [
  { slug: 'fra1', name: 'Frankfurt 1', available: true, sizes: ['s-1vcpu-1gb', 's-1vcpu-2gb'] },
  { slug: 'ams3', name: 'Amsterdam 3', available: true, sizes: ['s-1vcpu-512mb-10gb', 's-1vcpu-1gb', 's-1vcpu-2gb', 'c-2'] },
  { slug: 'sgp1', name: 'Singapore 1', available: true, sizes: ['s-1vcpu-2gb'] },
  { slug: 'nyc1', name: 'New York 1', available: false, sizes: ['s-1vcpu-1gb'] },
  { slug: 'lon1', name: 'London 1', available: true, sizes: [] },
]

interface Call {
  method: string
  url: string
  auth: string | null
  body: Record<string, unknown> | null
}

type Route = (call: Call) => { status: number; json?: unknown } | 'throw'

/** A fake DigitalOcean API (and the new server's /health), recording every request. */
function fakeApi(overrides: Record<string, Route> = {}) {
  const calls: Call[] = []
  let polls = 0
  let health = 0
  const routes: Record<string, Route> = {
    'GET /v2/sizes': () => ({ status: 200, json: { sizes: SIZES } }),
    'GET /v2/regions': () => ({ status: 200, json: { regions: REGIONS } }),
    'POST /v2/droplets': () => ({ status: 202, json: { droplet: { id: 4242, status: 'new', networks: { v4: [] } } } }),
    'POST /v2/firewalls': () => ({ status: 202, json: { firewall: { id: 'fw-1', status: 'waiting' } } }),
    'GET /v2/droplets/4242': () => {
      polls++
      return polls < 3
        ? { status: 200, json: { droplet: { id: 4242, status: 'new', networks: { v4: [{ ip_address: '10.0.0.5', type: 'private' }] } } } }
        : { status: 200, json: { droplet: { id: 4242, status: 'active', networks: { v4: [{ ip_address: '10.0.0.5', type: 'private' }, { ip_address: '203.0.113.7', type: 'public' }] } } } }
    },
    'DELETE /v2/droplets/4242': () => ({ status: 204 }),
    'DELETE /v2/firewalls/fw-1': () => ({ status: 204 }),
    'GET https://203-0-113-7.sslip.io/health': () => (++health < 2 ? 'throw' : { status: 200, json: { iskra: 1 } }),
    ...overrides,
  }
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const call: Call = { method: init?.method ?? 'GET', url, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null }
    calls.push(call)
    const path = url.startsWith(BASE) ? url.slice(BASE.length).split('?')[0] : url
    const route = routes[`${call.method} ${path}`]
    const reply = route ? route(call) : { status: 404, json: { id: 'not_found', message: 'The resource you were accessing could not be found.' } }
    if (reply === 'throw') throw new TypeError('fetch failed')
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, fetcher }
}

const instant = async () => undefined
const rentalWith = (api: ReturnType<typeof fakeApi>, more = {}) => new DoRental({ fetch: api.fetcher, sleep: instant, ...more })
const USER_DATA = '#!/bin/bash\necho hello\n'

/** Every console line written while `run` runs. */
async function consoleDuring(run: () => Promise<unknown>): Promise<string> {
  const said: string[] = []
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const saved = methods.map((m) => console[m])
  for (const m of methods) console[m] = (...args: unknown[]) => void said.push(args.map(String).join(' '))
  try {
    await run().catch(() => undefined)
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]))
  }
  return said.join('\n')
}

test('picks the cheapest basic size with at least 1 GB, per region', () => {
  assert.deepEqual(chooseSize(SIZES, 'ams3'), { slug: 's-1vcpu-1gb', memoryMb: 1024, vcpus: 1, diskGb: 25, priceMonthly: 6 })
  assert.equal(chooseSize(SIZES, 'sgp1')?.slug, 's-1vcpu-2gb')
  assert.equal(chooseSize(SIZES, 'tor1'), null)
  const choices = regionChoices(SIZES, REGIONS)
  assert.deepEqual(choices.map((c) => [c.slug, c.size.slug, c.size.priceMonthly]), [
    ['ams3', 's-1vcpu-1gb', 6], ['fra1', 's-1vcpu-1gb', 6], ['sgp1', 's-1vcpu-2gb', 12],
  ])
})

test('names and addresses', () => {
  assert.equal(dropletName('Game Night!'), 'iskra-game-night')
  assert.equal(dropletName('Kärlek & Öl'), 'iskra-karlek-ol')
  assert.equal(dropletName('🎮'), 'iskra-server')
  assert.match(dropletName('x'.repeat(100)), /^iskra-x{40}$/)
  assert.equal(serverAddress('203.0.113.7'), 'https://203-0-113-7.sslip.io')
  assert.equal(serverAddress('203.0.113'), null)
  assert.equal(serverAddress('2001:db8::1'), null)
})

test('connect checks the token with two read requests to the API only, and returns regions with prices', async () => {
  const api = fakeApi()
  const rental = rentalWith(api)
  const regions = await rental.connect(`  ${TOKEN}\n`)
  assert.equal(regions.length, 3)
  assert.equal(rental.connected, true)
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.url}`).sort(), [
    `GET ${BASE}/v2/regions?per_page=200`, `GET ${BASE}/v2/sizes?per_page=200`,
  ])
  for (const c of api.calls) assert.equal(c.auth, `Bearer ${TOKEN}`)
})

test("a token that can't be one is refused without asking DigitalOcean", async () => {
  const api = fakeApi()
  for (const bad of ['', 'short', 'has spaces in it but is long enough', 'x'.repeat(201), 42, null]) {
    await assert.rejects(rentalWith(api).connect(bad), (e: DoError) => e.code === 'token')
  }
  assert.equal(api.calls.length, 0)
})

test("DigitalOcean's errors become codes, and never carry the token", async () => {
  const echo = (status: number, message: string): Route => (call) => ({ status, json: { id: 'x', message: `${message} (${call.auth})` } })
  const cases: [Route, string][] = [
    [echo(401, 'Unable to authenticate you'), 'token'],
    [echo(403, 'You are not authorized to perform this operation'), 'scope'],
    [echo(429, 'Too many requests'), 'rate'],
    [echo(500, 'Server was unable to give you a response.'), 'server'],
    [() => 'throw', 'network'],
  ]
  for (const [route, code] of cases) {
    const rental = rentalWith(fakeApi({ 'GET /v2/sizes': route }))
    await assert.rejects(rental.connect(TOKEN), (e: DoError) => {
      assert.equal(e.code, code)
      assert.ok(!e.detail.includes(TOKEN) && !e.message.includes(TOKEN))
      return true
    })
    assert.equal(rental.connected, false)
  }
  const api = fakeApi({ 'POST /v2/droplets': echo(422, 'creating this/these droplet(s) will exceed your droplet limit') })
  const rental = rentalWith(api)
  await rental.connect(TOKEN)
  await assert.rejects(rental.create({ name: 'A', region: 'ams3', size: 's-1vcpu-1gb', userData: USER_DATA }, () => undefined), (e: DoError) => e.code === 'limit' && e.detail.includes('droplet limit') && !e.detail.includes(TOKEN))
  assert.deepEqual(rental.created, {})
})

test('create: the droplet, a firewall without SSH, then waits for its address and HTTPS', async () => {
  const api = fakeApi()
  const rental = rentalWith(api)
  await rental.connect(TOKEN)
  const steps: string[] = []
  const server = await rental.create({ name: 'Game Night', region: 'ams3', size: 's-1vcpu-1gb', userData: USER_DATA }, (p) => steps.push(p.ip ? `${p.step} ${p.ip} ${p.url}` : p.step))
  assert.deepEqual(server, { ip: '203.0.113.7', url: 'https://203-0-113-7.sslip.io', dropletId: 4242, dropletName: 'iskra-game-night', region: 'ams3', size: 's-1vcpu-1gb' })
  assert.deepEqual(steps, ['droplet', 'firewall', 'booting', 'installing 203.0.113.7 https://203-0-113-7.sslip.io', 'ready 203.0.113.7 https://203-0-113-7.sslip.io'])

  const droplet = api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v2/droplets'))!
  assert.deepEqual(droplet.body, {
    name: 'iskra-game-night', region: 'ams3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64', user_data: USER_DATA,
    tags: ['iskra'], monitoring: false, backups: false, ipv6: false,
  })
  const firewall = api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v2/firewalls'))!
  assert.deepEqual(firewall.body?.droplet_ids, [4242])
  const inbound = (firewall.body?.inbound_rules as { protocol: string; ports: string; sources: unknown }[])
  assert.deepEqual(inbound.map((r) => `${r.ports}/${r.protocol}`), ['80/tcp', '443/tcp', '7881/tcp', '7882/udp'])
  for (const r of inbound) assert.deepEqual(r.sources, { addresses: ['0.0.0.0/0', '::/0'] })
  assert.deepEqual((firewall.body?.outbound_rules as { protocol: string }[]).map((r) => r.protocol), ['tcp', 'udp', 'icmp'])

  // Only the API (with the token) and the new server's /health (without it).
  for (const c of api.calls) {
    if (c.url.startsWith(BASE)) assert.equal(c.auth, `Bearer ${TOKEN}`)
    else assert.deepEqual([c.url, c.auth], ['https://203-0-113-7.sslip.io/health', null])
  }
  assert.ok(api.calls.filter((c) => c.url.endsWith('/v2/droplets/4242')).length >= 3)
})

test('SSH is only opened when asked for', () => {
  const ports = (ssh: boolean) => (firewallRequest('A', 1, ssh).inbound_rules as { ports: string }[]).map((r) => r.ports)
  assert.deepEqual(ports(false), ['80', '443', '7881', '7882'])
  assert.deepEqual(ports(true), ['22', '80', '443', '7881', '7882'])
})

test('a failure after the droplet exists says so, and clean up deletes it', async () => {
  const api = fakeApi({ 'POST /v2/firewalls': () => ({ status: 403, json: { id: 'forbidden', message: 'You are not authorized to perform this operation' } }) })
  const rental = rentalWith(api)
  await rental.connect(TOKEN)
  await assert.rejects(rental.create({ name: 'A', region: 'ams3', size: 's-1vcpu-1gb', userData: USER_DATA }, () => undefined), (e: DoError) => e.code === 'scope')
  assert.deepEqual(rental.created, { dropletId: 4242, dropletName: 'iskra-a' })
  // Not a second one on top of it.
  await assert.rejects(rental.create({ name: 'A', region: 'ams3', size: 's-1vcpu-1gb', userData: USER_DATA }, () => undefined), (e: DoError) => e.code === 'busy')
  assert.deepEqual(await rental.cleanUp(), { droplet: true, firewall: true })
  assert.deepEqual(rental.created, {})
  assert.deepEqual(api.calls.filter((c) => c.method === 'DELETE').map((c) => c.url), [`${BASE}/v2/droplets/4242`])
})

test("a server that never answers times out; clean up removes the firewall, then the droplet (gone counts as deleted)", async () => {
  let clock = 0
  const api = fakeApi({
    'GET https://203-0-113-7.sslip.io/health': () => 'throw',
    'DELETE /v2/droplets/4242': () => ({ status: 404, json: { id: 'not_found', message: 'The resource you were accessing could not be found.' } }),
  })
  const rental = rentalWith(api, { now: () => (clock += 60_000) })
  await rental.connect(TOKEN)
  await assert.rejects(rental.create({ name: 'A', region: 'ams3', size: 's-1vcpu-1gb', userData: USER_DATA }, () => undefined), (e: DoError) => e.code === 'timeout' && e.detail === 'install')
  assert.deepEqual(rental.created, { dropletId: 4242, dropletName: 'iskra-a', firewallId: 'fw-1' })
  assert.deepEqual(await rental.cleanUp(), { droplet: true, firewall: true })
  assert.deepEqual(api.calls.filter((c) => c.method === 'DELETE').map((c) => c.url), [`${BASE}/v2/firewalls/fw-1`, `${BASE}/v2/droplets/4242`])
})

test('a clean up that fails keeps what is left, so it can be tried again', async () => {
  let fail = true
  const api = fakeApi({
    'POST /v2/firewalls': () => ({ status: 500, json: { message: 'oops' } }),
    'DELETE /v2/droplets/4242': () => (fail ? { status: 500, json: { message: 'oops' } } : { status: 204 }),
  })
  const rental = rentalWith(api)
  await rental.connect(TOKEN)
  await assert.rejects(rental.create({ name: 'A', region: 'ams3', size: 's-1vcpu-1gb', userData: USER_DATA }, () => undefined))
  await assert.rejects(rental.cleanUp(), (e: DoError) => e.code === 'server')
  assert.deepEqual(rental.created, { dropletId: 4242, dropletName: 'iskra-a' })
  fail = false
  assert.deepEqual(await rental.cleanUp(), { droplet: true, firewall: true })
})

test('cancel stops waiting', async () => {
  const api = fakeApi({ 'GET https://203-0-113-7.sslip.io/health': () => 'throw' })
  let rental: DoRental
  rental = rentalWith(api, { sleep: async () => rental.cancel() })
  await rental.connect(TOKEN)
  await assert.rejects(rental.create({ name: 'A', region: 'ams3', size: 's-1vcpu-1gb', userData: USER_DATA }, () => undefined), (e: DoError) => e.code === 'cancelled')
  assert.equal(rental.busy, false)
  assert.equal(rental.created.dropletId, 4242)
})

test('stopping while the droplet is being created still deletes it once it exists', async () => {
  let release: () => void = () => undefined
  const api = fakeApi()
  const slow = (async (input: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && String(input).endsWith('/v2/droplets')) await new Promise<void>((r) => (release = r))
    return api.fetcher(input, init)
  }) as typeof fetch
  const rental = new DoRental({ fetch: slow, sleep: instant })
  await rental.connect(TOKEN)
  const creating = rental.create({ name: 'A', region: 'ams3', size: 's-1vcpu-1gb', userData: USER_DATA }, () => undefined)
  await new Promise((r) => setTimeout(r, 5))
  const cleaning = rental.cleanUp()
  release()
  await assert.rejects(creating, (e: DoError) => e.code === 'cancelled')
  assert.deepEqual(await cleaning, { droplet: true, firewall: true })
  assert.deepEqual(api.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/v2/droplets`, `DELETE ${BASE}/v2/droplets/4242`])
  assert.deepEqual(rental.created, {})
})

test('bad create input is refused before anything is created', async () => {
  const api = fakeApi()
  const rental = rentalWith(api)
  await assert.rejects(rental.create({ name: 'A', region: 'ams3', size: 's-1vcpu-1gb', userData: USER_DATA }, () => undefined), (e: DoError) => e.code === 'token')
  await rental.connect(TOKEN)
  const bad = [
    { region: 'ams3/../x', size: 's-1vcpu-1gb', userData: USER_DATA },
    { region: 'ams3', size: 'S 1', userData: USER_DATA },
    { region: 'ams3', size: 's-1vcpu-1gb', userData: 'not a script' },
    { region: 'ams3', size: 's-1vcpu-1gb', userData: '#!/bin/bash\n' + 'x'.repeat(70_000) },
  ]
  for (const o of bad) await assert.rejects(rental.create({ name: 'A', ...o }, () => undefined), (e: DoError) => e.code === 'invalid')
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0)
})

test('the token is never logged, kept or handed out, and forget drops it', async () => {
  const api = fakeApi({ 'POST /v2/firewalls': () => ({ status: 403, json: { message: `nope ${TOKEN}` } }) })
  const rental = rentalWith(api)
  const said = await consoleDuring(async () => {
    await rental.connect(TOKEN)
    await rental.create({ name: 'A', region: 'ams3', size: 's-1vcpu-1gb', userData: USER_DATA }, (p) => assert.ok(!JSON.stringify(p).includes(TOKEN)))
  })
  assert.ok(!said.includes(TOKEN))
  assert.ok(!JSON.stringify(rental).includes(TOKEN))
  assert.ok(!JSON.stringify(rental.created).includes(TOKEN))
  assert.ok(!Object.values(rental).some((v) => JSON.stringify(v ?? null).includes(TOKEN)))
  rental.forget()
  assert.equal(rental.connected, false)
  await assert.rejects(rental.cleanUp(), (e: DoError) => e.code === 'token')
  // Nothing in the module writes files or logs.
  const source = readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8')
  assert.doesNotMatch(source, /require\("(node:)?fs"\)|console\.|localStorage|safeStorage/)
})

test('the token is forgotten by itself after a while', async () => {
  const rental = rentalWith(fakeApi(), { tokenLifetimeMs: 5 })
  await rental.connect(TOKEN)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(rental.connected, false)
})

test('a fake API only in tests, only on loopback, never in a packaged app', () => {
  const env = { ISKRA_E2E: '1', ISKRA_DO_API: 'http://127.0.0.1:5191', ISKRA_DO_SERVER_URL: 'http://localhost:4000' }
  const o = testOverrides(env, false)
  assert.equal(o.base, 'http://127.0.0.1:5191')
  assert.equal(o.serverUrl?.('203.0.113.7'), 'http://localhost:4000')
  assert.deepEqual(testOverrides(env, true), {})
  assert.deepEqual(testOverrides({ ...env, ISKRA_E2E: undefined }, false), {})
  assert.deepEqual(testOverrides({ ISKRA_E2E: '1', ISKRA_DO_API: 'http://evil.example:80', ISKRA_DO_SERVER_URL: 'https://127.0.0.1:1' }, false), {})
  assert.deepEqual(testOverrides({ ISKRA_E2E: '1', ISKRA_DO_API: 'http://127.0.0.1:1@evil.example' }, false), {})
})
