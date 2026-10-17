import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AssistantBase, checkAssistantRequest, checkBase, endpointsFor, sendAssistantRequest } from './assistantNet'

const post = (url: string, headers: Record<string, string> = {}) => ({ url, method: 'POST', headers, body: '{}' })

test('only https (or this computer) can be registered as the provider address', () => {
  assert.equal(checkBase('https://api.anthropic.com/'), 'https://api.anthropic.com')
  assert.equal(checkBase('http://localhost:11434/v1'), 'http://localhost:11434/v1')
  for (const bad of ['http://api.openai.com/v1', 'http://192.168.1.10/v1', 'https://u:p@x.example', 'https://x.example/v1?k=1', 'file:///etc', 42]) assert.equal(checkBase(bad), null)
})

test('only the registered address and its exact endpoints', () => {
  const anthropic = 'https://api.anthropic.com'
  assert.ok(checkAssistantRequest(post('https://api.anthropic.com/v1/messages'), anthropic))
  assert.ok(checkAssistantRequest({ url: 'https://api.anthropic.com/v1/models', method: 'GET', headers: {} }, anthropic))
  const ollama = 'http://localhost:11434/v1'
  assert.deepEqual(endpointsFor(ollama), ['http://localhost:11434/v1/messages', 'http://localhost:11434/v1/models', 'http://localhost:11434/v1/chat/completions', 'http://localhost:11434/v1/models'])
  assert.ok(checkAssistantRequest(post('http://localhost:11434/v1/chat/completions'), ollama))
  for (const [url, base] of [
    ['https://api.openai.com/v1/chat/completions', anthropic], // another host than the registered one
    ['http://localhost:9999/v1/chat/completions', ollama], // another port on this computer
    ['https://api.anthropic.com/other/v1/messages', anthropic], // a path that only ends like an endpoint
    ['https://api.anthropic.com/v1/files', anthropic],
    ['https://api.anthropic.com/v1/messages', null], // nothing registered
  ] as [string, string | null][]) assert.equal(checkAssistantRequest(post(url), base), null, url)
  assert.equal(checkAssistantRequest({ url: 'https://api.anthropic.com/v1/messages', method: 'DELETE', headers: {} }, anthropic), null)
})

test('only the provider headers go out', () => {
  const r = checkAssistantRequest(post('https://api.anthropic.com/v1/messages', {
    'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', cookie: 'a=b', host: 'evil', 'x-bad': 'a\r\nb',
  }), 'https://api.anthropic.com')
  assert.deepEqual(r?.headers, { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' })
})

test('sends with no redirects, stops reading a too-big answer, and says why it failed', async () => {
  const base = 'https://api.openai.com/v1'
  let seen: RequestInit | undefined
  const ok = await sendAssistantRequest(post(`${base}/chat/completions`), base, (async (_url: unknown, init?: RequestInit) => {
    seen = init
    return new Response('{"choices":[]}', { status: 200 })
  }) as typeof fetch)
  assert.deepEqual(ok, { ok: true, status: 200, body: '{"choices":[]}' })
  assert.equal(seen?.redirect, 'error')
  // No content-length, endless body: reading stops at the cap.
  let pulled = 0
  const endless = new ReadableStream<Uint8Array>({ pull: (c) => { pulled++; c.enqueue(new Uint8Array(1024 * 1024)) } })
  assert.deepEqual(await sendAssistantRequest(post(`${base}/chat/completions`), base, (async () => new Response(endless)) as typeof fetch), { ok: false, error: 'too-big' })
  assert.ok(pulled <= 8)
  assert.deepEqual(await sendAssistantRequest(post('https://evil.example/v1/chat/completions'), base), { ok: false, error: 'blocked' })
  assert.deepEqual(await sendAssistantRequest(post(`${base}/chat/completions`), base, (async () => { throw new TypeError('fetch failed') }) as typeof fetch), { ok: false, error: 'network' })
})

test('the registered address is kept in the data folder', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iskra-ai-'))
  const file = path.join(dir, 'assistant.json')
  const base = new AssistantBase(file)
  assert.equal(base.current, null)
  base.set('https://api.anthropic.com/')
  assert.equal(new AssistantBase(file).current, 'https://api.anthropic.com')
  base.set('http://evil.example')
  assert.equal(base.current, null)
  assert.ok(!existsSync(file))
  rmSync(dir, { recursive: true, force: true })
})
