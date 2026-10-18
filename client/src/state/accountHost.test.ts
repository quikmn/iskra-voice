// @vitest-environment happy-dom
// The host page with several accounts: which frame gets which link, one account in voice, the badge, and taking an
// account off the device (state/accountHost.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySummary } from '../platform/accountLink'
import { addAccount, REGISTRY_KEY, singleRegistry, updateEntry } from '../platform/accountSlots'
import { choose, confirmLinking, hostApiForTests, incoming, resetHostForTests, registerFrame, useHost, views } from './accountHost'

const KEY_A = 'A'.repeat(43)
const KEY_B = 'B'.repeat(43)

/** A frame's window, as far as the host uses it. */
function fakeFrame(slot: number) {
  const win = { location: { pathname: '/', search: `?account=${slot}`, replace: vi.fn() } } as unknown as Window
  const element = { contentWindow: win, isConnected: true, contentDocument: null } as unknown as HTMLIFrameElement
  registerFrame(slot, element)
  return win
}

function host(slots: number[]) {
  let reg = singleRegistry(slots[0])
  for (const _ of slots.slice(1)) reg = addAccount(reg, 'new')!.registry
  for (const s of slots) reg = updateEntry(reg, s, { adding: undefined })
  useHost.setState({ registry: { ...reg, active: slots[0] } })
  return Object.fromEntries(slots.map((s) => {
    const win = fakeFrame(s)
    return [s, { win, link: hostApiForTests.link(s, win)! }]
  }))
}

beforeEach(() => {
  resetHostForTests()
  localStorage.clear()
})

describe('the host page', () => {
  it("gives each frame its own link, and none to a window that isn't that frame", () => {
    const frames = host([1, 2])
    expect(frames[1].link.slot).toBe(1)
    expect(frames[2].link.slot).toBe(2)
    expect(hostApiForTests.link(2, frames[1].win)).toBeNull() // account 1's page can't get account 2's link
    expect(hostApiForTests.link(3, frames[1].win)).toBeNull() // nor one for an account that isn't here
  })

  it("lists every account with what its page reported, and adds up the unread for the badge and title", () => {
    const { 1: one, 2: two } = host([1, 2])
    one.link.report({ ...emptySummary(), name: 'Ada', key: KEY_A, ready: true, unread: 2, title: '(2) Iskra' })
    two.link.report({ ...emptySummary(), name: 'Bea', key: KEY_B, ready: true, unread: 3 })
    expect(views().map((v) => [v.slot, v.name, v.unread, v.active])).toEqual([[1, 'Ada', 2, true], [2, 'Bea', 3, false]])
    expect(document.title).toBe('(5) Iskra')
    // Names and keys are kept for next time (never anything else).
    const stored = JSON.parse(localStorage.getItem(REGISTRY_KEY)!)
    expect(stored.accounts).toEqual({ 1: { slot: 1, name: 'Ada', key: KEY_A }, 2: { slot: 2, name: 'Bea', key: KEY_B } })
  })

  it('tells every page when the list changes, and switches', () => {
    const { 1: one, 2: two } = host([1, 2])
    const seen: number[][] = []
    one.link.onAccounts((list) => seen.push(list.filter((a) => a.active).map((a) => a.slot)))
    two.link.switchTo(2)
    expect(useHost.getState().registry.active).toBe(2)
    expect(seen.at(-1)).toEqual([2])
    one.link.activate()
    expect(seen.at(-1)).toEqual([1])
  })

  it('keeps one account in voice: joining with another makes the first leave, with the name of the one that joined', () => {
    const { 1: one, 2: two } = host([1, 2])
    one.link.report({ ...emptySummary(), name: 'Ada', ready: true })
    two.link.report({ ...emptySummary(), name: 'Bea', ready: true })
    const left: string[] = []
    one.link.onLeaveVoice((name) => left.push(`ada left for ${name}`))
    two.link.onLeaveVoice((name) => left.push(`bea left for ${name}`))
    expect(one.link.claimVoice()).toBeNull() // nobody else was in voice
    one.link.report({ inVoice: true })
    expect(two.link.claimVoice()).toBe('Ada')
    expect(left).toEqual(['ada left for Bea'])
    one.link.report({ inVoice: false })
    two.link.report({ inVoice: true })
    expect(one.link.claimVoice()).toBe('Bea')
    expect(left).toEqual(['ada left for Bea', 'bea left for Ada'])
  })

  it('asks which account a link is for when there are several, and hands it to that page', () => {
    const { 1: one, 2: two } = host([1, 2])
    incoming({ kind: 'hash', route: '#/join/abc' })
    expect(useHost.getState().choosing).toEqual({ kind: 'hash', route: '#/join/abc' })
    choose(2)
    expect(useHost.getState().choosing).toBeNull()
    expect(useHost.getState().registry.active).toBe(2)
    expect(two.win.location.replace).toHaveBeenCalledWith('/?account=2#/join/abc')
    expect(one.win.location.replace).not.toHaveBeenCalled()
    // A notification's click names its account: no question.
    incoming({ kind: 'hash', route: '#/open/x' }, 1)
    expect(useHost.getState().choosing).toBeNull()
    expect(one.win.location.replace).toHaveBeenCalledWith('/?account=1#/open/x')
    // Cancelled: nobody gets it.
    incoming({ kind: 'hash', route: '#/join/zzz' })
    choose(null)
    expect(two.win.location.replace).toHaveBeenCalledTimes(1)
  })

  it('never adds an account from a device link by itself: the person says yes first, and Cancel leaves everything', () => {
    // Security review M1: a #/link/ opened from outside (or "?account=N#/link/") silently added a slot and linked it.
    const frames = host([1, 2])
    incoming({ kind: 'hash', route: '#/link/code' })
    expect(useHost.getState().linking).toBe('#/link/code')
    expect(useHost.getState().registry.order).toEqual([1, 2])
    confirmLinking(false)
    expect(useHost.getState().linking).toBeNull()
    expect(useHost.getState().registry.order).toEqual([1, 2])
    // Naming an account doesn't skip the question, and nothing reaches any page meanwhile.
    incoming({ kind: 'hash', route: '#/link/again' }, 2)
    expect(useHost.getState().linking).toBe('#/link/again')
    expect(frames[2].win.location.replace).not.toHaveBeenCalled()
    expect(frames[1].win.location.replace).not.toHaveBeenCalled()
    // Yes: an account to link goes on the list, and its page gets the code (it still waits for "Link this device").
    confirmLinking(true)
    const reg = useHost.getState().registry
    expect(reg.order).toEqual([1, 2, 3])
    expect(reg.accounts[3].adding).toBe('link')
    expect(reg.active).toBe(3)
  })

  it('notices the same account added twice, on the copy that was added last', () => {
    const { 1: one } = host([1])
    one.link.report({ ...emptySummary(), name: 'Ada', key: KEY_A, ready: true })
    one.link.add('link')
    const win = fakeFrame(2)
    const two = hostApiForTests.link(2, win)!
    expect(two.adding()).toBe('link')
    two.report({ ...emptySummary(), name: 'Ada', key: KEY_A, ready: true })
    expect(views().find((v) => v.slot === 2)?.duplicateOf).toBe(1)
    expect(views().find((v) => v.slot === 1)?.duplicateOf).toBeNull()
  })

  it("takes an account off the device when it signed out, with everything it left behind", async () => {
    const { 2: two } = host([1, 2])
    localStorage.setItem('iskra@2:iskra.drafts', 'bea')
    localStorage.setItem('iskra.drafts', 'ada')
    two.link.signedOut()
    await vi.waitFor(() => expect(localStorage.getItem('iskra@2:iskra.drafts')).toBeNull())
    expect(localStorage.getItem('iskra.drafts')).toBe('ada')
    expect(useHost.getState().registry.order).toEqual([1])
    expect(JSON.parse(localStorage.getItem(REGISTRY_KEY)!).order).toEqual([1])
  })

  it('goes back to where it was when an account being added is cancelled', async () => {
    const { 2: two } = host([1, 2])
    two.link.switchTo(1)
    two.link.add('new')
    expect(useHost.getState().registry.active).toBe(3)
    const win = fakeFrame(3)
    const three = hostApiForTests.link(3, win)!
    localStorage.setItem('iskra@3:iskra.audio', 'seeded')
    three.cancelAdd()
    await vi.waitFor(() => expect(localStorage.getItem('iskra@3:iskra.audio')).toBeNull())
    expect(useHost.getState().registry).toMatchObject({ order: [1, 2], active: 1 })
    // Only an account still being added can be cancelled.
    two.link.cancelAdd()
    expect(useHost.getState().registry.order).toEqual([1, 2])
  })
})
