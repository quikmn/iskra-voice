// The Terms of Use and Community guidelines: accepted once per device, and again whenever their version changes.
// The full texts live on iskra.foo (site/terms.html); the app shows a short summary and links there.
import { create } from 'zustand'

/** Bump (a date) when the terms change in a way people must agree to again. Keep in step with site/terms.html. */
export const TERMS_VERSION = '2026-10-11'

export const LEGAL_LINKS = {
  terms: 'https://iskra.foo/terms',
  privacy: 'https://iskra.foo/privacy',
  support: 'https://iskra.foo/support',
  deleteAccount: 'https://iskra.foo/delete-account',
}

/** For things a server's moderators don't handle: illegal content, a server that ignores reports. */
export const SAFETY_EMAIL = 'spark@iskra.foo'
export const safetyMailto = (subject: string) => `mailto:${SAFETY_EMAIL}?subject=${encodeURIComponent(subject)}`

const STORAGE_KEY = 'iskra.terms'

export interface TermsAcceptance {
  version: string
  at: number
}

/** What this device stored, if it's well formed. */
export function parseAcceptance(raw: string | null): TermsAcceptance | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<TermsAcceptance>
    return typeof value.version === 'string' && typeof value.at === 'number' ? { version: value.version, at: value.at } : null
  } catch {
    return null
  }
}

/** True when the device hasn't agreed to these terms (never, or to an older or different version). */
export const needsAcceptance = (stored: TermsAcceptance | null, current = TERMS_VERSION): boolean => stored?.version !== current

function load(storage?: Pick<Storage, 'getItem'>): TermsAcceptance | null {
  try {
    return parseAcceptance((storage ?? localStorage).getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

export const useTerms = create<{ accepted: TermsAcceptance | null }>(() => ({ accepted: load() }))

/** True once this device agreed to the current terms. */
export const useTermsAccepted = () => useTerms((s) => !needsAcceptance(s.accepted))

export function acceptTerms(now = Date.now()): void {
  const accepted = { version: TERMS_VERSION, at: now }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accepted))
  } catch {
    // Private mode: agreed for as long as the page is open.
  }
  useTerms.setState({ accepted })
}
