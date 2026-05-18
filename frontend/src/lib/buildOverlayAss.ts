// Build the preview ASS subtitle string client-side from the user's
// current cover_lines / small_lines edits. Title duration = intro window
// length (intro_speech_end - intro_speech_start). Mirrors
// dive_edit/render/ass_builder.py so preview matches the ffmpeg+libass bake.
//
// PreviewBox runs the result through makeAssAlwaysOn() so both Cover
// (TITLE) and Small (WATERMARK) blocks stay visible regardless of which
// segment the user is auditioning — segment streams have their own local
// time which doesn't line up with the rendered output's absolute time.

interface BuildOverlayParams {
  coverLines: string[]
  smallLines: string[]
  titleDurationSec: number    // drives the Cover Dialogue end / Small Dialogue start
  totalDurationSec: number    // upper bound for the Small Dialogue end
  coverFontSize?: number
  coverLineSpacing?: number
  coverLetterSpacing?: number
  coverPositionX?: number     // offset from canvas center in 1080-baseline px
  coverPositionY?: number
  coverBorderWidth?: number
  smallFontSize?: number
  smallLetterSpacing?: number
  smallPositionX?: number     // offset from top-left anchor in 1080-baseline px
  smallPositionY?: number
  smallBorderWidth?: number
  smallX?: number             // anchor X (px)
  smallY?: number             // anchor Y (px)
  reservedTopH?: number
  reservedBottomH?: number
}

const PLAY_RES_X = 1920
const PLAY_RES_Y = 1080

const DEFAULTS = {
  coverFontSize: 72,
  coverLineSpacing: 22,
  coverLetterSpacing: 0,
  coverPositionX: 0,
  coverPositionY: 0,
  coverBorderWidth: 4,
  smallFontSize: 32,
  smallLetterSpacing: 0,
  smallPositionX: 0,
  smallPositionY: 0,
  smallBorderWidth: 2,
  smallX: 18,
  smallY: 18,
  reservedTopH: 80,
  reservedBottomH: 60,
}

function assTime(sec: number): string {
  const safe = Math.max(0, sec)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe - h * 3600 - m * 60
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}

function escapeAssText(s: string): string {
  return s
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n|\n/g, '\\N')
}

export function buildOverlayAss(params: BuildOverlayParams): string {
  const cfg = { ...DEFAULTS, ...params }
  const {
    coverLines, smallLines,
    titleDurationSec, totalDurationSec,
    coverFontSize, coverLetterSpacing, coverPositionX, coverPositionY, coverBorderWidth,
    smallFontSize, smallLetterSpacing, smallPositionX, smallPositionY,
    smallBorderWidth, smallX, smallY,
    reservedTopH, reservedBottomH,
  } = cfg
  let { coverLineSpacing } = cfg

  // Auto-shrink line spacing when many cover_lines would overflow the
  // safe vertical area (matches ass_builder.py).
  const cleanCover = coverLines.filter((l) => l !== undefined && l !== null)
  const n = cleanCover.length
  if (n > 0) {
    const availableH = PLAY_RES_Y - reservedTopH - reservedBottomH
    const maxLineH = Math.floor(availableH / n)
    if (coverFontSize + coverLineSpacing > maxLineH) {
      coverLineSpacing = Math.max(0, maxLineH - coverFontSize)
    }
  }

  const coverText = cleanCover.map(escapeAssText).join('\\N')
  const smallText = smallLines
    .filter((l) => l !== undefined && l !== null)
    .map(escapeAssText)
    .join('\\N')

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
  ].join('\n')

  const styles = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cover,Arial,${coverFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,${coverLetterSpacing},0,1,${coverBorderWidth},0,5,10,10,10,1`,
    `Style: Small,Arial,${smallFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,${smallLetterSpacing},0,1,${smallBorderWidth},0,7,10,10,10,1`,
    '',
  ].join('\n')

  const coverPosFinalX = Math.round(PLAY_RES_X / 2 + coverPositionX)
  const coverPosFinalY = Math.round(PLAY_RES_Y / 2 + coverPositionY)
  const smallPosFinalX = Math.round(smallX + smallPositionX)
  const smallPosFinalY = Math.round(smallY + smallPositionY)

  const events: string[] = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]

  if (coverText && titleDurationSec > 0) {
    const fsOverride = coverFontSize + coverLineSpacing
    events.push(
      `Dialogue: 0,${assTime(0)},${assTime(titleDurationSec)},Cover,,0,0,0,,{\\pos(${coverPosFinalX},${coverPosFinalY})\\fs${fsOverride}}${coverText}`,
    )
  }
  if (smallText && totalDurationSec > titleDurationSec) {
    events.push(
      `Dialogue: 0,${assTime(titleDurationSec)},${assTime(totalDurationSec)},Small,,0,0,0,,{\\pos(${smallPosFinalX},${smallPosFinalY})}${smallText}`,
    )
  }

  return [header, styles, events.join('\n')].join('\n') + '\n'
}
