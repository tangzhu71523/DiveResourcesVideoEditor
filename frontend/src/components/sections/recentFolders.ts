const LS_KEY = 'dive_edit:recent_folders'
const MAX_RECENT = 5

export function loadRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

export function pushRecentFolder(path: string) {
  try {
    const cur = loadRecentFolders().filter((p) => p !== path)
    localStorage.setItem(LS_KEY, JSON.stringify([path, ...cur].slice(0, MAX_RECENT)))
  } catch {
    /* noop */
  }
}
