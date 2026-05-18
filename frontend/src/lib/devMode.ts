const KEY = 'dive.devMode'

export function isDevMode(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setDevMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
    window.dispatchEvent(new CustomEvent('dive.devMode.change', { detail: on }))
  } catch {
    // ignore storage failures
  }
}

export function toggleDevMode(): boolean {
  const next = !isDevMode()
  setDevMode(next)
  return next
}

export function registerDevShortcut(): () => void {
  const handler = (e: KeyboardEvent): void => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault()
      toggleDevMode()
    }
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}
