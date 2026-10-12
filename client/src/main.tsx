import { StrictMode } from 'react'
import { i18nReady } from './i18n'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { UpdatingOverlay } from './ui/UpdatingOverlay'
import './styles.css'
import { applySavedTheme } from './theme/theme'
import { installMenuKeys } from './ui/a11y'

applySavedTheme()
installMenuKeys()

// A Swedish catalog that won't load (offline, first visit) still shows the app, in English.
void i18nReady.catch(() => undefined).then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
      <UpdatingOverlay />
    </StrictMode>,
  ),
)
