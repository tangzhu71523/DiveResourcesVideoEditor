import { useState, useRef, type ReactNode, type ReactElement, isValidElement } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  content: ReactNode
  children: ReactElement
  delayMs?: number
  // Kept for API compat with old callers; ignored — tooltip always
  // follows the mouse cursor now (no fixed side anchor).
  side?: 'top' | 'right' | 'bottom' | 'left'
}

// Mouse-follow tooltip. Anchors the popup to the cursor (not the trigger
// element's edge), so it never gets clipped by panel borders and reads
// like a hint that travels with attention. Unified across the whole app
// (timeline toolbar, INPUT panel, PreviewBox, Header).
export default function Tooltip({ content, children, delayMs = 1000 }: Props) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  if (!content) return children
  if (!isValidElement(children)) return children

  const onMove = (e: React.MouseEvent) => {
    if (pos) {
      setPos({ x: e.clientX, y: e.clientY })
    } else if (timerRef.current === null) {
      const x = e.clientX, y = e.clientY
      timerRef.current = setTimeout(() => {
        setPos({ x, y })
        timerRef.current = null
      }, delayMs)
    }
  }
  const onLeave = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setPos(null)
  }

  return (
    <>
      <span onMouseMove={onMove} onMouseLeave={onLeave} style={{ display: 'contents' }}>
        {children}
      </span>
      {pos && createPortal((() => {
        // Default = right of cursor; flip to left when cursor sits in
        // the rightmost ~300px of the viewport so the popup never spills
        // off-screen. Right-anchored uses CSS `right` so the bubble grows
        // leftward from the cursor.
        const FLIP_THRESHOLD = 300
        const flipLeft = pos.x > window.innerWidth - FLIP_THRESHOLD
        return (
          <div
            style={{
              position: 'fixed',
              ...(flipLeft
                ? { right: window.innerWidth - pos.x + 14 }
                : { left: pos.x + 14 }),
              top: pos.y + 14,
              padding: '5px 9px',
              background: 'rgba(15,23,42,0.96)',
              color: '#fff',
              font: "500 11px/1.35 'Inter', system-ui, sans-serif",
              borderRadius: 5,
              pointerEvents: 'none',
              zIndex: 9999,
              maxWidth: 280,
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
