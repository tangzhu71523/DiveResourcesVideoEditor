import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square, Download, RotateCcw, Type, Rows3, WholeWord, Eye, EyeOff } from 'lucide-react'
import Header from './components/Header'
import Stepper from './components/Stepper'
import JobImportSection from './components/sections/JobImportSection'
import { pushRecentFolder } from './components/sections/recentFolders'
import TimelineSection from './components/sections/TimelineSection'
import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from './components/timeline/zoom'
import PreviewBox from './components/sections/PreviewBox'
import ExportProgressDialog from './components/ExportProgressDialog'
import LogsDrawer from './components/LogsDrawer'
import ConfirmDialog from './components/ui/ConfirmDialog'
import Tooltip from './components/ui/Tooltip'
import type { EDL, JobMeta, OverlayElement, PipelineStage, Segment, StageProgress, VideoFile } from './types/edl'
import { DEFAULT_COVER_OVERLAY, DEFAULT_SMALL_OVERLAY, DEFAULT_LOGO_OVERLAY } from './types/edl'
import type { LogoOverlay } from './types/edl'

// EDL helpers: intro is now stored as a segment with label === 'INTRO'.
// API loaders normalize old edl/baseline/history schemas before state use.
const segsOf = (edl: EDL | null): Segment[] =>
  Array.isArray(edl?.segments) ? (edl!.segments as Segment[]) : []
const introOf = (edl: EDL | null): Segment | null =>
  segsOf(edl).find((s) => s.label === 'INTRO') ?? null
const bodySegs = (edl: EDL | null): Segment[] =>
  segsOf(edl).filter((s) => s.label !== 'INTRO')
const edlHasTimeline = (edl: EDL | null): boolean =>
  segsOf(edl).length > 0
const replaceBody = (edl: EDL, body: Segment[]): EDL => {
  const intro = segsOf(edl).filter((s) => s.label === 'INTRO')
  return { ...edl, segments: [...intro, ...body] }
}
const replaceIntro = (edl: EDL, intro: Segment | null): EDL => {
  const body = segsOf(edl).filter((s) => s.label !== 'INTRO')
  return { ...edl, segments: intro ? [intro, ...body] : body }
}
const emptyEdl = (): EDL => ({
  segments: [],
  target_duration_sec: 0,
  actual_body_duration_sec: 0,
  raw_body_duration_sec: 0,
  adaptive_padding_sec: 0,
})
const fileBase = (file: string): string =>
  file.split(/[\\/]/).pop() ?? file
const laneFilesForEdl = (
  edl: EDL,
  persisted: string[] = [],
  cache: Array<[string, Segment[]]> = [],
): Set<string> => {
  const hidden = new Set(cache.map(([name]) => name))
  const out = new Set(persisted)
  for (const seg of segsOf(edl)) {
    const base = fileBase(seg.file)
    if (!hidden.has(base)) out.add(base)
  }
  return out
}
const edlSignature = (edl: EDL | null): string =>
  segsOf(edl)
    .map((s) => `${fileBase(s.file)}|${Math.round(s.start * 10)}|${Math.round(s.end * 10)}|${s.label}`)
    .join(';')
const historyMatchesBaseline = (
  history: { entries: { edl: EDL }[] },
  baseline: EDL | null,
): boolean => {
  if (!baseline) return true
  const root = history.entries[0]?.edl ?? null
  return edlSignature(root) === edlSignature(baseline)
}

interface PreviewSource {
  filePath: string
  start: number
  end: number
}

import {
  cancelRun, connectLogs, getSystemInfo, listFiles, loadEDL, loadJob,
  pickFolder, saveEDL, saveJob, startExport, startRun, startThumbnails,
  loadEDLBaseline, loadEDLHistory, saveEDLHistory, deleteEDLHistory,
  type RunEvent, type SystemInfo,
} from './lib/api'
import { lockTextSelect, unlockTextSelect } from './lib/dragLock'
import { translateAll } from './lib/userLogTranslator'

type RunPhase = 'idle' | 'running' | 'finished' | 'error'

const BODY_NONE_SENTINEL = '__DIVE_BODY_NONE__'

const EMPTY_JOB: JobMeta = {
  job_no: '',
  vessel: '',
  intro_file: '',
  body_files: [],
  cover_lines: [],
  small_lines: [],
  target_duration_min: 0,
  intro_speech_override: null,
}

const INITIAL_STAGES: Record<PipelineStage, StageProgress> = {
  whisper: { stage: 'whisper', status: 'pending' },
  intro:   { stage: 'intro',   status: 'pending' },
  ocr:     { stage: 'ocr',     status: 'pending' },
  edl:     { stage: 'edl',     status: 'pending' },
  render:  { stage: 'render',  status: 'pending' },
}

const MAX_HISTORY = 50

const ANALYZE_STAGES: PipelineStage[] = ['whisper', 'intro', 'ocr', 'edl']

// User-facing pseudo-terminal that lives between the logo and the
// Export button. Raw log lines are filtered + translated via
// userLogTranslator: lines that don't match a known pattern are
// silently dropped (still kept in run.log on disk). Matching lines
// render colourised tokens via the .tok-* CSS classes. Auto-scrolls
// to bottom on new content.
function PipelineLogTerminal({
  logs, runPhase,
}: {
  logs: string[]
  runPhase: 'idle' | 'running' | 'finished' | 'error'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  // Translate the full buffer so acceptance runs can scroll back to
  // startup lines even after noisy progress updates.
  const lines = useMemo(() => {
    return translateAll(logs)
  }, [logs])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [lines])
  const idleHint =
    lines.length === 0 && runPhase === 'idle' ? 'Press Start to begin processing.' :
    lines.length === 0 && runPhase === 'running' ? 'Starting up...' :
    null
  return (
    <div
      style={{
        flex: 1,
        minHeight: 80,
        marginTop: 10,
        marginBottom: 10,
        borderRadius: 6,
        border: '1px solid var(--glass-border)',
        background: 'var(--bg-raised)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '8px 10px',
          fontFamily: "'JetBrains Mono', Consolas, monospace",
          fontSize: 11,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: 'text',
          cursor: 'text',
        }}
      >
        {idleHint ? (
          <div style={{ color: 'rgb(var(--text-muted))', fontStyle: 'italic' }}>{idleHint}</div>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={`term-line ${line.indent === 'sub' ? 'term-sub' : ''} ${line.severity ? 'term-sev-' + line.severity : ''}`}
            >
              {line.tokens.map((t, j) => (
                <span key={j} className={`tok-${t.kind}`}>{t.text}</span>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

interface ControlPanelProps {
  jobMeta: JobMeta
  onJobMetaChange: (m: JobMeta) => void
  runPhase: 'idle' | 'running' | 'finished' | 'error'
  canRun: boolean
  edl: EDL | null
  onRun: () => void
  onForceStop: () => void
  onExport: () => void
  // Overlay controls (compact panel below INPUT header).
  // Selection: click the matching textarea below to set active target;
  // null = nothing selected (steppers still show cover values for
  // visual continuity, but onChange is gated).
  onOverlayReset: () => void
  selectedOverlay: 'cover' | 'small' | null
  onSelectOverlay: (which: 'cover' | 'small') => void
  overlayVisible: boolean
  onOverlayToggleVisible: () => void
  fontSize: number
  onFontSizeChange: (v: number) => void
  lineSpacing: number
  onLineSpacingChange: (v: number) => void
  letterSpacing: number
  onLetterSpacingChange: (v: number) => void
  // Same derived watermark lines that PreviewBox renders. Used as the
  // textbox fallback so what user sees in the input matches the overlay.
  effectiveSmallLines: string[]
  // Live log buffer driving the inline pseudo-terminal in the pipeline
  // panel. Replaces the old "Xs ago: ? activity readout; user wanted
  // a richer feed in that slot, see PipelineLogTerminal below.
  logs: string[]
}

function ControlPanel({
  jobMeta, onJobMetaChange, runPhase, canRun, edl, onRun, onForceStop, onExport,
  onOverlayReset,
  selectedOverlay, onSelectOverlay,
  overlayVisible, onOverlayToggleVisible,
  fontSize, onFontSizeChange,
  lineSpacing, onLineSpacingChange,
  letterSpacing, onLetterSpacingChange,
  effectiveSmallLines,
  logs,
}: ControlPanelProps) {
  const canExport = edl !== null && bodySegs(edl).length > 0 && runPhase !== 'running'

  // Two side-by-side panels: INPUT (cover/small text) + PIPELINE (Start
  // ?analyze stages ?Export ?render progress). Target field removed
  // ?was unused friction; backend defaults handle target duration.
  return (
    <div style={{ height: '100%', display: 'flex', gap: 10, minHeight: 0 }}>
      {/*  INPUT  */}
      <div className="card-panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '12px 14px' }}>
        {/* Header row: INPUT label on left, Eye (toggle visibility) +
            Reset on right (primary blue, same as Start button). */}
        <div data-overlay-controls style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <div style={{ width: 3, height: 14, borderRadius: 2, background: 'linear-gradient(180deg, #3b82f6, #6366f1)' }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--section-label)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>INPUT</span>
          </div>
          <Tooltip content={overlayVisible ? 'Hide overlay' : 'Show overlay'}>
          <button
            type="button"
            className={overlayVisible ? 'btn icon sm primary' : 'btn icon sm'}
            onClick={onOverlayToggleVisible}
          >
            {overlayVisible ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          </Tooltip>
          <Tooltip content="Reset overlay to defaults">
          <button
            type="button"
            className="btn primary sm"
            onClick={onOverlayReset}
          >
            <RotateCcw size={11} /> Reset
          </button>
          </Tooltip>
        </div>

        {/* Overlay parameter panel ?3 horizontal stepper rows on a
            single line. Each stepper = [icon box] [- value +]. Icons
            replace text labels for compactness. Reset is in header.
            Target selection: click a textarea below. */}
        <div data-overlay-controls style={{
          flexShrink: 0, marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          // space-evenly: 4 gaps (edge|S1|S2|S3|edge) all equal, scales
          // with panel width ?3 steppers stay rigid-content-sized but
          // the surrounding whitespace adapts so the row is balanced
          // at every viewport size.
          justifyContent: 'space-evenly',
          flexWrap: 'nowrap',
          gap: 0,
          minWidth: 0,
        }}>
          <Stepper
            icon={<Type size={13} />}
            label="Font"
            value={fontSize}
            step={4}
            min={12}
            max={240}
            onChange={onFontSizeChange}
            title="Font size (px). Min 12, step 4."
          />
          <Stepper
            icon={<Rows3 size={13} />}
            label="Line"
            value={lineSpacing}
            step={2}
            min={0}
            max={44}
            onChange={onLineSpacingChange}
            title="Line spacing (px). 0 = no gap, max 44, step 2."
          />
          <Stepper
            icon={<WholeWord size={13} />}
            label="Letter"
            value={letterSpacing}
            step={2}
            min={0}
            max={22}
            onChange={onLetterSpacingChange}
            title="Letter spacing (px). 0 = no extra gap, max 22, step 2."
          />
        </div>

        {/* Title + Watermark textareas ?back to equal flex split.
            Param panel is now a single horizontal icon-row (shorter than
            the label-on-top design), so watermark grows back to flex 1
            to keep the textarea ratio matching the previous layout. */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'rgb(var(--text-secondary))', marginBottom: 3, flexShrink: 0 }}>
              Title <span style={{ color: 'rgb(var(--danger))' }}>*</span>
            </div>
            <textarea
              data-overlay-target="cover"
              className="v5-textarea"
              style={{
                flex: 1, minHeight: 0, resize: 'none',
                boxShadow: selectedOverlay === 'cover'
                  ? '0 0 0 2px rgb(var(--accent-500))'
                  : 'none',
                transition: 'box-shadow 100ms linear',
              }}
              value={jobMeta.cover_lines.join('\n')}
              onMouseDown={() => onSelectOverlay('cover')}
              onFocus={() => {
                onSelectOverlay('cover')
                // Re-implements the deleted "Jump to Cover" target icon ?
                // focusing this textarea scrolls the timeline to the
                // start of the title-overlay period.
                window.dispatchEvent(new CustomEvent('dive.scrollToCover', {
                  detail: { target: 'title' },
                }))
              }}
              onChange={(e) => onJobMetaChange({ ...jobMeta, cover_lines: e.target.value.split('\n') })}
              placeholder="JOB NO: ...&#10;VESSEL NAME: ...&#10;TASK: ..."
            />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'rgb(var(--text-secondary))', marginBottom: 3, flexShrink: 0 }}>
              Watermark
            </div>
            <textarea
              data-overlay-target="small"
              className="v5-textarea"
              style={{
                flex: 1, minHeight: 0, resize: 'none',
                boxShadow: selectedOverlay === 'small'
                  ? '0 0 0 2px rgb(var(--accent-500))'
                  : 'none',
                transition: 'box-shadow 100ms linear',
              }}
              value={(jobMeta.small_lines.some((l) => l && l.trim() !== '')
                ? jobMeta.small_lines
                : effectiveSmallLines
              ).join('\n')}
              onMouseDown={() => onSelectOverlay('small')}
              onFocus={() => {
                onSelectOverlay('small')
                // Same redirect as Title: scroll timeline to the first
                // body segment where the watermark overlay takes over.
                window.dispatchEvent(new CustomEvent('dive.scrollToCover', {
                  detail: { target: 'watermark' },
                }))
              }}
              onChange={(e) => onJobMetaChange({ ...jobMeta, small_lines: e.target.value.split('\n') })}
              placeholder="Auto-derived from Title; type to override"
            />
          </div>
        </div>
      </div>

      {/*  PIPELINE + EXPORT 
          padding-bottom 22px puts the Export button exactly 22px above
          the panel bottom edge (was 20px ?+2px tweak per spec). */}
      <div className="card-panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0, padding: '12px 14px 22px' }}>
        {/* Header: PIPELINE label + Start/Cancel */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <div style={{ width: 3, height: 14, borderRadius: 2, background: 'linear-gradient(180deg, #3b82f6, #6366f1)' }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--section-label)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>PIPELINE</span>
          </div>
          {runPhase === 'running' ? (
            <button
              type="button"
              className="btn sm"
              onClick={onForceStop}
              style={{
                background: 'rgb(var(--danger))',
                color: '#fff',
                borderColor: 'rgb(var(--danger))',
              }}
            >
              <Square size={11} fill="currentColor" /> Cancel
            </button>
          ) : (
            <button type="button" className="btn primary sm" onClick={onRun} disabled={!canRun}>
              <Play size={11} fill="currentColor" /> Start
            </button>
          )}
        </div>

        {/* Pre-flight banner removed ?Start button disabled state
            covers it. LogoWaveProgress also removed per fallback -
            the blank area between PIPELINE header and Export is now
            occupied entirely by the pseudo-terminal. */}
        <PipelineLogTerminal logs={logs} runPhase={runPhase} />

        {/* Export button ?pushed to bottom by `marginTop: auto`. The
            panel's `padding-bottom: 20px` then provides the 20-px
            gap between button and panel edge requested by the spec. */}
        <div style={{ flexShrink: 0, marginTop: 'auto' }}>
          <button type="button" className="btn primary" style={{ width: '100%', justifyContent: 'center' }}
            onClick={onExport} disabled={!canExport}
          >
            <Download size={13} /> Export
          </button>
        </div>

      </div>
    </div>
  )
}

export default function App() {
  const [folder, setFolder] = useState<string | null>(null)
  const [files, setFiles] = useState<VideoFile[]>([])
  const [jobMeta, setJobMeta] = useState<JobMeta>(EMPTY_JOB)
  const [edl, setEDL] = useState<EDL | null>(null)
  // Super-undo: a single doc { entries, cursor } where each entry holds a
  // FULL UI snapshot (edl + laneFiles + laneFileCache). Cursor is the index
  // of the currently visible entry. Edit while cursor < last truncates the
  // tail (standard branch-discard like Photoshop / VSCode). The doc is
  // persisted to disk so closing/reopening the folder keeps the chain back
  // to the pipeline baseline.
  type HistorySnap = {
    edl: EDL
    laneFiles: string[]
    laneFileCache: Array<[string, Segment[]]>
  }
  const [historyDoc, setHistoryDoc] = useState<{ entries: HistorySnap[]; cursor: number }>({ entries: [], cursor: -1 })
  const [stages, setStages] = useState(INITIAL_STAGES)
  // Indeterminate stripe is a CSS keyframe animation; the progress
  // percent only changes when a backend [N/M] event lands. Neither
  // path needs a React-driven tick, so no setInterval here.
  const [exportProgressOpen, setExportProgressOpen] = useState(false)
  const [exportOutputDir, setExportOutputDir] = useState<string | null>(null)
  const [logsOpen, setLogsOpen] = useState(false)
  const [, forceRerender] = useState(0)

  // Themed dialog state ?replaces window.confirm / window.alert.
  // null = closed; otherwise the displayed config drives the modal.
  const [dialog, setDialog] = useState<{
    title: string
    body: string
    confirmLabel: string
    cancelLabel: string
    variant: 'default' | 'danger'
    onConfirm: () => void
  } | null>(null)
  const closeDialog = useCallback(() => setDialog(null), [])
  useEffect(() => {
    const handler = () => forceRerender((n) => n + 1)
    window.addEventListener('dive.devMode.change', handler)
    return () => window.removeEventListener('dive.devMode.change', handler)
  }, [])

  //  System info (GPU detection) ?fetch on mount + on window focus.
  // Re-fetching on focus picks up backend restarts (e.g. user edited
  // gpu.py and restarted) without requiring a hard browser refresh.
  // Worker count is no longer user-tunable ?backend uses DIVE_FORCE_CPU /
  // DIVE_CUDA_STATUS / DIVE_CUDNN_STATUS at runtime to decide.
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    const fetchInfo = (): void => {
      getSystemInfo()
        .then((info) => {
          if (cancelled) return
          setSystemInfo(info)
        })
        .catch(() => { /* network/health fail - keep last known */ })
    }
    fetchInfo()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') fetchInfo()
    }
    window.addEventListener('focus', fetchInfo)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.removeEventListener('focus', fetchInfo)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const [runPhase, setRunPhase] = useState<RunPhase>('idle')
  const [logs, setLogs] = useState<string[]>([])
  const [selectedSegIdx, setSelectedSegIdx] = useState<number | null>(null)
  const [selectedSegIdxs, setSelectedSegIdxs] = useState<Set<number>>(() => new Set())
  // ?intro window ??body segments + lane ??
  // Delete ?EDL ?intro ?"?
  // body ?intro")?false?
  const [selectedIntro, setSelectedIntro] = useState(false)
  // Preview segment is decoupled from selection: clicking a timeline window
  // only highlights it (selectedSegIdx); the preview / playhead stays put.
  // Other paths (drag-to-seek, prev/next, edl load, delete) explicitly sync
  // both via the helper below ?only the timeline-click path skips the sync.
  const [previewSegIdx, setPreviewSegIdx] = useState<number | null>(null)
  // ????
  //   1. ??onSeek 
  //   2. ?PreviewBox ?
  //   3. ?/ 
  // ??
  const [playheadSec, setPlayheadSec] = useState<number>(0)
  const [pendingSeek, setPendingSeek] = useState<{ offset: number; nonce: number } | null>(null)
  // "Add files to lane" mode ?toggled by the FilePlus button in the
  // timeline toolbar. While true, every region except the INPUT card and
  // the FilePlus button is dimmed/blocked. Click on a file row in INPUT
  // (or shift-click for range) adds it to laneFiles. Click on the dim
  // overlay does nothing ?exit only via the FilePlus button.
  const [addingFiles, setAddingFiles] = useState(false)
  // Reused for every region we want to obscure while in add-files mode.
  // Mirrors the ExportProgressDialog backdrop (blur 4px + slight tint).
  // Light mode also gets a brightness-down so the dimmed areas read as
  // "muted" instead of just "blurred"; dark mode is already dim enough.
  const dimStyle: React.CSSProperties | null = (() => {
    if (!addingFiles) return null
    const isLight = typeof document !== 'undefined'
      && document.documentElement.getAttribute('data-theme') !== 'dark'
    return {
      filter: isLight ? 'blur(4px) brightness(0.7)' : 'blur(4px)',
      opacity: isLight ? 0.7 : 0.55,
      pointerEvents: 'none',
      transition: 'filter 120ms ease-out, opacity 120ms ease-out',
    }
  })()

  // Files currently shown as lanes in the timeline. Decoupled from
  // jobMeta.body_files (which is purely the pipeline-run scope) so the
  // user's import-list checkboxes never resurrect or remove a lane.
  // in the resulting EDL.body_segments) and via the FilePlus add-files
  // mode (manual additions by the user).
  const [laneFiles, setLaneFiles] = useState<Set<string>>(new Set())
  // ?timeline ?segments  = basename?
  // ?file ?body_segments ?EDL ;
  // ?timeline ??segments,?
  // ?useEffect )?
  const [laneFileCache, setLaneFileCache] = useState<Map<string, Segment[]>>(() => new Map())
  // Mirror state into refs so commitEdl can snapshot them synchronously
  // without waiting for React to flush. Updated AFTER the state change
  // commits, which matches what we want: snapshot reflects the state at
  // the time commitEdl runs (which is the state visible to the next render).
  const laneFilesRefMirror = useRef(laneFiles)
  laneFilesRefMirror.current = laneFiles
  const laneFileCacheRefMirror = useRef(laneFileCache)
  laneFileCacheRefMirror.current = laneFileCache
  const thumbnailQueuedRef = useRef<Set<string>>(new Set())
  // Forward-ref so addFileToLane / removeLaneFile (declared above commitEdl)
  // can still invoke it. Updated below once commitEdl is constructed.
  const commitEdlRef = useRef<(next: EDL) => void>(() => {})
  // addFileToLane ?commitEdl:??cache ???full-duration ?
  //  undo ?EDL ?null ?EDL?
  const addFileToLane = useCallback((fileName: string) => {
    const fileExists = files.some((f) => f.name === fileName)
    const cached = laneFileCache.get(fileName)
    if (!fileExists && !cached) return
    let nextEdl: EDL | null = edl
    let nextCache = laneFileCache
    if (cached && cached.length > 0) {
      // ?cache ?segments ?EDL?
      const curEdl = edl
      if (curEdl) {
        const existing = new Set(bodySegs(curEdl).map((s) => `${s.file}|${s.start}|${s.end}`))
        const merged = [...bodySegs(curEdl)]
        for (const seg of cached) {
          const key = `${seg.file}|${seg.start}|${seg.end}`
          if (!existing.has(key)) merged.push(seg)
        }
        const fileOrder = new Map<string, number>()
        merged.forEach((s, i) => { if (!fileOrder.has(s.file)) fileOrder.set(s.file, i) })
        merged.sort((a, b) => {
          const fa = fileOrder.get(a.file) ?? 0
          const fb = fileOrder.get(b.file) ?? 0
          if (fa !== fb) return fa - fb
          return a.start - b.start
        })
        nextEdl = replaceBody(curEdl, merged)
      }
      nextCache = new Map(laneFileCache)
      nextCache.delete(fileName)
    } else if (cached) {
      nextCache = new Map(laneFileCache)
      nextCache.delete(fileName)
    }
    const nextLf = new Set(laneFiles)
    nextLf.add(fileName)
    // ?state + refs?
    laneFilesRefMirror.current = nextLf
    laneFileCacheRefMirror.current = nextCache
    setLaneFiles(nextLf)
    if (nextCache !== laneFileCache) setLaneFileCache(nextCache)
    if (nextEdl && nextEdl !== edl) commitEdlRef.current(nextEdl)
  }, [edl, files, laneFiles, laneFileCache])
  // Lane-level selection (whole file). Lives in App.tsx so the global
  // keyboard Delete handler can act on it without going through props.
  const [selectedLaneFile, setSelectedLaneFile] = useState<string | null>(null)
  const [selectedLaneFiles, setSelectedLaneFiles] = useState<Set<string>>(() => new Set())
  const selectSegment = useCallback((idx: number | null, additive = false) => {
    setSelectedSegIdx(idx)
    if (idx === null) {
      setSelectedSegIdxs(new Set())
      return
    }
    setSelectedSegIdxs((prev) => {
      if (!additive) return new Set([idx])
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])
  const selectLaneFile = useCallback((file: string | null, additive = false) => {
    setSelectedLaneFile(file)
    if (file === null) {
      setSelectedLaneFiles(new Set())
      return
    }
    setSelectedLaneFiles((prev) => {
      if (!additive) return new Set([file])
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }, [])
  useEffect(() => {
    if (selectedSegIdx === null) setSelectedSegIdxs(new Set())
  }, [selectedSegIdx])
  useEffect(() => {
    if (selectedLaneFile === null) setSelectedLaneFiles(new Set())
  }, [selectedLaneFile])
  // PreviewBox playback state mirrored here so the timeline can lock the
  // playhead drag while video is playing.
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false)
  // :?
  // ?lane ? lane?
  const [playheadLaneFile, setPlayheadLaneFile] = useState<string | null>(null)
  useEffect(() => {
    if (!isPreviewPlaying) return
    if (previewSegIdx === null || !edl) return
    const file = bodySegs(edl)[previewSegIdx]?.file ?? null
    setPlayheadLaneFile((prev) => (prev === file ? prev : file))
  }, [isPreviewPlaying, previewSegIdx, edl])
  // removeLaneFile ?commitEdl,?lane ?undo ?next
  // state ?state + refs,?commitEdl ?refs ?snapshot?
  const removeLaneFile = useCallback((filePath: string) => {
    const base = filePath.split(/[\\/]/).pop() ?? filePath
    const curEdl = edl
    if (!curEdl) {
      // EDL  laneFiles ??
      if (laneFiles.has(base) || laneFiles.has(filePath)) {
        const nextLf = new Set(laneFiles)
        nextLf.delete(base); nextLf.delete(filePath)
        laneFilesRefMirror.current = nextLf
        setLaneFiles(nextLf)
      }
      return
    }
    const matchFile = (segFile: string) => {
      const segBase = segFile.split(/[\\/]/).pop() ?? segFile
      return segBase === base || segFile === filePath
    }
    const toCache = bodySegs(curEdl).filter((s) => matchFile(s.file))
    const nextCache = new Map(laneFileCache)
    if (toCache.length > 0) {
      nextCache.set(base, toCache)
    } else if (!nextCache.has(base)) {
      nextCache.set(base, [])
    }
    const nextLf = new Set(laneFiles)
    nextLf.delete(base); nextLf.delete(filePath)
    const nextEdl: EDL = replaceBody(
      curEdl,
      bodySegs(curEdl).filter((s) => !matchFile(s.file)),
    )
    // ?state + refs(commitEdl buildSnapshot ?refs)?
    laneFilesRefMirror.current = nextLf
    laneFileCacheRefMirror.current = nextCache
    setLaneFiles(nextLf)
    setLaneFileCache(nextCache)
    commitEdlRef.current(nextEdl)
  }, [edl, laneFiles, laneFileCache])
  // Auto-add files referenced by the current EDL into laneFiles. Runs
  // when EDL changes (load/run-finish/edit) ?additive only, so a manual
  // entry stays in the lane even after the user deletes its windows.
  useEffect(() => {
    thumbnailQueuedRef.current = new Set()
  }, [folder])
  // :??worker
  // ,?
  useEffect(() => {
    if (!folder) return
    const queued = thumbnailQueuedRef.current
    const lanePaths = files
      .filter((f) => laneFiles.has(f.name))
      .map((f) => f.path)
      .filter((path) => !queued.has(path))
    if (lanePaths.length === 0) return
    for (const path of lanePaths) queued.add(path)
    void startThumbnails(folder, lanePaths)
  }, [folder, files, laneFiles])
  useEffect(() => {
    if (!edl) return
    const filesInEdl = new Set<string>()
    for (const seg of bodySegs(edl)) {
      const base = seg.file.split(/[\\/]/).pop() ?? seg.file
      filesInEdl.add(base)
    }
    // ,,?
    // ??
    if ((introOf(edl)?.file ?? "")) {
      const base = (introOf(edl)?.file ?? "").split(/[\\/]/).pop() ?? (introOf(edl)?.file ?? "")
      filesInEdl.add(base)
    }
    if (filesInEdl.size === 0) return
    setLaneFiles((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const n of filesInEdl) {
        // ?timeline  EDL ?
        // ???segments ?laneFileCache,?
        // addFileToLane ?
        if (laneFileCache.has(n)) continue
        if (!next.has(n)) { next.add(n); changed = true }
      }
      return changed ? next : prev
    })
  }, [edl, laneFileCache])
  // Backend ASS state removed ?overlay is now computed client-side
  // (see previewOverlayAss useMemo below) so cover/watermark text edits
  // stay in sync with the intro window in real time. Backend still writes
  // its own _overlay.ass at render time for the ffmpeg bake, but the
  // preview never reads it.
  // overlayVisible ?jobMeta.overlay_enabled,?toggle ?saveJob
  // ??export ?meta.overlay_enabled ?title /
  // watermark / logo,?preview ?
  const overlayVisible = jobMeta.overlay_enabled !== false
  const setOverlayVisible = useCallback((v: boolean) => {
    setJobMeta((p) => ({ ...p, overlay_enabled: v }))
  }, [])
  // Which overlay block (Cover title or Watermark) the toolbar steppers
  // act on. PreviewBox arms via double-click which also flips this.
  // null = no selection ?both overlays hide outlines/handles. User
  // selects by clicking the matching textarea in INPUT, or directly on
  // an overlay element in the preview. Clicking anywhere outside both
  // textareas + overlay handles + parameter steppers clears it back to
  // null (handled by the document mousedown listener below).
  const [selectedOverlay, setSelectedOverlay] = useState<'cover' | 'small' | null>(null)
  // ?overlay ??
  // ;?jobMeta ?overlay ?
  const [cachedOverlayDefaults, setCachedOverlayDefaults] = useState<{
    cover: OverlayElement
    small: OverlayElement
  } | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('dive_edit:overlay_defaults')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.cover && parsed.small) {
          setCachedOverlayDefaults(parsed)
        }
      }
    } catch { /* ignore unavailable local storage */ }
  }, [])
  useEffect(() => {
    const c = jobMeta.cover_overlay
    const s = jobMeta.small_overlay
    if (!c && !s) return
    const next = {
      cover: c ?? cachedOverlayDefaults?.cover ?? DEFAULT_COVER_OVERLAY,
      small: s ?? cachedOverlayDefaults?.small ?? DEFAULT_SMALL_OVERLAY,
    }
    try {
      localStorage.setItem('dive_edit:overlay_defaults', JSON.stringify(next))
    } catch { /* ignore unavailable local storage */ }
    setCachedOverlayDefaults(next)
    // cachedOverlayDefaults ,?
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobMeta.cover_overlay, jobMeta.small_overlay])
  const coverOverlay = jobMeta.cover_overlay ?? cachedOverlayDefaults?.cover ?? DEFAULT_COVER_OVERLAY
  const smallOverlay = jobMeta.small_overlay ?? cachedOverlayDefaults?.small ?? DEFAULT_SMALL_OVERLAY
  const logoOverlay = jobMeta.logo_overlay ?? DEFAULT_LOGO_OVERLAY
  const updateLogoOverlay = useCallback((patch: Partial<LogoOverlay>) => {
    setJobMeta((prev) => ({
      ...prev,
      logo_overlay: { ...(prev.logo_overlay ?? DEFAULT_LOGO_OVERLAY), ...patch },
    }))
  }, [])
  // When no selection, fall back to coverOverlay so the steppers still
  // show numbers (their onChange is gated by selectedOverlay anyway).
  const activeOverlay = selectedOverlay === 'small' ? smallOverlay : coverOverlay

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (
        t.closest('[data-overlay-target]') ||
        t.closest('[data-overlay-controls]') ||
        t.closest('[data-overlay-text]') ||
        t.closest('[data-overlay-handle]')
      ) return
      setSelectedOverlay(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])
  const updateOverlay = useCallback(
    (target: 'cover' | 'small', patch: Partial<OverlayElement>) => {
      setJobMeta((prev) => {
        const cur = (target === 'cover' ? prev.cover_overlay : prev.small_overlay)
          ?? (target === 'cover' ? DEFAULT_COVER_OVERLAY : DEFAULT_SMALL_OVERLAY)
        const next = { ...cur, ...patch }
        return target === 'cover'
          ? { ...prev, cover_overlay: next }
          : { ...prev, small_overlay: next }
      })
    },
    [],
  )
  // Click Title / Watermark textarea ?move the playhead to that overlay's
  // start. Title plays during the intro window; watermark plays from the
  // first body segment onward. Without this jump the user would have to
  // drag the playhead back manually to see the overlay update.
  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent).detail?.target ?? 'watermark'
      if (target === 'title') {
        // Title overlay  = intro window ?Title
        // textbox ?= ?PreviewBox ?intro source,?showCoverTitle
        // (= previewSource.filePath === (introOf(edl)?.file ?? "")) ?title ?
        // ?setPreviewSource(null),preview  ?title
        // overlay ???
        if (!edl || !(introOf(edl)?.file ?? "")) return
        const introBase = (introOf(edl)?.file ?? "").split(/[\\/]/).pop() ?? (introOf(edl)?.file ?? "")
        const matched = files.find((f) => f.name === introBase)
        const filePath = matched ? matched.path : (introOf(edl)?.file ?? "")
        setPreviewSource({
          filePath,
          start: (introOf(edl)?.start ?? 0),
          end: (introOf(edl)?.end ?? 0),
        })
        setSelectedSegIdx(null)
        setPreviewSegIdx(null)
        return
      }
      const segs = bodySegs(edl) ?? []
      if (segs.length === 0) return
      // Watermark overlay  = body segment ?Title :
      // ?previewSegIdx,?PreviewBox ?segment ?
      // previewSegment useMemo(?previewSegIdx),selectedSegIdx ?timeline
      // ?previewSegment=null ?PreviewBox ?
      setPreviewSource(null)
      setSelectedSegIdx(0)
      setPreviewSegIdx(0)
      setPendingSeek({ offset: 0, nonce: Date.now() })
    }
    window.addEventListener('dive.scrollToCover', handler)
    return () => window.removeEventListener('dive.scrollToCover', handler)
  }, [edl, files])

  // Watermark default = title (cover_lines). Per user spec ?when the
  // user hasn't typed a custom watermark, just mirror the title verbatim
  // instead of running the legacy derive-short-form transform.
  const effectiveSmallLines = useMemo(() => {
    const cleaned = jobMeta.small_lines.filter((l) => l && l.trim() !== '')
    if (cleaned.length > 0) return cleaned
    return jobMeta.cover_lines
  }, [jobMeta.small_lines, jobMeta.cover_lines])

  // Note: previewOverlayAss / buildOverlayAss were used by jassub canvas;
  // jassub is now disabled (HTML overlay is the sole renderer) so we no
  // longer compute the ASS string at preview time. The backend still emits
  // _overlay.ass at render time for ffmpeg to bake.

  //  Canvas zoom: Ctrl+wheel, mouse-anchored 
  const [appZoom, setAppZoom] = useState(1)
  const canvasOuterRef = useRef<HTMLDivElement>(null)
  const [canvasBase, setCanvasBase] = useState({ w: 1280, h: 720 })
  const zoomAnchorRef = useRef<{ mx: number; my: number; prevZoom: number } | null>(null)
  const appZoomRef = useRef(appZoom)
  appZoomRef.current = appZoom
  const altKeyDownRef = useRef(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altKeyDownRef.current = true
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altKeyDownRef.current = false
    }
    const clear = () => { altKeyDownRef.current = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clear)
    }
  }, [])

  useEffect(() => {
    // 2026-05-05: canvas ??
    // ? ?16:9 ?device ?
    // (16:9 ???= ? ??ultrawide ? fit 16:9)?
    // ???main ? main padding ?
    // ?resize ?screen ?(??app)?
    const MIN_CANVAS_W = 1280
    const MIN_CANVAS_H = 720
    const computeBaseline = (): { w: number; h: number } => {
      // 4 ?12pxebView2 overlay scrollbar gutter=0,Header=42px?
      //   canvasBase.w = mainW - 24 = innerWidth - 24 ?left=right=12
      //   canvasBase.h = mainH - 24 = innerHeight - 42 - 24 = innerHeight - 66
      //                                                    ?top=bottom=12
      // 16:9  ??16:9 ?height-bound,?
      // ,canvas ??PreviewBox ?16:9?
      const sw = Math.min(window.screen.availWidth, window.innerWidth) - 24
      const sh = Math.min(window.screen.availHeight, window.innerHeight) - 66
      return {
        w: Math.max(sw, MIN_CANVAS_W),
        h: Math.max(sh, MIN_CANVAS_H),
      }
    }
    setCanvasBase(computeBaseline())
    // No resize listener: the screen's physical size doesn't change
    // mid-session, and binding to the window would re-introduce the
    // deformation problem this rewrite was meant to solve.
  }, [])

  useEffect(() => {
    const outer = canvasOuterRef.current
    const anchor = zoomAnchorRef.current
    if (!outer || !anchor) return
    zoomAnchorRef.current = null
    const prev = anchor.prevZoom
    const next = appZoom
    const { mx, my } = anchor
    const getOff = (z: number) => z >= 1
      ? { x: canvasBase.w * (z - 1) * 0.5, y: canvasBase.h * (z - 1) * 0.5 }
      : { x: (canvasBase.w - canvasBase.w * z) / 2, y: (canvasBase.h - canvasBase.h * z) / 2 }
    const offP = getOff(prev)
    const offN = getOff(next)
    const wx = (outer.scrollLeft + mx - offP.x) / prev
    const wy = (outer.scrollTop + my - offP.y) / prev
    outer.scrollLeft = Math.max(0, wx * next + offN.x - mx)
    outer.scrollTop = Math.max(0, wy * next + offN.y - my)
  }, [appZoom, canvasBase])

  useEffect(() => {
    const reset = () => {
      setAppZoom(1)
      if (canvasOuterRef.current) {
        canvasOuterRef.current.scrollLeft = 0
        canvasOuterRef.current.scrollTop = 0
      }
    }
    window.addEventListener('dive.resetZoom', reset)
    return () => window.removeEventListener('dive.resetZoom', reset)
  }, [])

  // Middle-click press-drag pan on the entire canvas. Hold the wheel
  // button anywhere in the UI ?cursor switches to grabbing ?moving
  // the mouse scrolls the canvas in the opposite direction (1:1, not
  // velocity-based), release wheel button ?stop. This is the original
  // pre-rev behaviour the user wants back, scoped to the WHOLE UI so
  // any spot inside `canvasOuterRef` is a valid grab handle.
  const [isPanning, setIsPanning] = useState(false)
  const panStart = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)

  useEffect(() => {
    const outer = canvasOuterRef.current
    if (!outer) return

    const onWheel = (e: WheelEvent) => {
      if (e.altKey || altKeyDownRef.current) return
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      const rect = outer.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setAppZoom((prev) => {
        const step = e.deltaY > 0 ? -0.1 : 0.1
        const next = Math.round(Math.min(3, Math.max(0.3, prev + step)) * 100) / 100
        if (next === prev) return prev
        zoomAnchorRef.current = { mx, my, prevZoom: prev }
        return next
      })
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      setIsPanning(true)
      lockTextSelect()
      panStart.current = { x: e.clientX, y: e.clientY, sl: outer.scrollLeft, st: outer.scrollTop }
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!panStart.current) return
      outer.scrollLeft = panStart.current.sl - (e.clientX - panStart.current.x)
      outer.scrollTop = panStart.current.st - (e.clientY - panStart.current.y)
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 1 || !panStart.current) return
      panStart.current = null
      setIsPanning(false)
      unlockTextSelect()
    }
    // Suppress the OS/browser middle-click autoscroll widget that would
    // otherwise hijack the pan.
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }

    outer.addEventListener('wheel', onWheel, { passive: false })
    outer.addEventListener('mousedown', onMouseDown)
    outer.addEventListener('auxclick', onAuxClick)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      outer.removeEventListener('wheel', onWheel)
      outer.removeEventListener('mousedown', onMouseDown)
      outer.removeEventListener('auxclick', onAuxClick)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])


  const [timelineZoom, setTimelineZoomRaw] = useState(1.0)
  const setTimelineZoom = useCallback((z: number) => {
    setTimelineZoomRaw(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parseFloat(z.toFixed(2)))))
  }, [])
  useEffect(() => {
    const onAltWheel = (e: WheelEvent) => {
      if (!e.altKey && !altKeyDownRef.current) return
      e.preventDefault()
      e.stopPropagation()
      const wheelUnits = Math.max(0.2, Math.min(1, Math.abs(e.deltaY) / 100))
      const delta = (e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP) * wheelUnits
      setTimelineZoomRaw((prev) => {
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev + delta))
        return parseFloat(next.toFixed(2))
      })
    }
    window.addEventListener('wheel', onAltWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onAltWheel, { capture: true })
  }, [])
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(null)
  // Title overlay shows whenever we're previewing the intro file (its
  // window IS the title display range now that the cover-bar is gone).
  // Inside body segment previews the watermark takes over.
  const showCoverTitle = previewSource?.filePath === introOf(edl)?.file
  const [initialLoad, setInitialLoad] = useState(false)
  const wsCloserRef = useRef<(() => void) | null>(null)
  const fireResultSanityRef = useRef<(newEdl: EDL | null) => void>(() => {})

  const previewSegment = useMemo<Segment | null>(() => {
    if (previewSource) {
      return {
        file: previewSource.filePath,
        start: previewSource.start,
        end: previewSource.end,
        label: 'HULL',
        score: 1,
        protected: false,
      }
    }
    if (!edl || previewSegIdx === null) return null
    return bodySegs(edl)[previewSegIdx] ?? null
  }, [edl, previewSegIdx, previewSource])

  const canUndo = historyDoc.cursor > 0
  const canRedo = historyDoc.cursor >= 0 && historyDoc.cursor < historyDoc.entries.length - 1

  const buildSnapshot = useCallback((nextEdl: EDL): HistorySnap => ({
    edl: nextEdl,
    laneFiles: Array.from(laneFilesRefMirror.current),
    laneFileCache: Array.from(laneFileCacheRefMirror.current.entries()),
  }), [])

  // Debounced save so a divider drag (60 fps) doesn't fire a PUT per move.
  const saveEdlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitEdl = useCallback((next: EDL) => {
    setEDL(next)
    const snap = buildSnapshot(next)
    setHistoryDoc((prev) => {
      // Branch discard: anything past cursor dies when a new commit lands.
      const head = prev.entries.slice(0, prev.cursor + 1)
      const withNew = [...head, snap]
      const limited = withNew.length > MAX_HISTORY ? withNew.slice(-MAX_HISTORY) : withNew
      return { entries: limited, cursor: limited.length - 1 }
    })
    if (folder) {
      if (saveEdlTimerRef.current) clearTimeout(saveEdlTimerRef.current)
      saveEdlTimerRef.current = setTimeout(() => {
        void saveEDL(folder, next)
      }, 250)
    }
  }, [folder, buildSnapshot])
  // Forward-ref bridge for addFileToLane / removeLaneFile (declared above).
  commitEdlRef.current = commitEdl

  // Restore full snapshot (EDL + lane state) when walking the history.
  const restoreSnapshot = useCallback((snap: HistorySnap) => {
    setEDL(snap.edl)
    setLaneFiles(new Set(snap.laneFiles))
    setLaneFileCache(new Map(snap.laneFileCache))
    if (folder) {
      if (saveEdlTimerRef.current) clearTimeout(saveEdlTimerRef.current)
      saveEdlTimerRef.current = setTimeout(() => {
        void saveEDL(folder, snap.edl)
      }, 250)
    }
  }, [folder])

  const undo = useCallback(() => {
    setHistoryDoc((prev) => {
      if (prev.cursor <= 0) return prev
      const cursor = prev.cursor - 1
      restoreSnapshot(prev.entries[cursor])
      return { ...prev, cursor }
    })
  }, [restoreSnapshot])

  const redo = useCallback(() => {
    setHistoryDoc((prev) => {
      if (prev.cursor < 0 || prev.cursor >= prev.entries.length - 1) return prev
      const cursor = prev.cursor + 1
      restoreSnapshot(prev.entries[cursor])
      return { ...prev, cursor }
    })
  }, [restoreSnapshot])

  // Persist historyDoc to disk (debounced). Survives across sessions so
  // closing/reopening the folder keeps the entire undo chain back to the
  const saveHistoryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!folder) return
    if (historyDoc.entries.length === 0) return
    if (saveHistoryTimerRef.current) clearTimeout(saveHistoryTimerRef.current)
    saveHistoryTimerRef.current = setTimeout(() => {
      void saveEDLHistory(folder, historyDoc)
    }, 400)
    return () => {
      if (saveHistoryTimerRef.current) clearTimeout(saveHistoryTimerRef.current)
    }
  }, [folder, historyDoc])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const folderRef = useRef<string | null>(null)
  useEffect(() => { folderRef.current = folder }, [folder])
  const folderLoadSeqRef = useRef(0)

  // Debounced auto-save: any jobMeta change (overlay drag, cover/small text
  // edit, etc.) writes back to job.yaml after 600ms of quiet. Without this,
  // overlay tweaks would only land on disk when the user hits Run/Export and
  // a browser refresh in between would drop them.
  const lastSavedJobRef = useRef<string>('')
  useEffect(() => {
    if (!folder) return
    const serialised = JSON.stringify(jobMeta)
    if (serialised === lastSavedJobRef.current) return
    const timer = setTimeout(() => {
      lastSavedJobRef.current = serialised
      void saveJob(folder, jobMeta).catch(() => { /* keep silent - UI shouldn't toast every drag */ })
    }, 600)
    return () => clearTimeout(timer)
  }, [folder, jobMeta])

  const loadFolderContents = useCallback(async (path: string) => {
    const seq = folderLoadSeqRef.current + 1
    folderLoadSeqRef.current = seq
    const stale = () => folderLoadSeqRef.current !== seq
    // Cache is owned by the job folder itself (transcripts / EDL / logs /
    // preview_cache all live next to the videos), so swapping the
    // workspace doesn't need any cleanup ?re-opening any folder later
    // re-uses whatever cache is already there. Pipeline output overwrites
    // existing cache files in place.
    setFolder(path)
    pushRecentFolder(path)
    setFiles([])
    setEDL(null)
    setHistoryDoc({ entries: [], cursor: -1 })
    setSelectedSegIdx(null)
    setSelectedIntro(false)
    setSelectedLaneFile(null)
    setPreviewSource(null)
    setPreviewSegIdx(null)
    setInitialLoad(false)
    setRunPhase('idle')
    setStages(INITIAL_STAGES)
    setLaneFiles(new Set())  // wipe lane state when switching folders
    setLaneFileCache(new Map())

    const fs = await listFiles(path)
    if (stale()) return
    setFiles(fs)

    // Hydrate jobMeta from this folder's job.yaml so cover_lines /
    // small_lines / target survive UI restarts. Without this the overlay
    // preview can't render ?buildOverlayAss requires non-empty cover or
    // watermark text.
    const persistedJob = await loadJob(path)
    if (stale()) return
    if (persistedJob) {
      // Pre-seed the auto-save fingerprint so the debounced effect that runs
      // right after setJobMeta doesn't immediately write the freshly-loaded
      // copy back to disk.
      lastSavedJobRef.current = JSON.stringify(persistedJob)
      setJobMeta(persistedJob)
    } else {
      setJobMeta((prev) => {
        const next = { ...prev, intro_file: '', body_files: [] }
        lastSavedJobRef.current = JSON.stringify(next)
        return next
      })
    }

    // Load order:
    //   1. edl.history.json   (?super-undo;cursor ?
    //   2. edl.baseline.json  (pipeline output ,deepest undo target)
    //   3. edl.json + draft   (??history/baseline ?job folder)
    const baseline = await loadEDLBaseline(path)
    if (stale()) return
    const persistedHistory = await loadEDLHistory(path)
    if (stale()) return
    if (persistedHistory && persistedHistory.entries.length > 0
        && persistedHistory.cursor >= 0
        && persistedHistory.cursor < persistedHistory.entries.length
        && historyMatchesBaseline(persistedHistory, baseline)
        && edlHasTimeline(persistedHistory.entries[persistedHistory.cursor]?.edl ?? null)) {
      const snap = persistedHistory.entries[persistedHistory.cursor]
      const snapCache = snap.laneFileCache ?? []
      const firstIdx = bodySegs(snap.edl).length > 0 ? 0 : null
      setEDL(snap.edl)
      setLaneFiles(laneFilesForEdl(snap.edl, snap.laneFiles, snapCache))
      setLaneFileCache(new Map(snapCache))
      setHistoryDoc(persistedHistory)
      setRunPhase('finished')
      setInitialLoad(true)
      setSelectedSegIdx(firstIdx)
      setPreviewSegIdx(firstIdx)
      return
    }
    if (baseline && edlHasTimeline(baseline)) {
      const laneSet = laneFilesForEdl(baseline)
      const firstIdx = bodySegs(baseline).length > 0 ? 0 : null
      setEDL(baseline)
      setLaneFiles(laneSet)
      // Seed history with baseline as entry 0 so future commits can build
      // a chain rooted in it. Undo from anywhere walks back to here.
      setHistoryDoc({
        entries: [{ edl: baseline, laneFiles: Array.from(laneSet), laneFileCache: [] }],
        cursor: 0,
      })
      setRunPhase('finished')
      setInitialLoad(true)
      setSelectedSegIdx(firstIdx)
      setPreviewSegIdx(firstIdx)
      return
    }
    const existingEdl = await loadEDL(path)
    if (stale()) return
    if (existingEdl) {
      const firstIdx = bodySegs(existingEdl).length > 0 ? 0 : null
      setEDL(existingEdl)
      setLaneFiles(laneFilesForEdl(existingEdl))
      setRunPhase('finished')
      setInitialLoad(true)
      setSelectedSegIdx(firstIdx)
      setPreviewSegIdx(firstIdx)
    }

  }, [])

  useEffect(() => {
    const initialFolder = new URLSearchParams(window.location.search).get('folder')
    if (initialFolder) void loadFolderContents(initialFolder)
  }, [loadFolderContents])

  const handleRun = useCallback(async () => {
    if (!folder) return
    const fileNameSet = new Set(files.map((f) => f.name))
    const selectedBodyFiles = (jobMeta.body_files && jobMeta.body_files.length > 0
      ? jobMeta.body_files
      : files.map((f) => f.name))
      .filter((name) => name !== BODY_NONE_SENTINEL && fileNameSet.has(name))
    const introSelectedForRun = !!jobMeta.intro_file && selectedBodyFiles.includes(jobMeta.intro_file)
    const runMeta: JobMeta = {
      ...jobMeta,
      intro_file: introSelectedForRun ? jobMeta.intro_file : '',
      body_files: selectedBodyFiles,
    }
    if (runMeta.body_files.length === 0) {
      setDialog({
        title: 'No files selected',
        body: 'No video files are available in the current folder.',
        confirmLabel: 'OK',
        cancelLabel: '',
        variant: 'danger',
        onConfirm: () => setDialog(null),
      })
      return
    }
    setRunPhase('running')
    let runSystemInfo: SystemInfo | null = systemInfo
    try {
      runSystemInfo = await getSystemInfo()
      setSystemInfo(runSystemInfo)
    } catch {
      runSystemInfo = systemInfo
    }
    const runWorkers = runSystemInfo
      ? (runSystemInfo.force_cpu
          || runSystemInfo.cuda_status === 'none'
          || runSystemInfo.cudnn_status.startsWith('missing')
        ? 1
        : Math.max(1, runSystemInfo.workers_cap))
      : 1
    const initialLogs = runSystemInfo
      ? [
          `[system] CUDA=${runSystemInfo.cuda_status} cuDNN=${runSystemInfo.cudnn_status} forceCPU=${String(runSystemInfo.force_cpu)} workers=${runWorkers} ${runSystemInfo.gpu_msg}`,
        ]
      : ['[system] hardware check unavailable']
    setLogs(initialLogs)
    setStages(INITIAL_STAGES)
    setEDL(null)
    setLaneFiles(new Set())
    setLaneFileCache(new Map())
    setSelectedSegIdx(null)
    setPreviewSegIdx(null)
    setSelectedLaneFile(null)
    setSelectedIntro(false)
    setHistoryDoc({ entries: [], cursor: -1 })
    if (folder) void deleteEDLHistory(folder)

    try {
      await saveJob(folder, runMeta)
    } catch (err) {
      setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ERROR Failed to save job.yaml: ${String(err)}`])
      setRunPhase('error')
      return
    }

    let jobId: string
    try {
      // Worker count is fully system-decided server-side. No override
      // is sent; server.py picks workers from DIVE_FORCE_CPU /
      // DIVE_CUDA_STATUS / DIVE_CUDNN_STATUS + auto_workers.
      jobId = await startRun(folder, undefined)
    } catch (err) {
      setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ERROR Startup failed: ${String(err)}`])
      setRunPhase('error')
      return
    }
    setActiveJobId(jobId)

    const handleEvent = (ev: RunEvent) => {
      if (ev.type === 'log' && ev.msg) {
        setLogs((prev) => [...prev, ev.msg as string])
        // Surface the intro-detect failure as a real dialog so the user
        // can act on it instead of having the pipeline die silently.
        // Two ways the pipeline reaches this state: cover text gives no
        // usable keywords, OR every transcript came back empty (whisper
        // crash / no speech). Both end with the same logger line in
        // dive_edit/main.py.
        if ((ev.msg as string).includes('Cannot auto-detect intro file')) {
          void cancelRun(jobId)
          setDialog({
            title: 'Cannot detect intro automatically',
            body: 'No usable keywords matched any transcript. Either:\n  - Right-click a file -> Set as Intro to mark it manually, or\n  - Edit the Title text so it contains a clear keyword (e.g. JOB NO, VESSEL NAME, TASK).\nThe pipeline has been stopped - click Start again after fixing.',
            confirmLabel: 'OK',
            cancelLabel: '',
            variant: 'danger',
            onConfirm: () => setDialog(null),
          })
          setRunPhase('error')
        }
      } else if (ev.type === 'stage' && ev.stage) {
        const stage = ev.stage
        if (typeof ev.current === 'number' && typeof ev.total === 'number' && ev.total > 0) {
          setLogs((prev) => [...prev, `[ui-progress] ${stage} [${ev.current}/${ev.total}]`])
        }
        setStages((prev) => {
          const existing = prev[stage]
          const status = ev.status ?? 'running'
          const startedAt = status === 'running'
            ? existing.startedAt ?? Date.now()
            : existing.startedAt
          // Append the [N/M] event if this update carries one. Done
          // events without N/M just transition status.
          let events = existing.events ?? []
          if (typeof ev.current === 'number' && typeof ev.total === 'number' && ev.total > 0) {
            events = [...events, { t: Date.now(), current: ev.current, total: ev.total }]
          }
          return {
            ...prev,
            [stage]: {
              stage,
              status,
              current: ev.current,
              total: ev.total,
              startedAt,
              events,
            },
          }
        })
      } else if (ev.type === 'done') {
        setRunPhase('finished')
        // ?pipeline ?= ?EDL,?
        // ?cache,?EDL ?
        // ?timeline?
    setLaneFileCache(new Map())
        void loadEDL(folder).then((newEdl) => {
          if (newEdl) {
            const laneSet = laneFilesForEdl(newEdl)
            setEDL(newEdl)
            setLaneFiles(laneSet)
            setInitialLoad(true)
            const firstIdx = bodySegs(newEdl).length > 0 ? 0 : null
            setSelectedSegIdx((cur) => cur === null ? firstIdx : cur)
            setPreviewSegIdx((cur) => cur === null ? firstIdx : cur)
            // Seed undo history with this baseline so subsequent edits
            // build a chain that can always undo back to the pipeline
            // output. Server already wrote edl.baseline.json + cleared
            // edl.history.json in main.py.
            setHistoryDoc({
              entries: [{ edl: newEdl, laneFiles: Array.from(laneSet), laneFileCache: [] }],
              cursor: 0,
            })
          }
          // Result sanity modal ?fires only on real run completion,
          // not on cache loads. Click OK to dismiss.
          fireResultSanityRef.current(newEdl)
        })
      } else if (ev.type === 'error') {
        setRunPhase('error')
      }
    }

    const closer = connectLogs(jobId, handleEvent, () => {
      setActiveJobId(null)
    })
    wsCloserRef.current = closer
  }, [folder, jobMeta, files, systemInfo])

  const handleForceStop = useCallback(() => {
    setDialog({
      title: 'Stop the current run?',
      body: 'Completed stages are kept, but the running stage will be interrupted.',
      confirmLabel: 'Stop',
      cancelLabel: 'Continue',
      variant: 'danger',
      onConfirm: () => {
        if (activeJobId) void cancelRun(activeJobId)
        setRunPhase('error')
        // Freeze every running stage so the progress bar stops
        // advancing immediately. Without this the timer keeps ticking
        // and the bar appears to "keep running" even though the
        // backend subprocess is being killed.
        setStages((prev) => {
          const next = { ...prev }
          for (const s of ANALYZE_STAGES) {
            if (next[s].status === 'running') {
              next[s] = { ...next[s], status: 'error' }
            }
          }
          return next
        })
        setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] Manually stopped`])
        setDialog(null)
      },
    })
  }, [activeJobId])

  useEffect(() => () => {
    if (wsCloserRef.current) wsCloserRef.current()
  }, [])

  const handleExport = useCallback(async () => {
    if (!folder) return
    if (edl === null) {
      setDialog({
        title: 'Cannot export yet',
        body: 'No EDL is available. Click Start to run the pipeline first, then try Export again.',
        confirmLabel: 'OK',
        cancelLabel: '',
        variant: 'default',
        onConfirm: () => setDialog(null),
      })
      return
    }

    const outputDir = await pickFolder()
    if (!outputDir) return

    if (wsCloserRef.current) {
      wsCloserRef.current()
      wsCloserRef.current = null
    }

    try {
      await Promise.all([saveJob(folder, jobMeta), saveEDL(folder, edl)])
    } catch (err) {
      setDialog({
        title: 'Save failed',
        body: String(err),
        confirmLabel: 'OK',
        cancelLabel: '',
        variant: 'danger',
        onConfirm: () => setDialog(null),
      })
      return
    }

    setExportOutputDir(outputDir)
    setExportProgressOpen(true)
    setRunPhase('running')
    setLogs([])
    setStages(INITIAL_STAGES)

    let jobId: string
    try {
      jobId = await startExport(folder, outputDir)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ERROR Export failed to start: ${msg}`])
      setRunPhase('error')
      setDialog({
        title: 'Export failed to start',
        body: msg,
        confirmLabel: 'OK',
        cancelLabel: '',
        variant: 'danger',
        onConfirm: () => setDialog(null),
      })
      return
    }
    setActiveJobId(jobId)

    const handleEvent = (ev: RunEvent) => {
      if (ev.type === 'log' && ev.msg) {
        setLogs((prev) => [...prev, ev.msg as string])
      } else if (ev.type === 'stage' && ev.stage) {
        const stage = ev.stage
        if (typeof ev.current === 'number' && typeof ev.total === 'number' && ev.total > 0) {
          setLogs((prev) => [...prev, `[ui-progress] ${stage} [${ev.current}/${ev.total}]`])
        }
        setStages((prev) => {
          const existing = prev[stage]
          const status = ev.status ?? 'running'
          const startedAt = status === 'running'
            ? existing.startedAt ?? Date.now()
            : existing.startedAt
          // Append the [N/M] event if this update carries one. Done
          // events without N/M just transition status.
          let events = existing.events ?? []
          if (typeof ev.current === 'number' && typeof ev.total === 'number' && ev.total > 0) {
            events = [...events, { t: Date.now(), current: ev.current, total: ev.total }]
          }
          return {
            ...prev,
            [stage]: {
              stage,
              status,
              current: ev.current,
              total: ev.total,
              startedAt,
              events,
            },
          }
        })
      } else if (ev.type === 'done') {
        setRunPhase('finished')
      } else if (ev.type === 'error') {
        setRunPhase('error')
      }
    }

    const closer = connectLogs(jobId, handleEvent, () => {
      setActiveJobId(null)
    })
    wsCloserRef.current = closer
  }, [folder, edl, jobMeta])

  const handleSegmentsChange = useCallback((segments: Segment[]) => {
    const baseEdl = edl ?? emptyEdl()
    commitEdl({
      ...replaceBody(baseEdl, segments),
      actual_body_duration_sec: segments.reduce((acc, s) => acc + (s.end - s.start), 0),
    })
  }, [edl, commitEdl])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // Shift+A ?toggle "add files to lane" mode (mirror of toolbar
      // FilePlus button). Sorted alphabetically with other shortcuts so
      // the timeline shortcut hint shows it first ("a"-prefix wins).
      if (e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault()
        setAddingFiles((v) => !v)
        return
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      // Intro-level delete: ?EDL ?intro ,?body?
      // ??body ?intro"?ffmpeg_runner ?intro_file
      // ???intro filter pass?
      if (selectedIntro && edl) {
        e.preventDefault()
        commitEdl(replaceIntro(edl, null))
        setSelectedIntro(false)
        return
      }
      // Lane-level delete: drop the lane from the visible set, but KEEP
      // its body_segments in the EDL cache so re-adding the lane via
      // FilePlus restores the windows automatically.
      if (selectedLaneFiles.size > 0 && edl) {
        e.preventDefault()
        for (const file of selectedLaneFiles) removeLaneFile(file)
        selectLaneFile(null)
        return
      }
      const doomed = selectedSegIdxs.size > 0
        ? selectedSegIdxs
        : selectedSegIdx !== null
          ? new Set([selectedSegIdx])
          : new Set<number>()
      if (!edl || doomed.size === 0) return
      e.preventDefault()
      const next = bodySegs(edl).filter((_, i) => !doomed.has(i))
      handleSegmentsChange(next)
      selectSegment(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedSegIdxs, selectedSegIdx, edl, handleSegmentsChange, selectedLaneFiles, removeLaneFile, selectedIntro, commitEdl, selectLaneFile, selectSegment])

  // ?pipeline ?
  //   - folder ?
  //   - ?overlay (eye icon ON):?cover_lines ?small_lines ?
  //     (?
  //   - ?overlay (eye icon OFF): start,backend ?overlay
  //     ??"
  const overlayTextPresent =
    jobMeta.cover_lines.some((l) => l.trim() !== '')
    || jobMeta.small_lines.some((l) => l.trim() !== '')
  const isJobInfoComplete =
    folder !== null && (!overlayVisible || overlayTextPresent)

  // Pre-flight banner removed entirely ?Start button's disabled
  // state (canRun = isJobInfoComplete) already prevents launching with
  // missing folder / title, so the banner just duplicated info.

  // Result sanity (Poka-yoke 3) ?fired as a centered modal exactly
  // once per real pipeline completion. Cache-loaded EDLs do NOT
  // trigger because we hook into the 'done' WS event (see handleEvent
  // below), not into runPhase / edl state changes. The modal closes
  // on OK click, so it behaves as a reminder, not a sticky banner.
  const fireResultSanity = useCallback((newEdl: EDL | null) => {
    if (!newEdl) return
    const lines: string[] = []
    if (bodySegs(newEdl).length === 0) {
      lines.push('- Pipeline produced no body segments - check logs (whisper or intro detection likely failed).')
    } else if ((newEdl.actual_body_duration_sec ?? 0) < 60) {
      lines.push(`- Output is very short (${Math.round(newEdl.actual_body_duration_sec ?? 0)}s) - verify the cut list before exporting.`)
    }
    if (logs.some((l) => l.includes('INTRO soft-fallback selected'))) {
      lines.push('- Intro file was auto-picked with low confidence - right-click a file -> Set as Intro to override if wrong.')
    }
    if (lines.length === 0) return
    const isError = bodySegs(newEdl).length === 0
    setDialog({
      title: isError ? 'Pipeline finished with issues' : 'Pipeline finished - please review',
      body: lines.join('\n'),
      confirmLabel: 'OK',
      cancelLabel: '',
      variant: isError ? 'danger' : 'default',
      onConfirm: () => setDialog(null),
    })
  }, [logs])
  useEffect(() => {
    fireResultSanityRef.current = fireResultSanity
  }, [fireResultSanity])

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'rgb(var(--bg-app))' }}>
      <Header />

      {appZoom !== 1 && (
        <Tooltip content="Home - reset zoom to 100%">
        <button
          type="button"
          onClick={() => { setAppZoom(1); if (canvasOuterRef.current) { canvasOuterRef.current.scrollLeft = 0; canvasOuterRef.current.scrollTop = 0 } }}
          style={{
            position: 'fixed', bottom: 12, right: 12, zIndex: 100,
            background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: 6,
            padding: '3px 10px', fontSize: 11, fontFamily: 'monospace',
            cursor: 'pointer', border: 'none', userSelect: 'none',
          }}
        >
          {Math.round(appZoom * 100)}%
        </button>
        </Tooltip>
      )}
      <main ref={canvasOuterRef} className="flex-1 min-h-0 overflow-auto" style={{ position: 'relative', cursor: isPanning ? 'grabbing' : undefined, scrollbarGutter: 'stable' }}>
        {(() => {
          // zoom >= 1: canvas grows proportionally, content at top-left of extra space
          // zoom < 1: canvas stays at 100% size, content shrinks and centers
          const isZoomIn = appZoom >= 1
          let spacerW: number, spacerH: number, contentTop: number, contentLeft: number

          // Dynamic centering: distribute leftover viewport space equally on
          // both sides so the canvas is always visually centred regardless of
          // 16:9 constraint. WebView2 overlay scrollbars ?gutter = 0 ?
          // main = (innerWidth, innerHeight - HEADER_H). No fixed pad needed.
          const HEADER_H = 42
          const mainW = window.innerWidth
          const mainH = Math.max(0, window.innerHeight - HEADER_H)
          if (isZoomIn) {
            const extra = (appZoom - 1) * 0.5
            const scaledW = canvasBase.w * appZoom
            const scaledH = canvasBase.h * appZoom
            const centerL = Math.max(0, Math.floor((mainW - scaledW) / 2))
            const centerT = Math.max(0, Math.floor((mainH - scaledH) / 2))
            contentLeft = canvasBase.w * extra + centerL
            contentTop  = canvasBase.h * extra + centerT
            spacerW = Math.max(scaledW + centerL * 2, canvasBase.w * appZoom + canvasBase.w * extra * 2)
            spacerH = Math.max(scaledH + centerT * 2, canvasBase.h * appZoom + canvasBase.h * extra * 2)
          } else {
            const scaledW = canvasBase.w * appZoom
            const scaledH = canvasBase.h * appZoom
            const centerL = Math.max(0, Math.floor((mainW - scaledW) / 2))
            const centerT = Math.max(0, Math.floor((mainH - scaledH) / 2))
            contentLeft = centerL
            contentTop  = centerT
            spacerW = scaledW + centerL * 2
            spacerH = scaledH + centerT * 2
          }

          return <>
            <div style={{ width: spacerW, height: spacerH, pointerEvents: 'none' }} />
            <div style={{
              position: 'absolute',
              top: contentTop,
              left: contentLeft,
              width: canvasBase.w,
          height: canvasBase.h,
          transform: `scale(${appZoom})`,
          transformOrigin: '0 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          // 10px on every side ?top/bottom/left/right gap from canvas
          // edge is uniform. Top edge butts against the Header.
          padding: '10px',
        }}>
        {/* Top row */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 10 }}>
          <div style={{
            width: 280, flexShrink: 0, minHeight: 0,
            // INPUT card stays at full opacity / interactive in add mode;
            // a blue glow marks it as the only target the user can act on.
            position: 'relative',
            boxShadow: addingFiles ? '0 0 0 2px rgb(var(--accent-500))' : 'none',
            borderRadius: addingFiles ? 6 : 0,
            transition: 'box-shadow 120ms ease-out',
          }}>
            <JobImportSection
              folder={folder}
              files={files}
              jobMeta={jobMeta}
              onJobMetaChange={setJobMeta}
              onPickFolderByPath={loadFolderContents}
              previewSourcePath={previewSource?.filePath ?? null}
              addingFiles={addingFiles}
              onAddFileToLane={addFileToLane}
            />
          </div>
          <div style={{
            flex: 1, minWidth: 0, minHeight: 0, display: 'flex', gap: 10,
            // Add-mode dim: same blur look as ExportProgressDialog backdrop.
            ...(dimStyle ?? {}),
          }}>
            {/* PreviewBox wrapper. aspectRatio kept at 16/9. The maxWidth
                clamp makes the wrapper narrow enough that ControlPanel
                (INPUT + PIPELINE) gets a comfortable horizontal budget.
                Now anchored to canvasBase.h (locked at first mount, see
                computeBaseline above) instead of vh - vh would change
                whenever the OS window/title-bar reserved a different
                amount of space (fullscreen vs not), which deformed the
                whole top row. */}
            <div style={{
              aspectRatio: '16/9',
              height: '100%',
              maxWidth: `calc((${canvasBase.h * 0.5}px - 70px) * 16 / 9)`,
              flexShrink: 1,
              minWidth: 320,
            }}>
              <PreviewBox
                segment={previewSegment}
                currentIdx={previewSegIdx}
                total={bodySegs(edl).length ?? 0}
                isSourcePreview={previewSource !== null}
                initialPaused={initialLoad}
                pendingSeek={pendingSeek}
                // jassub canvas disabled ?HTML overlay is the sole renderer
                // (it handles cover/small mutual exclusion via showCoverTitle,
                // whereas makeAssAlwaysOn() inside jassub painted both layers
                // simultaneously, producing visible overlap).
                overlayAss={null}
                coverLines={overlayVisible && showCoverTitle ? jobMeta.cover_lines : []}
                smallLines={overlayVisible && !showCoverTitle ? effectiveSmallLines : []}
                coverOverlay={coverOverlay}
                smallOverlay={smallOverlay}
                logoOverlay={overlayVisible ? logoOverlay : undefined}
                onOverlayChange={updateOverlay}
                onLinesChange={(kind, lines) => {
                  if (kind === 'cover') setJobMeta((p) => ({ ...p, cover_lines: lines }))
                  else setJobMeta((p) => ({ ...p, small_lines: lines }))
                }}
                onLogoOverlayChange={updateLogoOverlay}
                selectedOverlay={selectedOverlay}
                onSelectOverlay={setSelectedOverlay}
                onNext={() => {
                  const total = bodySegs(edl).length ?? 0
                  if (total === 0) return
                  const next = previewSegIdx === null ? 0 : Math.min(total - 1, previewSegIdx + 1)
                  setPreviewSource(null)
                  setSelectedIntro(false)
                  setSelectedSegIdx(next)
                  setPreviewSegIdx(next)
                }}
                /* Playhead ?video bidirectional logic:
                   - paused: playhead is user-owned (drag), video does NOT
                     advance the playhead (PreviewBox.onTimeUpdate gates
                     publishing on isPlaying)
                   - playing: video pushes the playhead forward, the user
                     reclaims control by pausing
                   - drag-playhead -> onSeek -> video seeks (setPlayheadSec
                     also called explicitly there to lock the new spot) */
                onPlayheadChange={(v) => {
                  // /?segment ?PreviewBox ?null,?
                  // ???
                  // ??
                  if (v === null) return
                  setPlayheadSec(v)
                }}
                onPlayingChange={setIsPreviewPlaying}
              />
            </div>
            <div className="flex-1 min-h-0" style={{ minWidth: 320 }}>
              <ControlPanel
                jobMeta={jobMeta}
                onJobMetaChange={setJobMeta}
                runPhase={runPhase}
                canRun={isJobInfoComplete}
                edl={edl}
                onRun={handleRun}
                onForceStop={handleForceStop}
                onExport={handleExport}
                selectedOverlay={selectedOverlay}
                onSelectOverlay={setSelectedOverlay}
                overlayVisible={overlayVisible}
                onOverlayToggleVisible={() => setOverlayVisible(!overlayVisible)}
                fontSize={activeOverlay.font_size}
                onFontSizeChange={(v) => selectedOverlay && updateOverlay(selectedOverlay, { font_size: v })}
                lineSpacing={activeOverlay.line_spacing}
                onLineSpacingChange={(v) => selectedOverlay && updateOverlay(selectedOverlay, { line_spacing: v })}
                letterSpacing={activeOverlay.letter_spacing}
                onLetterSpacingChange={(v) => selectedOverlay && updateOverlay(selectedOverlay, { letter_spacing: v })}
                onOverlayReset={() => {
                  // Reset =  DEFAULT_* ??
                  // cachedOverlayDefaults(??
                  // ?,?16:9 ?reset ?
                  // ,?reset?2026-05-13 ?reset
                  // ?+  DEFAULT ?
                  setJobMeta((prev) => ({
                    ...prev,
                    cover_overlay: { ...DEFAULT_COVER_OVERLAY },
                    small_overlay: { ...DEFAULT_SMALL_OVERLAY },
                    logo_overlay: { ...DEFAULT_LOGO_OVERLAY },
                  }))
                  setOverlayVisible(true)
                }}
                effectiveSmallLines={effectiveSmallLines}
                logs={logs}
              />
            </div>
          </div>
        </div>

        {/* Timeline ?full width, equal share with the top row (flex:1
            both = 50/50 height split). Top row's PreviewBox is now
            X-axis-clamped via maxWidth, so the height bargain stays at
            baseline and ControlPanel gets its width back. */}
        <div style={{ flex: 1, minHeight: 0 }}>
          <TimelineSection
            edl={edl}
            folder={folder}
            // Lanes are driven by laneFiles (cache-derived + manual adds),
            // NOT by the import list checkboxes. body_files is purely the
            // pipeline-run scope; toggling a checkbox no longer adds or
            // removes a lane. Run finishing pushes its own EDL files into
            // laneFiles automatically (see useEffect on edl above).
            files={files.filter((f) => laneFiles.has(f.name))}
            selectedIdx={selectedSegIdx}
            selectedIdxs={Array.from(selectedSegIdxs)}
            onSelectIdx={(idx, additive = false) => {
              // ??
              // ,?onPlayheadChange
              // ??
              selectSegment(idx, additive)
              setPreviewSource(null)
              setPreviewSegIdx(idx)
              setSelectedIntro(false)
            }}
            onSegmentsChange={handleSegmentsChange}
            playheadSec={playheadSec}
            onSeek={(idx, offset) => {
              // :??
              // ?lane file,?
              // ??lane ?idx=-1 ?
              if (!edl) return
              if (idx === -1) {
                const introBase = (introOf(edl)?.file ?? "").split(/[\\/]/).pop() ?? (introOf(edl)?.file ?? "")
                const matched = files.find((f) => f.name === introBase)
                const filePath = matched ? matched.path : (introOf(edl)?.file ?? "")
                setPreviewSource({
                  filePath,
                  start: (introOf(edl)?.start ?? 0) + offset,
                  end: (introOf(edl)?.end ?? 0),
                })
                setPreviewSegIdx(null)
                setSelectedSegIdx(null)
                setPlayheadSec((introOf(edl)?.start ?? 0) + offset)
                setPlayheadLaneFile(filePath)
                return
              }
              setPreviewSource(null)
              setPreviewSegIdx(idx)
              setPendingSeek({ offset, nonce: Date.now() })
              const seg = bodySegs(edl)[idx]
              if (seg) {
                setPlayheadSec(seg.start + offset)
                setPlayheadLaneFile(seg.file)
              }
            }}
            zoom={timelineZoom}
            onZoomChange={setTimelineZoom}
            addingFiles={addingFiles}
            onToggleAddFiles={() => setAddingFiles((v) => !v)}
            onRemoveLaneFile={removeLaneFile}
            selectedLaneFile={selectedLaneFile}
            selectedLaneFiles={Array.from(selectedLaneFiles)}
            onSelectLaneFile={(f, additive = false) => { selectLaneFile(f, additive); if (f) setSelectedIntro(false) }}
            isPlaying={isPreviewPlaying}
            playheadLaneFile={playheadLaneFile}
            introMarker={(() => {
              if (!edl || !(introOf(edl)?.file ?? "")) return null
              // ?EDL ?
              // ?lane ??
              const introBase = (introOf(edl)?.file ?? "").split(/[\\/]/).pop() ?? (introOf(edl)?.file ?? "")
              const matched = files.find((f) => f.name === introBase)
              return {
                file: matched ? matched.path : (introOf(edl)?.file ?? ""),
                start: (introOf(edl)?.start ?? 0),
                end: (introOf(edl)?.end ?? 0),
              }
            })()}
            introSelected={selectedIntro}
            onSelectIntro={() => {
              if (!edl || !(introOf(edl)?.file ?? "")) return
              // ,?
              // ???
              // ??
              const introBase = (introOf(edl)?.file ?? "").split(/[\\/]/).pop() ?? (introOf(edl)?.file ?? "")
              const matched = files.find((f) => f.name === introBase)
              const filePath = matched ? matched.path : (introOf(edl)?.file ?? "")
              setPreviewSource({
                filePath,
                start: (introOf(edl)?.start ?? 0),
                end: (introOf(edl)?.end ?? 0),
              })
              setSelectedSegIdx(null)
              setPreviewSegIdx(null)
              setSelectedLaneFile(null)
              setSelectedIntro(true)
            }}
            onDeleteIntro={() => {
              if (!edl) return
              commitEdl(replaceIntro(edl, null))
              setSelectedIntro(false)
            }}
            onIntroResize={(edge, val) => {
              if (!edl) return
              const cur = introOf(edl)
              if (!cur) return
              const updated: Segment = edge === 'start'
                ? { ...cur, start: val }
                : { ...cur, end: val }
              commitEdl(replaceIntro(edl, updated))
            }}
            onIntroMove={(start, end) => {
              if (!edl) return
              const cur = introOf(edl)
              if (!cur) return
              commitEdl(replaceIntro(edl, { ...cur, start, end }))
            }}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
          />
        </div>
        </div>
        </>
        })()}
      </main>

      <ExportProgressDialog
        open={exportProgressOpen}
        outputDir={exportOutputDir}
        runPhase={runPhase}
        stages={stages}
        onCancel={handleForceStop}
        onClose={() => setExportProgressOpen(false)}
      />

      <LogsDrawer
        open={logsOpen}
        logs={logs}
        onClose={() => setLogsOpen(false)}
      />

      <ConfirmDialog
        open={dialog !== null}
        title={dialog?.title}
        body={dialog?.body}
        confirmLabel={dialog?.confirmLabel}
        cancelLabel={dialog?.cancelLabel}
        variant={dialog?.variant}
        onConfirm={() => dialog?.onConfirm()}
        onCancel={closeDialog}
      />
    </div>
  )
}
