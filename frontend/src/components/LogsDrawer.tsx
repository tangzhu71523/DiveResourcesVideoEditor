import { X } from 'lucide-react'

interface Props {
  open: boolean
  logs: string[]
  onClose: () => void
}

// Dev-mode logs drawer:从 ActionBar 的 Log 按钮打开,显示 pipeline stdout
export default function LogsDrawer({ open, logs, onClose }: Props) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="relative w-[520px] max-w-[90vw] bg-white border-l border-border-subtle flex flex-col">
        <header className="h-10 flex items-center justify-between px-3 border-b border-border-subtle">
          <span className="text-[12px] font-medium text-text-secondary tracking-wider uppercase">
            Logs (dev)
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-7 w-7 rounded flex items-center justify-center text-text-muted hover:bg-surface-raised hover:text-text-primary"
            aria-label="close logs"
          >
            <X size={14} />
          </button>
        </header>
        <pre className="flex-1 overflow-auto p-3 text-[11px] font-mono leading-[1.5] text-text-secondary whitespace-pre-wrap">
          {logs.length === 0 ? '(no logs yet)' : logs.join('\n')}
        </pre>
      </aside>
    </div>
  )
}
