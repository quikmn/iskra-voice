// Outgoing webhooks: the owner sends new messages and joins to a receiver on this computer (allowed with "my own
// network"), the requests are signed, the log shows deliveries, and members see the host in "Who Iskra talks to".
import { createHmac } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

interface Received { headers: IncomingHttpHeaders; body: string }

let server: TestServer
let receiver: Server
let receiverUrl: string
const received: Received[] = []

test.beforeAll(async () => {
  server = await startServer('Hook Night')
  // Loopback only: never anything on 0.0.0.0.
  receiver = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      res.writeHead(200).end()
    })
  })
  await new Promise<void>((done) => receiver.listen(0, '127.0.0.1', done))
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/iskra`
})
test.afterAll(async () => {
  await server?.stop()
  await new Promise((done) => receiver?.close(done))
})

/** The documented check (docs/bots.md): HMAC-SHA256 over the context string, timestamp, id and raw body. */
function signed(r: Received, secret: string): boolean {
  const ts = String(r.headers['iskra-webhook-timestamp'])
  const id = String(r.headers['iskra-webhook-id'])
  const expected = 'v1=' + createHmac('sha256', secret).update(`iskra-webhook-v1\n${ts}\n${id}\n${r.body}`).digest('hex')
  return r.headers['iskra-webhook-signature'] === expected && Math.abs(Date.now() / 1000 - Number(ts)) < 300
}

const ofType = (type: string) => received.filter((r) => JSON.parse(r.body).type === type)

test('an outgoing webhook posts signed events, and members see where they go', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage()
  await joinVia(owner, server.ownerLink(), 'Olga')
  const invite = await createInviteLink(owner)

  const room = await openServerSettings(owner, 'Bots & webhooks')
  await room.getByRole('tab', { name: 'Outgoing' }).click()
  const panel = room.getByTestId('outhooks')
  await expect(panel.getByText('No outgoing webhooks yet.')).toBeVisible()

  // A plain http address needs "my own network" first.
  await panel.getByLabel('Name', { exact: true }).fill('Bridge')
  await panel.getByLabel('Address', { exact: true }).fill(receiverUrl)
  await expect(panel.getByText('Use https://. Plain http:// works only on your own network, with that option on.')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  await panel.getByLabel(/Allow addresses on my own network/).check()
  await panel.getByLabel('Someone joins the server').check()
  await expect(panel.getByLabel('#general')).toBeChecked()
  await panel.getByRole('button', { name: 'Create', exact: true }).click()

  const secretBox = panel.getByLabel('Signing secret')
  await expect(secretBox).toHaveValue(/^whs_[\w-]{43}$/)
  const secret = await secretBox.inputValue()
  const hook = panel.getByTestId('outhook')
  await expect(hook).toContainText('Bridge')
  await expect(hook).toContainText('127.0.0.1')
  await expect(hook).toContainText('own network')
  await secretBox.scrollIntoViewIfNeeded()
  await owner.screenshot({ path: join(SHOTS, 'outgoing-webhooks.png') })
  await panel.getByRole('button', { name: 'Done' }).click()

  // A test ping, answered by the receiver.
  await hook.getByRole('button', { name: 'Send a test' }).click()
  await expect(hook.getByTestId('outhook-test-result')).toHaveText(/^Delivered \(200, \d+ ms\)\.$/)
  expect(ofType('ping')).toHaveLength(1)
  expect(signed(ofType('ping')[0], secret)).toBe(true)
  await owner.keyboard.press('Escape')

  // A message in #general goes out, signed.
  await send(owner, 'hello from the server')
  await expect.poll(() => ofType('message.created').length).toBe(1)
  const message = ofType('message.created')[0]
  expect(signed(message, secret)).toBe(true)
  expect(JSON.parse(message.body).data.message.text).toBe('hello from the server')
  expect(JSON.parse(message.body).data.message.author.name).toBe('Olga')

  // A friend joins (on a phone): that goes out too, and they can see where their server sends things.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, invite, 'Finn')
  await expect.poll(() => ofType('member.joined').length).toBe(1)
  expect(JSON.parse(ofType('member.joined')[0].body).data.member.name).toBe('Finn')
  await phone.getByRole('button', { name: 'Open channels' }).click()
  await openSettings(phone, 'Privacy & data')
  const talks = phone.getByTestId('who-iskra-talks-to')
  await expect(talks.locator('[data-connection="outgoing"]')).toContainText('Outgoing webhooks')
  await expect(talks.getByTestId('outgoing-hosts')).toContainText('Hook Night sends to')
  await expect(talks.getByTestId('outgoing-hosts')).toContainText('127.0.0.1 (Bridge): A message is posted, Someone joins the server')
  await talks.locator('[data-connection="outgoing"]').scrollIntoViewIfNeeded()
  await phone.screenshot({ path: join(SHOTS, 'outgoing-webhooks-who-talks-phone.png') })

  // The log: status only, never what was sent.
  const settings = await openServerSettings(owner, 'Bots & webhooks')
  await settings.getByRole('tab', { name: 'Outgoing' }).click()
  const row = settings.getByTestId('outhook')
  await row.getByRole('button', { name: 'Log' }).click()
  const log = row.getByTestId('outhook-log')
  await expect(log.locator('li')).toHaveCount(3)
  await expect(log).toContainText('Someone joins the server')
  await expect(log).not.toContainText('hello from the server')
  await expect(row.getByTestId('outhook-status')).toContainText('last delivery')
  await row.scrollIntoViewIfNeeded()
  await owner.screenshot({ path: join(SHOTS, 'outgoing-webhooks-log.png') })

  // Turned off, nothing more goes out and members no longer see it.
  await row.getByRole('button', { name: 'Turn off' }).click()
  await expect(row.getByTestId('outhook-status')).toHaveText('Turned off')
  await owner.keyboard.press('Escape')
  await send(owner, 'not sent anywhere')
  await owner.waitForTimeout(500)
  expect(ofType('message.created')).toHaveLength(1)
})
