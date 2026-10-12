import { StrictMode } from 'react'
import './i18n'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { UpdatingOverlay } from './ui/UpdatingOverlay'
import './styles.css'
import { applySavedTheme } from './theme/theme'
import { installMenuKeys } from './ui/a11y'

applySavedTheme()
installMenuKeys()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <UpdatingOverlay />
  </StrictMode>,
)
