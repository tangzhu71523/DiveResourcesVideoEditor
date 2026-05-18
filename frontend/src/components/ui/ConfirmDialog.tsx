// Centered modal that replaces native window.confirm / window.alert.
// Themed via the app's CSS variables, so light + dark mode are picked up
// automatically (no extra logic needed).

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, X } from 'lucide-react'

export interface ConfirmDialogProps {
  open: boolean
  title?: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string         // pass '' to render a single-button alert
  variant?: 'default' | 'danger'
  onConfirm: () => void
  onCancel?: () => void
}

export default function ConfirmDialog({
  open,
  title = 'Confirm',
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Esc → cancel, Enter → confirm. Focus is left to the browser default
  // (the confirm button has autoFocus so keyboard users hit it first).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel?.()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel, onConfirm])

  if (!open) return null

  const showCancel = cancelLabel !== ''
  const accent = variant === 'danger'
    ? 'rgb(var(--danger))'
    : 'rgb(var(--accent-500))'

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        // Click backdrop = cancel (mirrors browser modal convention).
        if (e.target === e.currentTarget) onCancel?.()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        style={{
          minWidth: 360,
          maxWidth: 480,
          background: 'rgb(var(--bg-surface))',
          color: 'rgb(var(--text-primary))',
          border: '1px solid rgb(var(--border-strong))',
          borderRadius: 10,
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.35), 0 4px 12px rgba(0, 0, 0, 0.15)',
          overflow: 'hidden',
        }}
      >
        {/* Header strip — accent bar + title + close */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 18px',
            borderBottom: '1px solid rgb(var(--border-subtle))',
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: variant === 'danger' ? 'rgba(239,68,68,0.12)' : 'rgba(59,130,246,0.12)',
              color: accent,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <AlertCircle size={16} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{title}</div>
          {showCancel && (
            <button
              type="button"
              onClick={onCancel}
              title="Close"
              style={{
                width: 26,
                height: 26,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: 'none',
                borderRadius: 6,
                color: 'rgb(var(--text-muted))',
                cursor: 'pointer',
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Body */}
        {body && (
          <div
            style={{
              padding: '16px 18px',
              fontSize: 13,
              lineHeight: 1.55,
              color: 'rgb(var(--text-secondary))',
              whiteSpace: 'pre-wrap',
            }}
          >
            {body}
          </div>
        )}

        {/* Actions */}
        <div
          style={{
            padding: '12px 18px 16px',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          {showCancel && (
            <button
              type="button"
              onClick={onCancel}
              style={{
                padding: '7px 16px',
                fontSize: 13,
                fontWeight: 500,
                background: 'transparent',
                color: 'rgb(var(--text-secondary))',
                border: '1px solid rgb(var(--border-strong))',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            style={{
              padding: '7px 18px',
              fontSize: 13,
              fontWeight: 600,
              background: accent,
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              boxShadow: variant === 'danger'
                ? '0 1px 2px rgba(239,68,68,0.4)'
                : '0 1px 2px rgba(59,130,246,0.4)',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
