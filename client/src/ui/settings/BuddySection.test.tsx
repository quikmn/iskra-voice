// @vitest-environment happy-dom
// Security review R2-3: a pairing code that points at the local network or plain http is only used after the owner's yes.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '../../core/protocol'

const b64u = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const CODE = `iskra-buddy:${b64u(JSON.stringify({ v: 1, url: 'http://192.168.1.20:47070', key: 'k', token: 't' }))}`

const addBuddy = vi.fn(async (_server: string, _code: string, _allowLocal?: boolean): Promise<string | null> => null)
vi.mock('../../state/buddies', async (original) => {
  const real = await original<typeof import('../../state/buddies')>()
  const state = {
    status: { s: { buddies: [], autoEnabled: true, recoveryCodeSet: true } },
    spots: { s: { spots: [] } },
  }
  return {
    ...real,
    addBuddy,
    loadBuddies: vi.fn(async () => state.status.s),
    loadSpots: vi.fn(async () => state.spots.s),
    useBuddies: (pick: (s: typeof state) => unknown) => pick(state),
  }
})

const { BuddySection } = await import('./BuddySection')

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('pairing with a backup buddy', () => {
  it('asks before pairing with an address on the local network, then sends the yes', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    addBuddy.mockRejectedValueOnce(new RequestError('bad_request', 'That code points to 192.168.1.20, an address on a local network. Pair only if you trust it.', 'buddy.add', 'buddy_address_local', { host: '192.168.1.20' }))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<BuddySection server={{ key: 's' } as never} />))
    const section = host.querySelector('[data-testid="buddy-section"]')!
    act(() => type(section.querySelector('input')!, CODE))
    const button = () => section.querySelector<HTMLButtonElement>('[data-testid="buddy-add"]')!

    await act(async () => button().click())
    await settle()
    expect(addBuddy).toHaveBeenLastCalledWith('s', CODE, false)
    expect(section.querySelector('[role="alert"]')?.textContent).toContain('192.168.1.20')
    expect(button().textContent).toBe('Pair anyway')

    await act(async () => button().click())
    await settle()
    expect(addBuddy).toHaveBeenLastCalledWith('s', CODE, true)
    expect(section.querySelector('[role="alert"]')).toBeNull()
    act(() => root.unmount())
  })
})
