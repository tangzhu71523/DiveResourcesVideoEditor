import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import App from './App'
import { LanguageProvider } from './i18n/LanguageContext'
import { registerDevShortcut } from './lib/devMode'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')

registerDevShortcut()

document.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) e.preventDefault()
}, { passive: false })
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
    e.preventDefault()
  }
  if (e.key === 'Home' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    window.dispatchEvent(new CustomEvent('dive.resetZoom'))
  }
})


// Honour ?dev=1 query param on boot
try {
  const params = new URLSearchParams(window.location.search)
  if (params.get('dev') === '1') localStorage.setItem('dive.devMode', '1')
  if (params.get('dev') === '0') localStorage.removeItem('dive.devMode')
} catch { /* ignore */ }

createRoot(rootEl).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
)
