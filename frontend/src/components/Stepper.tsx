import { useEffect, useRef, useState, type ReactNode } from 'react'
import Tooltip from './ui/Tooltip'

// Horizontal layout: [icon box] [- value +] — two distinct rounded boxes
// per parameter (matches user spec image). Icon replaces the text label
// for compactness and quicker recognition.
//   • click −/+ for one step
//   • hold −/+ to ramp continuously (after 350ms delay)
//   • click the value to type a number manually (Enter or blur to commit)
//   • optional displayBase: shows value as delta (e.g. "+4" / "-4" / "0")

export interface StepperProps {
  icon: ReactNode
  label: string             // accessible name (aria-label / tooltip)
  value: number
  step: number
  min: number
  max: number
  fixed?: number
  displayBase?: number
  onChange: (v: number) => void
  title?: string
}

export default function Stepper({
  icon, label, value, step, min, max, fixed, displayBase, onChange, title,
}: StepperProps) {
  const round = (v: number): number => {
    if (fixed === undefined) return Math.round(v)
    const p = Math.pow(10, fixed)
    return Math.round(v * p) / p
  }
  const clamp = (v: number): number => Math.max(min, Math.min(max, v))

  const formatDisplay = (v: number): string => {
    if (displayBase !== undefined) {
      const delta = v - displayBase
      const rounded = fixed !== undefined ? delta.toFixed(fixed) : Math.round(delta).toString()
      const num = parseFloat(rounded)
      if (num > 0) return `+${rounded}`
      return rounded
    }
    return fixed !== undefined ? v.toFixed(fixed) : String(v)
  }

  const valueRef = useRef(value)
  useEffect(() => {
    valueRef.current = value
  }, [value])
  const startRamp = (delta: number): void => {
    const next = clamp(round(valueRef.current + delta))
    if (next !== valueRef.current) onChange(next)
    let intervalId: ReturnType<typeof setInterval> | null = null
    const startTimeout = setTimeout(() => {
      intervalId = setInterval(() => {
        const n = clamp(round(valueRef.current + delta))
        if (n !== valueRef.current) onChange(n)
        else stop()
      }, 70)
    }, 350)
    const stop = (): void => {
      clearTimeout(startTimeout)
      if (intervalId) clearInterval(intervalId)
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('mouseleave', stop)
    }
    window.addEventListener('mouseup', stop)
    window.addEventListener('mouseleave', stop)
  }

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])
  const beginEdit = (): void => {
    const startVal = displayBase !== undefined ? value - displayBase : value
    setDraft(fixed !== undefined ? startVal.toFixed(fixed) : String(startVal))
    setEditing(true)
  }
  const commitEdit = (): void => {
    setEditing(false)
    const parsed = parseFloat(draft)
    if (!Number.isFinite(parsed)) return
    const absolute = displayBase !== undefined ? parsed + displayBase : parsed
    onChange(clamp(round(absolute)))
  }
  const cancelEdit = (): void => setEditing(false)

  // Unified pill: [icon | − value +] inside a single rounded border.
  // Subtle vertical divider between icon and the −/value/+ cluster
  // keeps the icon visually anchored to its param without splitting
  // into two physical boxes (cleaner than the literal "two boxes" sketch).
  // Compact sizes — three pills must fit a half-screen INPUT card width.
  const stepBtnStyle: React.CSSProperties = {
    border: 'none',
    background: 'transparent',
    padding: '0 1px',
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1,
    color: 'rgb(var(--text-secondary))',
    cursor: 'pointer',
    height: 22,
    flexShrink: 0,
  }

  return (
    <Tooltip content={title ?? label}>
    <div
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        height: 24,
        border: '1px solid var(--glass-border)',
        borderRadius: 5,
        background: 'rgb(var(--bg-surface))',
        minWidth: 0,
        flexShrink: 1,
      }}
    >
      <div
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          color: 'rgb(var(--text-secondary))',
          borderRight: '1px solid var(--glass-border)',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); startRamp(-step) }}
        disabled={value <= min}
        aria-label={`${label} decrease`}
        style={{
          ...stepBtnStyle,
          opacity: value <= min ? 0.35 : 1,
          cursor: value <= min ? 'not-allowed' : 'pointer',
        }}
      >
        −
      </button>
      {editing ? (
        <input
          ref={inputRef}
          className="tabular-nums"
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            else if (e.key === 'Escape') cancelEdit()
          }}
          onBlur={commitEdit}
          style={{
            width: 24,
            fontSize: 11,
            fontWeight: 600,
            textAlign: 'center',
            padding: 0,
            border: 'none',
            background: 'rgb(var(--accent-500) / 0.08)',
            color: 'rgb(var(--text-primary))',
            outline: 'none',
            alignSelf: 'stretch',
            flexShrink: 0,
          }}
        />
      ) : (
        <span
          className="tabular-nums"
          onClick={beginEdit}
          title="Click to type a value"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 600,
            color: 'rgb(var(--text-primary))',
            minWidth: 20,
            userSelect: 'none',
            cursor: 'text',
            flexShrink: 0,
          }}
        >
          {formatDisplay(value)}
        </span>
      )}
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); startRamp(step) }}
        disabled={value >= max}
        aria-label={`${label} increase`}
        style={{
          ...stepBtnStyle,
          // Extra +2px on the right so the "+" glyph doesn't kiss the
          // pill's right border edge.
          padding: '0 3px 0 1px',
          opacity: value >= max ? 0.35 : 1,
          cursor: value >= max ? 'not-allowed' : 'pointer',
        }}
      >
        +
      </button>
    </div>
    </Tooltip>
  )
}
