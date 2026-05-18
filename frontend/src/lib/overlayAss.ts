/**
 * ASS overlay utilities.
 *
 * The backend writes a time-accurate `_overlay.ass` — cover lines at
 * `[0, intro_duration]`, small lines at `[intro_duration, total]` — because
 * that's what ffmpeg's `subtitles=` filter needs at bake time. The preview
 * plays individual segments (file-local time), so the ASS timings don't line
 * up; and for a Canva-like feel the user wants to SEE the overlays regardless
 * of which segment they're auditioning.
 *
 * Fix: rewrite every Dialogue line so Start=0 and End=way-out-there. libass
 * then shows both blocks continuously. Styles / positions / colours are
 * unchanged, so what the user sees is what the exporter will render at the
 * correct timing.
 */
export function makeAssAlwaysOn(ass: string): string {
  return ass
    .split('\n')
    .map((raw) => {
      if (!raw.startsWith('Dialogue:')) return raw
      // Dialogue: Layer, Start, End, Style, Name, ...
      // Split on commas with limit so text field commas aren't damaged.
      // Format-defined 9 leading fields then Text — per ASS spec.
      const head = raw.slice('Dialogue:'.length)
      const parts = head.split(',')
      if (parts.length < 10) return raw
      parts[1] = ' 0:00:00.00'
      parts[2] = '9:59:59.99'
      return 'Dialogue:' + parts.join(',')
    })
    .join('\n')
}
