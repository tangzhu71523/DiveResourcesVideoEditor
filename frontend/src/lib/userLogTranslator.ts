// Translates raw backend log lines into colourised user-friendly tokens for
// the in-pipeline terminal. Noisy debug lines stay hidden here; key progress
// lines must stay visible so long CPU/GPU stages do not look frozen.

export type TokenKind =
  | 'verb'
  | 'file'
  | 'num'
  | 'done'
  | 'warn'
  | 'err'
  | 'plain'
  | 'sub'

export interface Token { kind: TokenKind; text: string }

export interface UserLine {
  tokens: Token[]
  indent: 'main' | 'sub'
  severity?: 'info' | 'warn' | 'error'
  updateKey?: string
}

const v  = (text: string): Token => ({ kind: 'verb',  text })
const f  = (text: string): Token => ({ kind: 'file',  text })
const n  = (text: string): Token => ({ kind: 'num',   text })
const d  = (text: string): Token => ({ kind: 'done',  text })
const w  = (text: string): Token => ({ kind: 'warn',  text })
const er = (text: string): Token => ({ kind: 'err',   text })
const p  = (text: string): Token => ({ kind: 'plain', text })

const progressBar = (pct: number): string => {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)))
  const cells = 18
  const filled = Math.round((clamped / 100) * cells)
  return `${'#'.repeat(filled)}${'-'.repeat(cells - filled)}`
}

const progressLine = (key: string, label: string, pct: number): UserLine => {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)))
  const done = clamped >= 99
  return {
    indent: 'sub',
    updateKey: key,
    tokens: [
      p(`${label} [`),
      done ? d(progressBar(100)) : n(progressBar(clamped)),
      p('] '),
      done ? d('done') : n(`${clamped}%`),
    ],
  }
}

const shortName = (pathLike: string): string => {
  const parts = pathLike.split(/[\\/]/)
  return parts[parts.length - 1] || pathLike
}

const stageLabels: Record<string, string> = {
  speech: 'speech',
  intro: 'intro',
  ocr: 'time stamps',
  edl: 'cut list',
  render: 'render',
}

interface PatternEntry {
  re: RegExp
  render: (m: RegExpMatchArray) => UserLine | null
}

const PATTERNS: PatternEntry[] = [
  {
    re: /\[system\]\s+mode=(cpu|gpu)\s+workers=(\d+)\s+gpu=(available|not_available)\s+detail=(.+)/i,
    render: (m) => {
      const mode = m[1].toLowerCase()
      const detail = m[4].trim()
      return {
        indent: 'main',
        severity: mode === 'cpu' && m[3] === 'available' ? 'warn' : 'info',
        tokens: [
          v('System'), p(': '), n(mode === 'gpu' ? 'GPU mode' : 'CPU mode'),
          p(' | workers '), n(m[2]),
          p(' | '), mode === 'cpu' ? w(detail) : p(detail),
        ],
      }
    },
  },
  {
    re: /\[system\]\s+CUDA=([^\s]+)\s+cuDNN=([^\s]+)\s+forceCPU=([^\s]+)\s+workers=(\d+)\s+(.+)/i,
    render: (m) => ({
      indent: 'main',
      tokens: [
        v('System'), p(': CUDA '), n(m[1]),
        p(' | cuDNN '), n(m[2]),
        p(' | force CPU '), n(m[3]),
        p(' | workers '), n(m[4]),
        p(` | ${m[5]}`),
      ],
    }),
  },
  {
    re: /\[system\]\s+hardware check unavailable/i,
    render: () => ({
      indent: 'main',
      severity: 'warn',
      tokens: [w('System check unavailable; starting with backend defaults')],
    }),
  },
  {
    re: /\[ui-progress\]\s+([a-z_]+)\s+\[(\d+)\s*\/\s*(\d+)\]/i,
    render: (m) => {
      const stage = m[1].toLowerCase()
      const cur = parseInt(m[2], 10)
      const total = parseInt(m[3], 10)
      if (!Number.isFinite(cur) || !Number.isFinite(total) || total <= 0) return null
      return progressLine(`progress:${stage}`, stageLabels[stage] ?? stage, (cur / total) * 100)
    },
  },
  {
    re: /Step\s+1\s*\/\s*5:\s*Batch-transcribe\s+(\d+)/i,
    render: (m) => ({
      indent: 'main',
      tokens: [v('Reading'), p(' speech from '), n(m[1]), p(' videos...')],
    }),
  },
  {
    re: /\[source windows\]\s+\[(\d+)\s*\/\s*(\d+)\]\s+(.+?)\s+([\d.]+)s-([\d.]+)s\s*->\s*(\S+)\s+transcode:\s*(\d+)%/i,
    render: (m) => progressLine(
      'progress:source',
      `preparing ${shortName(m[6])}`,
      parseInt(m[7], 10),
    ),
  },
  {
    re: /\[source windows\]\s+\[(\d+)\s*\/\s*(\d+)\]\s+(.+?)\s+([\d.]+)s-([\d.]+)s\s*->\s*(\S+)/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [
        p('preparing window '), n(`${m[1]}/${m[2]}`),
        p(' from '), f(shortName(m[3])),
        p(' -> '), f(shortName(m[6])),
      ],
    }),
  },
  {
    re: /\[source windows\]\s+\[(\d+)\s*\/\s*(\d+)\]\s+using full source\s+(\S+)/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('using full source '), n(`${m[1]}/${m[2]}`), p(' '), f(shortName(m[3]))],
    }),
  },
  {
    re: /Source windows:\s+replacing\s+(\d+)\s+selected source file\(s\)\s+with\s+(\d+)\s+manual window clip/i,
    render: (m) => ({
      indent: 'main',
      tokens: [d('Manual windows ready'), p(' | files '), n(m[1]), p(' | clips '), n(m[2])],
    }),
  },
  {
    re: /\[whisper-batch\]\s+config.*requested_device='([^']+)'.*gpu_preflight_reason='([^']*)'.*gpu_preflight_free_mb='([^']*)'/i,
    render: (m) => ({
      indent: 'sub',
      updateKey: 'gpu:check',
      tokens: [
        p('GPU check '), n(m[1]),
        p(' | '), d(m[2] || 'ready'),
        m[3] ? p(' | free ') : p(''),
        m[3] ? n(`${m[3]}MB`) : p(''),
      ],
    }),
  },
  {
    re: /\[w pid=\d+\]\s+init\s+.*resolved_device='([^']+)'.*compute_type='([^']+)'.*model='([^']+)'/i,
    render: (m) => ({
      indent: 'sub',
      updateKey: 'whisper:worker',
      tokens: [p('whisper worker '), n(m[1]), p(' | '), f(m[3]), p(' | '), n(m[2])],
    }),
  },
  {
    re: /model_ready\s+load_s=([\d.]+)\s+active_device='([^']+)'\s+active_compute='([^']+)'/i,
    render: (m) => ({
      indent: 'sub',
      updateKey: 'whisper:model_ready',
      tokens: [d('model ready'), p(' | '), n(m[2]), p(' | load '), n(`${Math.round(parseFloat(m[1]))}s`)],
    }),
  },
  {
    re: /file_start.*(?:wav|input)='([^']+)'/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('reading '), f(shortName(m[1]))],
    }),
  },
  {
    re: /\[whisper-progress\]\s*\[(\d+)\s*\/\s*100\]/,
    render: (m) => progressLine('progress:speech', 'speech', parseInt(m[1], 10)),
  },
  {
    re: /Step\s+1\s+total:\s*([\d.]+)s/i,
    render: (m) => ({
      indent: 'main',
      tokens: [d('Speech reading done'), p(' | '), n(`${Math.round(parseFloat(m[1]))}s`)],
    }),
  },
  {
    re: /Step\s+2\s*\/\s*5/i,
    render: () => ({
      indent: 'main',
      tokens: [v('Finding'), p(' intro video...')],
    }),
  },
  {
    re: /Selected intro:\s*(\S+?)(?:\s|$)/,
    render: (m) => ({
      indent: 'main',
      tokens: [p('Intro video: '), f(m[1])],
    }),
  },
  {
    re: /Using timeline title window; auto intro detection skipped:\s*(\S+)\s+([\d.]+)s-([\d.]+)s/i,
    render: (m) => ({
      indent: 'main',
      tokens: [d('Using manual intro'), p(': '), f(m[1]), p(' '), n(`${m[2]}s-${m[3]}s`)],
    }),
  },
  {
    re: /INTRO soft-fallback selected:\s*(\S+)/,
    render: (m) => ({
      indent: 'main',
      severity: 'warn',
      tokens: [w('Intro picked with low confidence - please double-check ('), f(m[1]), w(')')],
    }),
  },
  {
    re: /Cannot auto-detect intro file/,
    render: () => ({
      indent: 'main',
      severity: 'error',
      tokens: [er("Couldn't pick intro - please right-click a file -> Set as Intro")],
    }),
  },
  {
    re: /Step\s+3\s*\/\s*5/i,
    render: () => ({
      indent: 'main',
      tokens: [v('Checking'), p(' time stamps...')],
    }),
  },
  {
    re: /\[OCR\]\s+(\S+):\s+/,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('reading time stamps from '), f(m[1])],
    }),
  },
  {
    re: /OCR resolving timestamps for (\d+) file\(s\)/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('resolving time order for '), n(m[1]), p(' files')],
    }),
  },
  {
    re: /\[OCR anchor\]\s+(\S+):/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('anchor time from '), f(m[1])],
    }),
  },
  {
    re: /\[OCR WARN\]\s+(.+)/i,
    render: (m) => ({
      indent: 'sub',
      severity: 'warn',
      tokens: [w(`time stamp warning: ${m[1].trim()}`)],
    }),
  },
  {
    re: /Step\s+4\s*\/\s*5/i,
    render: () => ({
      indent: 'main',
      tokens: [v('Building'), p(' cut list...')],
    }),
  },
  {
    re: /Source EDL \+ timeline title:\s*body = (\d+) manual range clip/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [d('Using manual windows'), p(' | '), n(m[1]), p(' clips')],
    }),
  },
  {
    re: /body_files filter applied:\s*(\d+)\/(\d+)/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('selected files kept '), n(`${m[1]}/${m[2]}`)],
    }),
  },
  {
    re: /Cover window:\s*([\d.]+)s\s*->\s*([\d.]+)s/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('intro cover window '), n(`${m[1]}s-${m[2]}s`)],
    }),
  },
  {
    re: /\[speech filter\]\s+(\S+):\s+removed\s+(\d+)\s+hallucinated/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('speech filter '), f(m[1]), p(' removed '), n(m[2]), p(' hallucinated words')],
    }),
  },
  {
    re: /\[audio energy\]\s+rescued\s+(\d+)/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('audio energy rescued '), n(m[1]), p(' ranges')],
    }),
  },
  {
    re: /\[audio energy\]\s+(.+?):\s+(\d+)%\s+\((\d+)\/(\d+)s\)/i,
    render: (m) => progressLine(
      'progress:audio',
      `audio scan ${shortName(m[1])}`,
      parseInt(m[2], 10),
    ),
  },
  {
    re: /\[audio energy\]\s+scanning\s+(.+?)\s+\((\d+)s\)/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('audio scan '), f(shortName(m[1])), p(' | '), n(`${m[2]}s`)],
    }),
  },
  {
    re: /\[intro cover clamp\]\s+(\S+)\s+locks start >= ([\d.]+)s/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('intro lock from '), f(m[1]), p(' >= '), n(`${m[2]}s`)],
    }),
  },
  {
    re: /\[visual filter\]\s+kept=(\d+)\/(\d+)\s+dropped_bad_frame=(\d+)/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('visual filter kept '), n(`${m[1]}/${m[2]}`), p(' | bad frames '), n(m[3])],
    }),
  },
  {
    re: /\[content refine\]\s+kept=(\d+)\/(\d+)\s+dropped=(\d+)/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('content refine kept '), n(`${m[1]}/${m[2]}`), p(' | dropped '), n(m[3])],
    }),
  },
  {
    re: /\[window refine\]\s+segments=(\d+)->(\d+).*dropped_sec=([\d.]+)/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('window refine '), n(`${m[1]}->${m[2]}`), p(' | removed '), n(`${m[3]}s`)],
    }),
  },
  {
    re: /Source EDL:\s*final EDL remapped back/i,
    render: () => ({
      indent: 'sub',
      tokens: [d('Manual windows mapped back to source files')],
    }),
  },
  {
    re: /EDL saved to\s+(.+)/i,
    render: () => ({
      indent: 'main',
      tokens: [d('Cut list saved')],
    }),
  },
  {
    re: /--skip-render:\s*skipping ffmpeg render/i,
    render: () => ({
      indent: 'main',
      tokens: [d('Analysis ready'), p(' | render skipped')],
    }),
  },
  {
    re: /Performance:\s*peak RAM\s*([\d.]+)MB/i,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('peak RAM '), n(`${Math.round(parseFloat(m[1]))}MB`)],
    }),
  },
  {
    re: /raw_body=([\d.]+)m\s+final_body=([\d.]+)m\s+target=[^\s]*\s+padding=[^\s]+\s+segs=(\d+)/i,
    render: (m) => {
      const minutes = Math.max(1, Math.round(parseFloat(m[2])))
      return {
        indent: 'main',
        tokens: [
          d('Cut list ready'), p(' | '),
          n(m[3]), p(' clips | '),
          n(`${minutes} minutes`),
        ],
      }
    },
  },
  {
    re: /Step\s+5\s*\/\s*5/i,
    render: () => ({
      indent: 'main',
      tokens: [v('Rendering'), p(' video...')],
    }),
  },
  {
    re: /\[render-progress\]\s*\[(\d+)\s*\/\s*100\]/,
    render: (m) => progressLine('progress:render', 'render', parseInt(m[1], 10)),
  },
  {
    re: /retry device='cpu'/i,
    render: () => ({
      indent: 'main',
      severity: 'warn',
      tokens: [w('GPU model load failed - retrying on CPU (slower)')],
    }),
  },
  {
    re: /Pipeline timeout:\s*(.+)/i,
    render: (m) => ({
      indent: 'main',
      severity: 'error',
      tokens: [er(`Pipeline timeout: ${m[1].trim()}`)],
    }),
  },
  {
    re: /\bERROR\b\s*(.+)/i,
    render: (m) => ({
      indent: 'main',
      severity: 'error',
      tokens: [er(m[1].trim())],
    }),
  },
  {
    re: /\bWARN(?:ING)?\b\s*(.+)/i,
    render: (m) => ({
      indent: 'sub',
      severity: 'warn',
      tokens: [w(m[1].trim())],
    }),
  },
]

export function translate(rawLine: string): UserLine | null {
  for (const entry of PATTERNS) {
    const m = rawLine.match(entry.re)
    if (m) return entry.render(m)
  }
  return null
}

export function translateAll(rawLines: string[]): UserLine[] {
  const out: UserLine[] = []
  const updateIndexes = new Map<string, number>()
  for (const raw of rawLines) {
    const t = translate(raw)
    if (t === null) continue
    if (t.updateKey) {
      const idx = updateIndexes.get(t.updateKey)
      if (idx !== undefined) {
        out.splice(idx, 1)
        for (const [key, value] of updateIndexes) {
          if (value > idx) updateIndexes.set(key, value - 1)
        }
        updateIndexes.set(t.updateKey, out.length)
        out.push(t)
        continue
      }
      updateIndexes.set(t.updateKey, out.length)
    }
    out.push(t)
  }
  return out
}
