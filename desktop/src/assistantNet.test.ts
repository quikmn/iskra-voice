import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkAssistantRequest, sendAssistantRequest } from './assistantNet'

const post = (url: string, headers: Record<string, string> = {}) => ({ url, method: 'POST', headers, body: '{}' })

test('only https (or this computer), only the provider endpoints', () => {
  assert.ok(checkAssistantRequest(post('https://api.anthropic.com/v1/messages')))
  assert.ok(checkAssistantRequest(post('https://api.openai.com/v1/chat/completions')))
  assert.ok(checkAssistantRequest({ url: 'https://api.mistral.ai/v1/models', method: 'GET', headers: {} }))
  assert.ok(checkAssistantRequest(post('http://localhost:11434/v1/chat/completions')))
  assert.ok(checkAssistantRequest(post('http://127.0.0.1:1234/v1/chat/completions')))
  for (const url of [
    'http://api.openai.com/v1/chat/completions', // plain http elsewhere
    'https://example.com/v1/files', // not an endpoint the assistant uses
    'https://user:pw@api.openai.com/v1/chat/completions',
    'https://api.openai.com/v1/chat/completions?x=1',
    'file:///etc/passwd',
    'http://192.168.1.10/v1/chat/completions', // a LAN address is not this computer
  ]) assert.equal(checkAssistantRequest(post(url)), null, url)
  assert.equal(checkAssistantRequest({ url: 'https://api.openai.com/v1/chat/completions', method: 'DELETE', headers: {} }), null)
})

test('only the provider headers go out', () => {
  const r = checkAssistantRequest(post('https://api.anthropic.com/v1/messages', {
    'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', cookie: 'a=b', host: 'evil', 'x-bad': 'a\r\nb',
  }))
  assert.deepEqual(r?.headers, { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' })
})

test('sends with no redirects, and says why it failed', async () => {
  let seen: RequestInit | undefined
  const ok = await sendAssistantRequest(post('https://api.openai.com/v1/chat/completions'), (async (_url: unknown, init?: RequestInit) => {
    seen = init
    return new Response('{"choices":[]}', { status: 200 })
  }) as typeof fetch)
  assert.deepEqual(ok, { ok: true, status: 200, body: '{"choices":[]}' })
  assert.equal(seen?.redirect, 'error')
  assert.deepEqual(await sendAssistantRequest(post('https://evil.example/steal')), { ok: false, error: 'blocked' })
  assert.deepEqual(await sendAssistantRequest(post('https://api.openai.com/v1/chat/completions'), (async () => { throw new TypeError('fetch failed') }) as typeof fetch), { ok: false, error: 'network' })
})
