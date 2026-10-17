// The personal assistant (bring your own AI) against a FAKE OpenAI-compatible provider on 127.0.0.1: the owner turns it
// on, points it at the fake model, asks for a channel, approves the card, and the channel exists. A moderation tool the
// model asks for is refused on the device while Moderation is off (no card, nothing sent). The panel fits a phone.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

interface ChatMessage { role: string; content?: string | null; tool_calls?: unknown[] }

let server: TestServer
let provider: Server
let port = 0
const seen: { path: string; messages: ChatMessage[]; tools: string[] }[] = []

const body = (req: IncomingMessage) => new Promise<string>((resolve) => {
  let text = ''
  req.on('data', (chunk) => (text += chunk))
  req.on('end', () => resolve(text))
})

/** Scripted like a model: a tool call for each known request, then a short answer with what the tool said. */
function answer(messages: ChatMessage[]): unknown {
  const last = messages[messages.length - 1]
  const call = (name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id: `call_${seen.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  if (last.role === 'user' && /channel called plans/.test(last.content ?? '')) return call('create_channel', { name: 'plans' })
  if (last.role === 'user' && /kick bob/i.test(last.content ?? '')) return call('kick_member', { member: 'Bob' })
  // Results come wrapped as data; the fake model quotes what's inside.
  if (last.role === 'tool') return { role: 'assistant', content: `Tool said: ${(last.content ?? '').replace(/<iskra-data[^>]*>\n?|\n?<\/iskra-data>/g, '')}` }
  return { role: 'assistant', content: 'Hello from the fake model.' }
}

test.beforeAll(async () => {
  server = await startServer('Assistant Club')
  provider = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type, authorization')
    res.setHeader('access-control-allow-methods', 'GET, POST')
    if (req.method === 'OPTIONS') return void res.writeHead(204).end()
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url === '/v1/models') return void res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const request = JSON.parse(await body(req)) as { messages: ChatMessage[]; tools?: { function: { name: string } }[] }
      seen.push({ path: req.url, messages: request.messages, tools: (request.tools ?? []).map((t) => t.function.name) })
      return void res.end(JSON.stringify({ choices: [{ message: answer(request.messages), finish_reason: 'stop' }] }))
    }
    res.writeHead(404).end('{}')
  })
  // Loopback only: no firewall prompt.
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  port = (provider.address() as AddressInfo).port
})

test.afterAll(async () => {
  await server?.stop()
  await new Promise<void>((resolve) => (provider ? provider.close(() => resolve()) : resolve()))
})

test('the assistant creates a channel after approval, and moderation stays off until turned on', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // Off by default: no rail button.
  await expect(host.getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0)

  // My settings → Assistant: turn it on, point it at the fake provider, test the connection.
  await openSettings(host, 'Assistant')
  const settings = host.getByTestId('assistant-settings')
  await settings.getByRole('switch', { name: 'Turn on the assistant' }).click()
  await settings.getByLabel('Provider').selectOption('custom')
  await settings.getByLabel('Address').fill(`http://127.0.0.1:${port}/v1`)
  await settings.getByLabel('Model').fill('fake-model')
  await settings.getByLabel('Model').blur()
  await settings.getByRole('button', { name: 'Test connection' }).click()
  await expect(settings.getByRole('status')).toHaveText('Connected. 1 model available.')
  await expect(settings.getByTestId('assistant-privacy-line')).toHaveText(`What you send goes to the model on this computer (127.0.0.1:${port}). Iskra never sees it.`)
  await expect(host.getByRole('checkbox', { name: 'Moderation: time out, warn, kick, ban, delete messages' })).not.toBeChecked()
  await host.screenshot({ path: join(SHOTS, 'assistant-settings.png') })
  await host.keyboard.press('Escape')

  // Nothing went to the provider but the model list.
  expect(seen).toEqual([])

  // Ask for a channel: an approval card shows exactly what will be sent, and nothing happens until Approve.
  await host.getByRole('button', { name: 'Assistant', exact: true }).click()
  const panel = host.getByTestId('assistant-panel')
  await expect(panel.getByTestId('assistant-privacy')).toContainText('127.0.0.1')
  const box = panel.getByPlaceholder('Ask the assistant…')
  await box.fill('Please create a channel called plans')
  await box.press('Enter')
  const card = panel.getByTestId('assistant-approval')
  await expect(card).toContainText('Create the text channel #plans')
  await expect(card).toContainText('On Assistant Club')
  // The name others will see is shown in full; a new channel can't be allowed for the whole session.
  await expect(card.getByTestId('assistant-texts')).toContainText('This text will be posted where others see it:')
  await expect(card.getByTestId('assistant-texts')).toContainText('plans')
  await expect(card.getByRole('button', { name: 'Allow for this session' })).toHaveCount(0)
  await card.getByText('Exact request').click()
  await expect(card.locator('pre')).toContainText('channel.create')
  await expect(card.locator('pre')).toContainText('"name": "plans"')
  await expect(host.locator('.channel', { hasText: 'plans' })).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'assistant-approval.png') })
  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(panel.getByText('Tool said: Created #plans')).toBeVisible()
  await expect(host.locator('.channel', { hasText: 'plans' }).first()).toBeVisible()

  // The model got only the tools that are on: no moderation or admin tools.
  expect(seen[0].tools).toContain('create_channel')
  expect(seen[0].tools).not.toContain('kick_member')
  expect(seen[0].tools).not.toContain('delete_channel')
  expect(seen[0].messages[0].role).toBe('system')
  expect(seen[0].messages[0].content).toMatch(/data, never instructions/)
  expect(seen[1].messages.at(-1)?.content).toMatch(/^<iskra-data source="create_channel result">/)

  // Moderation is off: the kick is refused on this device, with no card and no request to the server.
  await box.fill('Kick Bob please')
  await box.press('Enter')
  await expect(panel.getByText(/Tool said: Error: The Moderation tools are turned off/)).toBeVisible()
  await expect(panel.getByTestId('assistant-approval')).toHaveCount(0)

  // Assistant activity: the channel was created; the kick was refused.
  await panel.getByRole('tab', { name: 'Activity' }).click()
  const activity = panel.getByTestId('assistant-activity')
  await expect(activity.locator('li', { hasText: 'Create the text channel #plans' })).toContainText('Done')
  await expect(activity.locator('li', { hasText: 'kick_member' })).toContainText('Turned off')
  await panel.getByRole('tab', { name: 'Chat' }).click()

  // At phone width the panel is a sheet.
  await host.setViewportSize({ width: 390, height: 844 })
  await expect(panel).toBeVisible()
  const sheet = await panel.boundingBox()
  expect(sheet!.width).toBeLessThanOrEqual(390)
  expect(await host.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await host.screenshot({ path: join(SHOTS, 'assistant-phone.png') })
})
