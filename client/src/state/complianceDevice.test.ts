import { describe, expect, it, vi } from 'vitest'

vi.mock('../core/storage', () => ({
  // Right after joining, the saved list still has the address as the name.
  loadServers: async () => [{ url: 'http://localhost:4000', serverKey: 'srv', name: 'localhost:4000' }],
  loadProfile: async () => undefined,
  loadFriends: async () => [],
  loadBlocks: async () => [],
  loadDmHistory: async () => ({}),
  loadGroups: async () => [],
  loadPrivate: async () => undefined,
}))
vi.mock('./store', () => ({
  useApp: { getState: () => ({ identity: null, servers: { srv: { name: 'Data Night' } } }) },
  connectionFor: () => undefined,
}))

describe('collectDeviceExport', () => {
  it("uses the server's live name when the saved list hasn't caught up", async () => {
    const { collectDeviceExport } = await import('./compliance')
    const exported = await collectDeviceExport(1)
    expect(exported.servers.map((s) => s.name)).toEqual(['Data Night'])
  })
})
