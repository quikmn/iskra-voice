import { StrictMode } from 'react'
import './i18n'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { applySavedTheme } from './theme/theme'

applySavedTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
