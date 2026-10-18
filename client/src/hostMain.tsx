// The host page, with several accounts signed in on this device (state/accountHost.ts): no account of its own, one
// frame per account. Also the message for a browser that can't keep accounts apart.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { i18nReady, loadLanguageChoice, setLanguageChoice, t } from './i18n'
import { applySavedTheme } from './theme/theme'
import { startHost } from './state/accountHost'
import { AccountHost } from './ui/accounts/AccountHost'

/** An account's frame whose storage couldn't be kept apart from the others': it must not run. */
export function showUnsupported(): void {
  applySavedTheme()
  void i18nReady.catch(() => undefined).then(() => {
    const root = document.getElementById('root')!
    const box = document.createElement('div')
    box.className = 'onboarding'
    const card = document.createElement('p')
    card.className = 'onboarding-card'
    card.textContent = t('accounts.unsupported')
    box.appendChild(card)
    root.replaceChildren(box)
  })
}

export function startHostPage(): void {
  applySavedTheme()
  // The language and theme belong to the device: follow when an account's page changes them.
  window.addEventListener('storage', (event) => {
    if (event.key === 'iskra.theme') applySavedTheme()
    if (event.key === 'iskra.language') setLanguageChoice(loadLanguageChoice())
  })
  startHost()
  void i18nReady.catch(() => undefined).then(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <AccountHost />
      </StrictMode>,
    ),
  )
}
