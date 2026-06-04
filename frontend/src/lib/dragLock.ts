/**
 * Disable accidental text selection while dragging sliders, timeline handles,
 * or file cards. Always pair lockTextSelect() with unlockTextSelect().
 */

export function lockTextSelect(): void {
  const s = document.body.style
  s.userSelect = 'none'
  s.webkitUserSelect = 'none'
}

export function unlockTextSelect(): void {
  const s = document.body.style
  s.userSelect = ''
  s.webkitUserSelect = ''
}
