import { useEffect, useState, useCallback } from 'react'
import { Sun, Moon, RotateCw } from 'lucide-react'
import logoUrl from '@/assets/logo-only.png'
import { useLang } from '@/i18n/useLang'
import Tooltip from './ui/Tooltip'

const LS_THEME_KEY = 'dive_edit:theme'

function getTheme(): 'light' | 'dark' {
  try {
    return (localStorage.getItem(LS_THEME_KEY) as 'light' | 'dark') || 'light'
  } catch { return 'light' }
}

function applyTheme(t: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', t)
  try { localStorage.setItem(LS_THEME_KEY, t) } catch { /* */ }
}

export default function Header() {
  const { t } = useLang()
  const [theme, setTheme] = useState<'light' | 'dark'>(getTheme)

  useEffect(() => { applyTheme(theme) }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((t) => t === 'light' ? 'dark' : 'light')
  }, [])
  return (
    <header
      className="shrink-0 flex items-center gap-2.5 px-3.5"
      style={{
        height: 42,
        background: 'var(--header-bg)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: 'var(--header-border)',
      }}
    >
      <img
        src={logoUrl}
        alt="Dive Resources"
        style={{ height: 32, display: 'block' }}
      />
      <div className="flex flex-col gap-[2px] min-w-0">
        <div
          className="truncate"
          style={{
            font: "600 11.5px/1 'Inter', system-ui, sans-serif",
            color: 'var(--header-text)',
          }}
        >
          {t('app_title')}
        </div>
        <div
          className="truncate"
          style={{
            font: "500 8.5px/1 'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
            color: 'var(--header-sub)',
            letterSpacing: '0.06em',
          }}
        >
          DIVE RESOURCES SDN BHD
        </div>
      </div>
      <div className="flex-1" />
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <linearGradient id="themeGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>
        </defs>
      </svg>
      <Tooltip content={theme === 'light' ? 'Dark mode' : 'Light mode'}>
      <button
        type="button"
        onClick={toggleTheme}
        style={{
          position: 'relative',
          width: 44,
          height: 22,
          borderRadius: 11,
          border: 'none',
          cursor: 'pointer',
          // Match Eye / Reset (.btn primary) — the same brand-blue gradient
          // in both light and dark modes (token --btn-primary-bg).
          background: 'var(--btn-primary-bg)',
          boxShadow: 'var(--btn-primary-shadow)',
          transition: 'background 200ms ease',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 2,
            left: theme === 'dark' ? 24 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: theme === 'dark' ? '#e0e7ff' : '#f5f3ed',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            transition: 'left 200ms ease, background 200ms ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
          }}
        >
          {theme === 'dark'
            ? <Moon size={10} style={{ stroke: 'url(#themeGrad)' }} />
            : <Sun size={10} style={{ stroke: 'url(#themeGrad)' }} />
          }
        </div>
      </button>
      </Tooltip>
      {/* Refresh — hard-reload the webview. Uses .btn icon sm so colors
          (hover, active, theme) match every other toolbar button (timeline
          toolbar / INPUT panel / PreviewBox controls). 10px gap from the
          brightness toggle. */}
      <Tooltip content="Refresh">
      <button
        type="button"
        className="btn icon sm primary"
        onClick={() => window.location.reload()}
        aria-label="refresh"
        style={{ marginLeft: 10 }}
      >
        <RotateCw size={12} />
      </button>
      </Tooltip>
    </header>
  )
}
