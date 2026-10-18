// Small helpers for notifications when several accounts are signed in on this device (state/accounts.ts keeps the
// label up to date): a notification says which account it's for, and clicking it brings that account on screen.
import { t } from '../i18n'
import { accountLink } from '../platform/accountBoot'

let label: string | null = null

/** This account's name for notifications, or null while it's the only account here. */
export function setAccountLabel(name: string | null): void {
  label = name || null
}

/** A notification's title, with the account's name when there are several accounts on this device. */
export const notificationTitle = (title: string): string => (label ? t('accounts.notifyTitle', { title, account: label }) : title)

/** Brings this account on screen (a click on one of its notifications); nothing to do with one account. */
export function focusThisAccount(): void {
  accountLink?.activate()
}
