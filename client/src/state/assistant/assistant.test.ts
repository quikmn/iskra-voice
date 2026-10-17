import { describe, expect, it, vi } from 'vitest'
import { mcpRequest, newConversation, parseConfig, runner, saveConfig, useAssistant, validHistory } from './assistant'
import { DEFAULT_CONFIG } from './types'

// The vault is locked in tests: settings are saved to nowhere.
vi.mock('../../core/storage', async (original) => ({
  ...(await original<typeof import('../../core/storage')>()),
  saveAssistant: vi.fn(async () => undefined),
  loadAssistant: vi.fn(async () => undefined),
  clearAssistant: vi.fn(async () => undefined),
}))

describe('assistant state', () => {
  it('local MCP clients get nothing while the assistant or MCP is off', async () => {
    useAssistant.setState({ config: { ...DEFAULT_CONFIG, enabled: false, mcp: true } })
    expect(await mcpRequest('list', undefined, undefined)).toEqual({ error: 'off' })
    useAssistant.setState({ config: { ...DEFAULT_CONFIG, enabled: true, mcp: false } })
    expect(await mcpRequest('call', 'create_channel', { name: 'x' })).toEqual({ error: 'off' })
    useAssistant.setState({ config: { ...DEFAULT_CONFIG, enabled: true, mcp: true } })
    const listed = (await mcpRequest('list', undefined, undefined)) as { tools: { name: string }[] }
    expect(listed.tools.map((t) => t.name)).toContain('create_channel')
    expect(listed.tools.map((t) => t.name)).not.toContain('ban_member')
    const refused = await mcpRequest('call', 'ban_member', { member: 'x' })
    expect(refused).toEqual({ content: expect.stringMatching(/turned off/), isError: true })
    expect(await mcpRequest('nope', undefined, undefined)).toEqual({ error: 'bad_request' })
  })

  it('a saved key goes with its address: changing the address to another origin drops it', async () => {
    useAssistant.setState({ config: { ...DEFAULT_CONFIG, enabled: true } })
    expect((await saveConfig({ key: 'sk-ant-1' })).keyDropped).toBe(false)
    expect(useAssistant.getState().config).toMatchObject({ key: 'sk-ant-1', keyOrigin: 'https://api.anthropic.com' })
    expect((await saveConfig({ baseUrl: 'https://api.anthropic.com/v1' })).keyDropped).toBe(false) // same origin
    expect(useAssistant.getState().config.key).toBe('sk-ant-1')
    expect(await saveConfig({ preset: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' })).toEqual({ keyDropped: true, baseRefused: false })
    expect(useAssistant.getState().config).toMatchObject({ key: '', keyOrigin: '' })
    // Stored without an origin (or for another one): never used.
    expect(parseConfig({ key: 'k', baseUrl: 'https://api.openai.com/v1' }).key).toBe('')
    expect(parseConfig({ key: 'k', keyOrigin: 'https://api.anthropic.com', baseUrl: 'https://api.openai.com/v1' }).key).toBe('')
  })

  it('a new conversation forgets session grants; turning MCP off denies its waiting cards', async () => {
    const clear = vi.spyOn(runner, 'clearSession')
    newConversation()
    expect(clear).toHaveBeenCalled()
    useAssistant.setState({ config: { ...DEFAULT_CONFIG, enabled: true, mcp: true } })
    const pending = runner.call('move_category', { category: 'x' }, 'mcp') // no server open: refused before a card
    expect((await pending).isError).toBe(true)
    const card = { id: 'm1', tool: 'move_channel', category: 'organize' as const, risk: 'low' as const, source: 'mcp' as const, serverName: null, summary: { key: 'x', args: {} }, texts: [], grantable: false }
    const chat = { ...card, id: 'c1', source: 'chat' as const }
    useAssistant.setState({ approvals: [card, chat] })
    await saveConfig({ mcp: false })
    expect(useAssistant.getState().approvals.map((a) => a.id)).toEqual(['c1'])
  })

  it('stored settings are read defensively, off by default', () => {
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG)
    expect(parseConfig({ enabled: 'yes', moderation: 1, kind: 'other', key: 5 })).toMatchObject({ enabled: false, moderation: false, kind: 'anthropic', key: '' })
  })

  it('a failed send never leaves a tool call without its result in the history', () => {
    const user = { role: 'user' as const, text: 'hi' }
    expect(validHistory([user, { role: 'assistant', text: '', toolCalls: [{ id: '1', name: 'x', args: {} }], raw: null }])).toEqual([user])
    expect(validHistory([user, { role: 'assistant', text: 'ok', toolCalls: [], raw: null }])).toHaveLength(2)
  })
})
