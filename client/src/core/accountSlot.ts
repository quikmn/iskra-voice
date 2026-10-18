// Which account's storage this page uses: several accounts can be signed in on one device, each in a "slot" of its own
// (client/src/platform/accountBoot.ts picks it before anything else runs). Account 1 keeps the storage names from before
// there were several accounts, so an existing install becomes account 1 as it is. No DOM here (bots share core/).

let slot = 1

export const accountSlot = (): number => slot

export function setAccountSlot(next: number): void {
  if (Number.isSafeInteger(next) && next >= 1) slot = next
}

/** An IndexedDB database name for an account: unchanged for account 1, "<base>@<n>" for the others. */
export const slotDbName = (base: string, n: number = slot): string => (n === 1 ? base : `${base}@${n}`)
