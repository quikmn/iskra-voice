// Which person's menu is open (right-click, or press and hold on a phone, on anyone anywhere). See ui/people/UserMenu.tsx.
import { create } from 'zustand'

export interface UserMenuTarget {
  accountKey: string
  /** The server the person was clicked on (member list, chat, voice), for server actions. Null in DMs and groups. */
  serverKey: string | null
  /** Where the pointer was; null opens a sheet from the bottom. */
  anchor: { x: number; y: number } | null
}

export const useUserMenu = create<{ target: UserMenuTarget | null }>(() => ({ target: null }))

export const openUserMenu = (target: UserMenuTarget) => useUserMenu.setState({ target })
export const closeUserMenu = () => useUserMenu.setState({ target: null })
