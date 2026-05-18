import { useState } from 'react'
import { FolderOpen, ArrowRight, Clock } from 'lucide-react'

import { useLang } from '@/i18n/useLang'
import { validateFolder } from '@/lib/api'
import { cn } from '@/lib/utils'
import { loadRecentFolders } from './recentFolders'

interface Props {
  onPickFolder: () => void
  onPickFolderByPath: (path: string) => void
}

export default function OnboardingHero({ onPickFolder, onPickFolderByPath }: Props) {
  const { t } = useLang()
  const [recent] = useState<string[]>(() => loadRecentFolders())
  const [manualPath, setManualPath] = useState('')
  const [pathError, setPathError] = useState<string | null>(null)

  const submitPath = async (raw: string) => {
    const p = raw.trim()
    if (!p) return
    const res = await validateFolder(p)
    if (res.ok) {
      onPickFolderByPath(p)
    } else {
      setPathError(res.message ?? 'Invalid path')
    }
  }

  return (
    <main className="flex-1 min-h-0 overflow-hidden flex items-center justify-center px-6">
      <div className="w-full max-w-3xl flex flex-col items-center gap-8">
        {/* Hero block */}
        <div className="text-center space-y-3">
          <div className="text-[11px] font-semibold tracking-[0.22em] uppercase text-dive-500">
            DIVE RESOURCES · REPORT EDITOR
          </div>
          <h1 className="text-[34px] leading-tight font-semibold text-text-primary">
            Start an edit job
          </h1>
        </div>

        {/* Primary action + manual path */}
        <div className="w-full max-w-md space-y-2">
          <button
            type="button"
            onClick={onPickFolder}
            className="w-full inline-flex items-center justify-center gap-2 h-12 rounded-lg bg-dive-500 text-white text-[15px] font-medium hover:bg-dive-400 active:bg-dive-600 transition-colors shadow-md shadow-dive-500/25"
          >
            <FolderOpen size={18} />
            {t('pick_folder')}
          </button>

          <div className="relative">
            <input
              type="text"
              value={manualPath}
              onChange={(e) => { setManualPath(e.target.value); setPathError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitPath(manualPath) }}
              placeholder=""
              className={cn(
                'w-full h-10 pl-3 pr-10 rounded-md text-[13px] font-mono bg-surface border transition-colors',
                pathError ? 'border-danger text-danger' : 'border-border-subtle text-text-primary',
                'focus:outline-none focus:border-dive-500',
              )}
            />
            {manualPath && (
              <button
                type="button"
                onClick={() => void submitPath(manualPath)}
                className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 rounded text-text-secondary hover:text-dive-500 hover:bg-dive-50 flex items-center justify-center"
                aria-label="apply path"
              >
                <ArrowRight size={15} />
              </button>
            )}
          </div>
          {pathError && (
            <p className="text-[11px] text-danger pl-1">{pathError}</p>
          )}
        </div>

        {/* Recent folders */}
        {recent.length > 0 && (
          <div className="w-full max-w-md">
            <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wide uppercase text-text-muted mb-2">
              <Clock size={12} /> Recent
            </div>
            <ul className="space-y-1">
              {recent.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => onPickFolderByPath(p)}
                    className="w-full text-left px-3 py-2 rounded-md border border-border-subtle text-[12px] font-mono text-text-secondary hover:text-text-primary hover:bg-surface-raised hover:border-border-strong transition-colors truncate"
                    title={p}
                  >
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

      </div>
    </main>
  )
}
