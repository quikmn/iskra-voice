import { StrictMode } from 'react'
import { i18nReady } from './i18n'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { DesktopNotices } from './ui/DesktopNotices'
import { UpdatingOverlay } from './ui/UpdatingOverlay'
import './styles.css'
import { applySavedTheme } from './theme/theme'
import { installMenuKeys, installRegionFocus } from './ui/a11y'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { installBackNav } from './ui/nav/backNav'
import { BackHint } from './ui/nav/PhoneNav'

applySavedTheme()
installMenuKeys()
installRegionFocus()
installBackNav()

// A Swedish catalog that won't load (offline, first visit) still shows the app, in English.
void i18nReady.catch(() => undefined).then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary variant="app">
        <App />
      </ErrorBoundary>
      {/* The desktop shell's own notices and its update overlay, whatever the app is showing (first run, lock screen, signed in). */}
      <DesktopNotices />
      <BackHint />
      <UpdatingOverlay />
    </StrictMode>,
  ),
)
