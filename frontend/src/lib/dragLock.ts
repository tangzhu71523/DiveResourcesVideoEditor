/**
 * Drag interaction helpers — disable text-selection highlight while the
 * user is actively dragging a slider / bar / handle. Without this, mouse
 * moves across text nodes accidentally highlight them and leave a distracting
 * blue selection after mouseup.
 *
 * Usage: call `lockTextSelect()` on mousedown (start of drag) and
 * `unlockTextSelect()` on mouseup (end of drag). Always pair them.
 */

export function lockTextSelect(): void {
  const s = document.body.style
  s.userSelect = 'none'
  s.webkitUserSelect = 'none'
  // cursor stays whatever the drag handler sets; this only kills selection
}

export function unlockTextSelect(): void {
  const s = document.body.style
  s.userSelect = ''
  s.webkitUserSelect = ''
}
