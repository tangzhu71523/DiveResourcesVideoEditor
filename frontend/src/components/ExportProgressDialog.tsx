import { Download, X, CheckCircle2, AlertOctagon } from 'lucide-react'
import type { PipelineStage, StageProgress } from '@/types/edl'

interface Props {
  open: boolean
  outputDir: string | null
  runPhase: 'idle' | 'running' | 'finished' | 'error'
  stages: Record<PipelineStage, StageProgress>
  onCancel: () => void
  onClose: () => void
}

// Theme-aware export progress dialog. Uses the same CSS-variable palette
// as the rest of the app (panel backgrounds, glass borders) so it tracks
// light / dark mode correctly. The original used Tailwind classes that
// weren't defined in this project's tailwind config (text-text-primary,
// bg-dive-500, etc.) which fell back to invisible defaults — that's why
// the text looked washed out and the modal was always white.
export default function ExportProgressDialog({
  open, outputDir, runPhase, stages, onCancel, onClose,
}: Props) {
  if (!open) return null

  const render = stages.render
  // No "warm-up" pseudo-percent — the bar sits at 0% until ffmpeg
  // emits its first real out_time_ms event. The previous fallback to
  // 3% caused a visible 3 → 0 jump the moment real progress arrived.
  const pct = render?.total && render?.current !== undefined
    ? Math.min(100, Math.round((render.current / render.total) * 100))
    : runPhase === 'finished' ? 100 : 0

  const title =
    runPhase === 'finished' ? 'Export done' :
    runPhase === 'error' ? 'Export failed' :
    'Rendering…'

  const iconColor =
    runPhase === 'error' ? 'rgb(var(--danger))' :
    '#3b82f6'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        className="panel"
        style={{
          width: 440,
          maxWidth: '90vw',
          padding: 20,
          gap: 0,
          // Override the inherited flex column from .panel since this
          // dialog manages its own internal layout.
          display: 'block',
          background: 'rgb(var(--bg-surface))',
          border: '1px solid var(--glass-border)',
          borderRadius: 10,
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 14,
                fontWeight: 600,
                color: 'rgb(var(--text-primary))',
              }}
            >
              {runPhase === 'finished' ? (
                <CheckCircle2 size={16} style={{ color: iconColor }} />
              ) : runPhase === 'error' ? (
                <AlertOctagon size={16} style={{ color: iconColor }} />
              ) : (
                <Download size={16} style={{ color: iconColor }} />
              )}
              {title}
            </div>
            {outputDir && (
              <div
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  fontFamily: "'JetBrains Mono', Consolas, monospace",
                  color: 'rgb(var(--text-secondary))',
                  maxWidth: 360,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {outputDir}
              </div>
            )}
          </div>
          {runPhase !== 'running' && (
            <button
              type="button"
              onClick={onClose}
              className="btn icon sm"
              aria-label="close"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Progress bar */}
        <div
          style={{
            position: 'relative',
            height: 8,
            background: 'rgba(18,28,46,0.10)',
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0, bottom: 0, left: 0,
              width: `${pct}%`,
              borderRadius: 4,
              background: runPhase === 'error' ? 'rgb(var(--danger))' : '#3b82f6',
              transition: 'width 0.15s linear',
            }}
          />
        </div>

        {/* Status line: pct + current/total */}
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'rgb(var(--text-secondary))',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span>{pct}%</span>
          {render?.total !== undefined && (
            <span>{render.current ?? 0} / {render.total}</span>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          {runPhase === 'running' && (
            <button type="button" onClick={onCancel} className="btn sm">
              Cancel
            </button>
          )}
          {runPhase !== 'running' && (
            <button type="button" onClick={onClose} className="btn primary sm">
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
