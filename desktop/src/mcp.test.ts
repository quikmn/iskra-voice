import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { checkProof, LineReader, MAX_LINE, McpSession, newToken, pageAnswer, proof, type PageLink } from './mcp'
import { McpHost, mcpSocketPath, mcpTokenPath, openChannel, runBridge } from './mcpPipe'

const tools = [{ name: 'list_channels', description: 'Lists channels', schema: { type: 'object', properties: {} } }]

function session(link: PageLink | null) {
  const out: unknown[] = []
  const s = new McpSession(link, (line) => out.push(JSON.parse(line)), '2.0.0-test')
  return { s, out }
}

test('line framing: splits lines, keeps partial ones, drops oversized input', () => {
  const lines: string[] = []
  let tooLong = 0
  const reader = new LineReader((l) => lines.push(l), () => tooLong++)
  reader.push('{"a":1}\n{"b"')
  reader.push(':2}\r\n\n')
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
  reader.push('x'.repeat(MAX_LINE + 1))
  assert.equal(tooLong, 1)
  reader.push('{"c":3}\n')
  assert.equal(lines.length, 2) // dead after an oversized line
})

test('handshake proofs: each side, each nonce, the right token', () => {
  const token = newToken()
  const p = proof(token, 'client', 'a'.repeat(32))
  assert.ok(checkProof(token, 'client', 'a'.repeat(32), p))
  assert.ok(!checkProof(token, 'server', 'a'.repeat(32), p))
  assert.ok(!checkProof(token, 'client', 'b'.repeat(32), p))
  assert.ok(!checkProof(newToken(), 'client', 'a'.repeat(32), p))
  assert.ok(!checkProof(token, 'client', 'a'.repeat(32), 'nope'))
})

test('JSON-RPC: initialize, ping, tools/list and tools/call through the page', async () => {
  const calls: [string, unknown][] = []
  const { s, out } = session({
    list: async () => ({ tools }),
    call: async (name, args) => (calls.push([name, args]), { content: 'Created #plans', isError: false }),
  })
  await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))
  await s.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }))
  await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }))
  await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_channel', arguments: { name: 'plans' } } }))
  await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/list' }))
  await s.handle('not json')
  const [init, ping, list, call, unknown, parse] = out as { id: unknown; result?: Record<string, unknown>; error?: { code: number } }[]
  assert.equal((init.result as { protocolVersion: string }).protocolVersion, '2025-06-18')
  assert.deepEqual((init.result as { serverInfo: unknown }).serverInfo, { name: 'iskra', version: '2.0.0-test' })
  assert.deepEqual(ping.result, {})
  assert.deepEqual(list.result, { tools: [{ name: 'list_channels', description: 'Lists channels', inputSchema: { type: 'object', properties: {} } }] })
  assert.deepEqual(call.result, { content: [{ type: 'text', text: 'Created #plans' }], isError: false })
  assert.deepEqual(calls, [['create_channel', { name: 'plans' }]])
  assert.equal(unknown.error?.code, -32601)
  assert.equal(parse.error?.code, -32700)
  assert.equal(out.length, 6) // the notification got no answer
})

test('JSON-RPC: refuses when off (no page, or the page says off)', async () => {
  for (const link of [null, { list: async () => ({ error: 'off' }), call: async () => ({ error: 'off' }) }] as (PageLink | null)[]) {
    const { s, out } = session(link)
    await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kick_member', arguments: {} } }))
    const [list, call] = out as { result: { tools?: unknown[]; isError?: boolean; content?: { text: string }[] } }[]
    assert.deepEqual(list.result.tools, [])
    assert.equal(call.result.isError, true)
    assert.match(call.result.content![0].text, /Allow local MCP clients/)
  }
})

test('the page answer is checked before it goes out', () => {
  assert.deepEqual(pageAnswer({ error: 'off' }), { error: 'off' })
  assert.deepEqual(pageAnswer({ content: 'ok', isError: false, extra: 1 }), { content: 'ok', isError: false })
  assert.deepEqual(pageAnswer({ tools: [...tools, { name: 1 }] }), { tools })
  assert.deepEqual(pageAnswer(null), { error: 'failed' })
})

function folder() {
  const dir = mkdtempSync(path.join(tmpdir(), 'iskra-mcp-'))
  return { dir, socketPath: mcpSocketPath(dir), tokenFile: mcpTokenPath(dir) }
}

test('the local channel: an approval round trip from the bridge to the page and back', async () => {
  const { dir, socketPath, tokenFile } = folder()
  let approve: ((value: { content: string; isError: boolean }) => void) | null = null
  const host = new McpHost({
    socketPath, tokenFile, version: '2.0.0-test',
    // The page holds the call until the user approves it in the Iskra window.
    link: () => ({ list: async () => ({ tools }), call: () => new Promise((resolve) => (approve = resolve)) }),
  })
  await host.start()
  try {
    if (process.platform !== 'win32') assert.equal((await import('node:fs')).statSync(socketPath).mode & 0o777, 0o600)
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: Record<string, unknown>[] = []
    output.on('data', (chunk: Buffer) => chunk.toString().split('\n').filter(Boolean).forEach((l) => lines.push(JSON.parse(l))))
    const done = runBridge({ socketPath, tokenFile, version: 'x', input, output })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_channel', arguments: { name: 'plans' } } })}\n`)
    await waitFor(() => approve !== null)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(lines.length, 0) // still waiting for approval
    approve!({ content: 'Created #plans', isError: false })
    await waitFor(() => lines.length === 1)
    assert.deepEqual(lines[0], { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Created #plans' }], isError: false } })
    input.end()
    await done
  } finally {
    await host.stop()
    assert.ok(!existsSync(tokenFile))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the local channel: a wrong token, or a server that is not Iskra, gets nothing', async () => {
  const { dir, socketPath, tokenFile } = folder()
  const host = new McpHost({ socketPath, tokenFile, version: 'x', link: () => ({ list: async () => ({ tools }), call: async () => ({ content: 'no', isError: false }) }) })
  await host.start()
  try {
    // A client with the wrong token is cut off before it can send anything.
    const wrong = path.join(dir, 'wrong-token')
    writeFileSync(wrong, newToken())
    assert.deepEqual(await openChannel({ socketPath, tokenFile: wrong }), { error: 'socket' })
    // The right one gets in.
    const ok = await openChannel({ socketPath, tokenFile })
    assert.ok('socket' in ok)
    if ('socket' in ok) ok.socket.destroy()
  } finally {
    await host.stop()
  }
  // Off: no token file, no channel; the bridge answers by itself with no tools.
  assert.deepEqual(await openChannel({ socketPath, tokenFile }), { error: 'off' })
  // Something else took the name: it can't prove it knows the token, so the bridge never trusts it.
  const token = newToken()
  writeFileSync(tokenFile, token)
  const fake = net.createServer((socket) => {
    socket.write(`${JSON.stringify({ iskra: 'mcp-1', nonce: 'c'.repeat(32) })}\n`)
    socket.once('data', () => socket.write(`${JSON.stringify({ ok: true, proof: 'f'.repeat(64) })}\n`))
  })
  await new Promise<void>((resolve) => fake.listen(socketPath, resolve))
  try {
    assert.deepEqual(await openChannel({ socketPath, tokenFile }), { error: 'auth' })
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
