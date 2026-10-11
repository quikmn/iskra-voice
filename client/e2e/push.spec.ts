import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { agreeToTerms, joinVia, SHOTS, startServer, type TestServer } from './helpers'

// Full Chromium (new headless): the headless shell always reports notifications as denied.
test.use({ channel: 'chromium' })

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Push Test')
})
test.afterAll(async () => server?.stop())

/** Every JSON frame the page sends and receives on its server connections. */
function recordFrames(page: Page) {
  const sent: { type: string; id?: string; body?: Record<string, unknown> }[] = []
  const received: { type: string; id?: string; body?: Record<string, unknown> }[] = []
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => typeof f.payload === 'string' && sent.push(JSON.parse(f.payload)))
    ws.on('framereceived', (f) => typeof f.payload === 'string' && received.push(JSON.parse(f.payload)))
  })
  return { sent, received }
}

test('installable app: manifest and icons are served', async ({ page }) => {
  await page.goto('/')
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  const manifest = await (await page.request.get(href!)).json()
  expect(manifest).toMatchObject({ name: 'Iskra', short_name: 'Iskra', display: 'standalone', start_url: '/' })
  expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true)
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src)
    expect(response.ok(), icon.src).toBe(true)
  }
  const touchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
  expect((await page.request.get(touchIcon!)).headers()['content-type']).toContain('image/png')
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes')
})

test('turning on push registers a worker per server, subscribes, and reports focus', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['notifications'] })
  // Headless Chromium has no push service to talk to, so the browser's subscribe() hands out a stand-in
  // subscription with a real push-service endpoint shape. Everything else (worker, server requests) is real.
  // The stand-in survives reloads (like a real subscription), in localStorage.
  await context.addInitScript(() => {
    const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const fromB64u = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    const STORE = 'e2e.fakePushSubscription'
    type Saved = { endpoint: string; key: string; p256dh: string; auth: string }
    const wrap = (saved: Saved) => ({
      endpoint: saved.endpoint,
      options: { applicationServerKey: fromB64u(saved.key).buffer, userVisibleOnly: true },
      toJSON: () => ({ endpoint: saved.endpoint, keys: { p256dh: saved.p256dh, auth: saved.auth } }),
      unsubscribe: async () => (localStorage.removeItem(STORE), true),
    }) as unknown as PushSubscription
    PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
      const p256dh = new Uint8Array(65)
      p256dh[0] = 4
      crypto.getRandomValues(p256dh.subarray(1))
      const saved: Saved = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-' + Math.random().toString(36).slice(2),
        key: b64u(new Uint8Array(options!.applicationServerKey as Uint8Array)),
        p256dh: b64u(p256dh),
        auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
      }
      localStorage.setItem(STORE, JSON.stringify(saved))
      return wrap(saved)
    }
    PushManager.prototype.getSubscription = async () => {
      const saved = localStorage.getItem(STORE)
      return saved ? wrap(JSON.parse(saved)) : null
    }
  })
  const page = await context.newPage()
  const frames = recordFrames(page)
  await joinVia(page, server.ownerLink(), 'Host')
  const serverKey = frames.received.find((f) => f.type === 'hello')!.body!.serverKey as string

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Notifications' }).click()
  await page.getByLabel('Push notifications on this device').check()
  await expect(page.getByText('On for 1 server')).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'push-settings.png') })

  // One worker registration for this server, with push-sw.js active.
  const scopes = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, script: r.active?.scriptURL ?? null })),
  )
  expect(scopes).toContainEqual({ scope: `${new URL(page.url()).origin}/push/${serverKey}/`, script: `${new URL(page.url()).origin}/push-sw.js` })

  // The server got the subscription and accepted it, then heard that this device is focused.
  const subscribe = frames.sent.find((f) => f.type === 'push.subscribe')!
  expect(subscribe.body!.endpoint).toMatch(/^https:\/\/fcm\.googleapis\.com\/fcm\/send\/e2e-/)
  await expect.poll(() => frames.received.some((f) => f.type === 'error')).toBe(false)
  await expect.poll(() => frames.sent.some((f) => f.type === 'push.focus')).toBe(true)
  // A push reaches the worker (delivered through DevTools, as the push service would) and becomes a notification.
  const cdp = await context.newCDPSession(page)
  const registrationId = await new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const reg = registrations.find((r: { scopeURL: string }) => r.scopeURL.endsWith(`/push/${serverKey}/`))
      if (reg) resolve(reg.registrationId)
    })
    void cdp.send('ServiceWorker.enable')
  })
  const payload = { v: 1, kind: 'mention', server: serverKey, title: 'Friend in #general', body: 'hey @Host', tag: 'c:1', channelId: 1, count: 1, at: Date.now() }
  // Delivered again while nothing shows: a push that arrives before the worker is running can be dropped
  // (same tag, so repeats replace each other).
  await expect
    .poll(async () => {
      await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(page.url()).origin, registrationId, data: JSON.stringify(payload) })
      return page.evaluate(async (scope) => {
        const reg = await navigator.serviceWorker.getRegistration(scope)
        return (await reg!.getNotifications()).map((n) => ({ title: n.title, body: n.body, route: n.data?.route }))
      }, `/push/${serverKey}/`)
    })
    .toContainEqual({ title: 'Friend in #general', body: 'hey @Host', route: `/open/${serverKey}/c/1` })

  // After a reload the device is still subscribed: the server already has this endpoint, so nothing is re-sent.
  await page.reload()
  await expect.poll(() => frames.sent.filter((f) => f.type === 'push.status').length).toBe(2)
  const statusId = frames.sent.filter((f) => f.type === 'push.status')[1].id
  await expect.poll(() => frames.received.findLast((f) => f.id === statusId)?.body?.endpoint).toBe(subscribe.body!.endpoint)
  await expect.poll(() => frames.sent.filter((f) => f.type === 'push.focus').length).toBe(2)
  expect(frames.sent.filter((f) => f.type === 'push.subscribe')).toHaveLength(1)

  // Opening Iskra from a notification goes to the right channel.
  await page.getByRole('button', { name: 'Create channel' }).click()
  await page.getByLabel('Name').fill('off-topic')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'off-topic' })).toBeVisible()
  const general = frames.received.find((f) => f.type === 'welcome')!.body!.channels as { id: number; name: string }[]
  await page.goto(`/#/open/${serverKey}/c/${general.find((c) => c.name === 'general')!.id}`)
  await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
  expect(new URL(page.url()).hash).toBe('')

  // Turning it off unsubscribes on the server and removes the worker.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Notifications' }).click()
  await page.getByLabel('Push notifications on this device').uncheck()
  await expect.poll(() => frames.sent.some((f) => f.type === 'push.unsubscribe')).toBe(true)
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0)
  await context.close()
})

test('on iPhone, Safari explains Add to Home Screen first', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    hasTouch: true,
    isMobile: true,
  })
  // A Safari tab (not added to the Home Screen) has no push.
  await context.addInitScript(() => {
    delete (window as { PushManager?: unknown }).PushManager
    delete (window as { Notification?: unknown }).Notification
  })
  const page = await context.newPage()
  await page.goto('/')
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill('Phone')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Notifications' }).click()
  await expect(page.getByText('add Iskra to your Home Screen first')).toBeVisible()
  await expect(page.getByLabel('Push notifications on this device')).toHaveCount(0)
  await page.screenshot({ path: join(SHOTS, 'push-ios-hint.png'), animations: 'disabled' })
  await context.close()
})
