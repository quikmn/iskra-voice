// Which servers take Iskra's bug reports (server.json BugInbox.Accept): only those show Server settings → Bug inbox.
import { create } from 'zustand'
import { onWelcomeHook } from './store'

export const useBugInbox = create<{ accepts: Record<string, boolean> }>(() => ({ accepts: {} }))

onWelcomeHook((serverKey, welcome) => {
  useBugInbox.setState((s) => ({ accepts: { ...s.accepts, [serverKey]: welcome.server.bugInbox === true } }))
})
