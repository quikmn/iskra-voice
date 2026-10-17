import { describe, expect, it } from 'vitest'
import { mcpRequest, parseConfig, useAssistant, validHistory } from './assistant'
import { DEFAULT_CONFIG } from './types'

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
