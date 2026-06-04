import { useEffect, useRef, useState, type ReactNode, type ReactElement, isValidElement } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  content: ReactNode
  children: ReactElement
  delayMs?: number
  // Kept for API compatibility with old callers; tooltip follows the cursor.
  side?: 'top' | 'right' | 'bottom' | 'left'
}

const TOOLTIP_MAX_WIDTH = 280
const TOOLTIP_GAP = 14
const TOOLTIP_MARGIN = 10
let activeTooltipId: symbol | null = null
const activeListeners = new Set<() => void>()

function setActiveTooltip(id: symbol | null): void {
  activeTooltipId = id
  for (const listener of activeListeners) listener()
}

function clampTooltipPos(pos: { x: number; y: number }): { left: number; top: number } {
  const left = Math.max(
    TOOLTIP_MARGIN,
    Math.min(pos.x + TOOLTIP_GAP, window.innerWidth - TOOLTIP_MAX_WIDTH - TOOLTIP_MARGIN),
  )
  const top = Math.max(
    TOOLTIP_MARGIN,
    Math.min(pos.y + TOOLTIP_GAP, window.innerHeight - 48),
  )
  return { left, top }
}

export default function Tooltip({ content, children, delayMs = 1000 }: Props) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idRef = useRef(Symbol('tooltip'))

  useEffect(() => {
    const id = idRef.current
    const syncActive = () => {
      if (activeTooltipId !== id) setPos(null)
    }
    activeListeners.add(syncActive)
    return () => {
      activeListeners.delete(syncActive)
      if (activeTooltipId === id) setActiveTooltip(null)
    }
  }, [])

  if (!content) return children
  if (!isValidElement(children)) return children

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const onMove = (e: React.MouseEvent) => {
    if (pos) {
      setPos({ x: e.clientX, y: e.clientY })
      return
    }
    if (timerRef.current !== null) return
    const x = e.clientX
    const y = e.clientY
    timerRef.current = setTimeout(() => {
      setActiveTooltip(idRef.current)
      setPos({ x, y })
      timerRef.current = null
    }, delayMs)
  }

  const onLeave = () => {
    clearTimer()
    if (activeTooltipId === idRef.current) setActiveTooltip(null)
    setPos(null)
  }

  return (
    <>
      <span onMouseMove={onMove} onMouseLeave={onLeave} style={{ display: 'contents' }}>
        {children}
      </span>
      {pos && createPortal((() => {
        const { left, top } = clampTooltipPos(pos)
        return (
          <div
            style={{
              position: 'fixed',
              left,
              top,
              padding: '5px 9px',
              background: 'rgba(15,23,42,0.96)',
              color: '#fff',
              font: "500 11px/1.35 'Inter', system-ui, sans-serif",
              borderRadius: 5,
              pointerEvents: 'none',
              zIndex: 9999,
              maxWidth: TOOLTIP_MAX_WIDTH,
              boxShadow: '0 4px 12px rgba(0,0,0,0.32)',
              whiteSpace: 'normal',
            }}
          >
            {content}
          </div>
        )
      })(), document.body)}
    </>
  )
}
