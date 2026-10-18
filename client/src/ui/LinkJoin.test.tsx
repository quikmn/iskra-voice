// @vitest-environment happy-dom
// Security review M1: next to other accounts, a device link from outside never starts linking by itself.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

const joinWithCode = vi.fn(async () => undefined)
vi.mock('../state/link', () => ({
  joinWithCode,
  cancelLinkJoin: vi.fn(),
  useLinkJoin: () => ({ phase: 'idle' }),
}))

async function show(autoStart: boolean, code: string) {
  const { LinkJoin } = await import('./LinkJoin')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<LinkJoin initialCode={code} autoStart={autoStart} onBack={() => undefined} />))
  act(() => root.unmount())
}

describe('linking from an opened link', () => {
  it("waits for the person's click in an account added next to others", async () => {
    await show(false, '#/link/abc')
    expect(joinWithCode).not.toHaveBeenCalled()
  })

  it("starts at once on a device's first run, as before", async () => {
    await show(true, '#/link/xyz')
    expect(joinWithCode).toHaveBeenCalledWith('#/link/xyz')
  })
})
