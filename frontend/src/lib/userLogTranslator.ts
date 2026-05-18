// Translates raw backend log lines into colourised user-friendly tokens for
// the in-pipeline terminal. Unmatched lines stay hidden here; raw backend logs
// are still written under the job's _diveedit logs folder.

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
  return {
    indent: 'sub',
    updateKey: key,
    tokens: [
      p(`${label} [`),
      clamped >= 100 ? d(progressBar(clamped)) : n(progressBar(clamped)),
      p('] '),
      clamped >= 100 ? d('done') : n(`${clamped}%`),
    ],
  }
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
    re: /file_start[^']*wav='([^']+)'/,
    render: (m) => ({
      indent: 'sub',
      tokens: [p('reading '), f(m[1])],
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
    re: /Step\s+4\s*\/\s*5/i,
    render: () => ({
      indent: 'main',
      tokens: [v('Building'), p(' cut list...')],
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
        out[idx] = t
        continue
      }
      updateIndexes.set(t.updateKey, out.length)
    }
    out.push(t)
  }
  return out
}
