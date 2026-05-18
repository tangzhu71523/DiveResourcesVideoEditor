// Mirror of dive_edit/metadata.py::derive_small_lines.
// Used as a fallback in App.tsx when jobMeta.small_lines is empty (e.g. the
// pipeline hasn't run yet, so the backend hasn't written derived lines back
// to job.yaml). Once the user runs Start, the backend overwrites small_lines
// with its own derivation and this fallback stops firing.

const VESSEL_RE = /(?:VESSEL\s*NAME|INSTALLATION)\s*[:#]\s*(.+?)\s*$/i
const TASK_RE = /(?:TASK|JOB\s*SCOPE)\s*[:#]\s*(.+?)\s*$/i
const LOCATION_RE = /LOCATION\s*[:#]\s*(.+?)\s*$/i
const DATE_RE = /DATE\s*[:#]\s*(.+?)\s*$/i

const DEFAULT_COMPANY = 'DIVE RESOURCES SDN BHD'

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
}

function extractCompany(lines: string[]): string {
  // First standalone all-caps line (no "KEY:" label) is treated as company.
  for (const ln of lines) {
    const stripped = ln.trim()
    if (!stripped) continue
    if (/^[A-Z\s]+:/.test(stripped)) continue
    if (/^[A-Z][A-Z0-9\s]+$/.test(stripped)) return stripped
  }
  return DEFAULT_COMPANY
}

function extractField(lines: string[], pattern: RegExp): string {
  for (const ln of lines) {
    const m = ln.match(pattern)
    if (m) return m[1].trim()
  }
  return ''
}

function stripVesselPrefix(v: string): string {
  return v.replace(/^(?:MV|MT|M\/V|M\/T|SS|HMS)\s+/i, '').trim()
}

function formatDateShort(d: string): string {
  const parts = d.trim().split(/\s+/)
  if (parts.length >= 3) {
    const day = parts[0].replace(/[stndrh]+$/i, '')
    const monthName = parts[1].toLowerCase()
    const year = parts[2]
    const mm = MONTHS[monthName] ?? '00'
    if (mm !== '00') {
      const dd = String(parseInt(day, 10)).padStart(2, '0')
      return `${dd}.${mm}.${year}`
    }
  }
  return d
}

function wrapLines(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w
    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      if (current) lines.push(current)
      current = w
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : [text]
}

export function deriveSmallLines(coverLines: string[], maxChars = 38): string[] {
  const company = extractCompany(coverLines)
  const vessel = extractField(coverLines, VESSEL_RE)
  const task = extractField(coverLines, TASK_RE)
  const date = extractField(coverLines, DATE_RE)
  const location = extractField(coverLines, LOCATION_RE)

  const vesselShort = vessel ? stripVesselPrefix(vessel) : 'N/A'
  const dateShort = date ? formatDateShort(date) : 'N/A'

  const result: string[] = [company]
  result.push(...wrapLines(task || 'N/A', maxChars))
  result.push(...wrapLines(vesselShort !== 'N/A' ? `FOR ${vesselShort}` : 'N/A', maxChars))
  result.push(...wrapLines(location || 'N/A', maxChars))
  result.push(dateShort)
  return result
}
