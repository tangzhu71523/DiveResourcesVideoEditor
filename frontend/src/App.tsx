import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square, Download, RotateCcw, Type, Rows3, WholeWord, Eye, EyeOff, AlignLeft, AlignCenter, AlignRight } from 'lucide-react'
import Header from './components/Header'
import Stepper from './components/Stepper'
import JobImportSection from './components/sections/JobImportSection'
import { pushRecentFolder } from './components/sections/recentFolders'
import TimelineSection from './components/sections/TimelineSection'
import { ZOOM_MIN, ZOOM_MAX } from './components/timeline/zoom'
import PreviewBox from './components/sections/PreviewBox'
import LogsDrawer from './components/LogsDrawer'
import ConfirmDialog from './components/ui/ConfirmDialog'
import Tooltip from './components/ui/Tooltip'
import type { EDL, JobMeta, OverlayElement, Segment, SourceEDLSegment, VideoFile } from './types/edl'
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
  return { ...edl, segments: [...intro, ...body.filter((s) => s.label !== 'INTRO')] }
}
const replaceIntro = (edl: EDL, intro: Segment | null): EDL => {
  const body = segsOf(edl).filter((s) => s.label !== 'INTRO')
  return { ...edl, segments: intro ? [intro, ...body] : body }
}
const unsetIntroWindow = (edl: EDL): EDL => {
  const all = segsOf(edl)
  const nextSegments = all.map((s) => s.label === 'INTRO'
    ? { ...s, label: 'HULL', protected: false }
    : s)
  const body = nextSegments.filter((s) => s.label !== 'INTRO')
  return {
    ...edl,
    segments: nextSegments,
    actual_body_duration_sec: body.reduce((acc, s) => acc + (s.end - s.start), 0),
  }
}
const deleteIntroWindow = (edl: EDL): EDL => {
  const body = segsOf(edl).filter((s) => s.label !== 'INTRO')
  return {
    ...edl,
    segments: body,
    actual_body_duration_sec: body.reduce((acc, s) => acc + (s.end - s.start), 0),
  }
}
const promoteBodyToIntro = (edl: EDL, bodyIdx: number): EDL => {
  let seenBody = -1
  const segments = segsOf(edl).map((seg) => {
    if (seg.label === 'INTRO') return { ...seg, label: 'HULL', protected: false }
    seenBody += 1
    if (seenBody !== bodyIdx) return seg
    return { ...seg, label: 'INTRO', protected: true }
  })
  const body = segments.filter((s) => s.label !== 'INTRO')
  return {
    ...edl,
    segments,
    actual_body_duration_sec: body.reduce((acc, s) => acc + (s.end - s.start), 0),
  }
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
const segmentSelectionKey = (seg: Segment): string =>
  `${fileBase(seg.file)}|${seg.start.toFixed(3)}|${seg.end.toFixed(3)}`
const laneFilesForEdl = (
  edl: EDL,
  persisted: string[] = [],
  cache: Array<[string, Segment[]]> = [],
): Set<string> => {
  const hidden = new Set(cache.map(([name]) => name))
  const out = new Set(persisted)
  for (const seg of segsOf(edl)) {
    const base = fileBase(seg.file)
    const lane = seg.lane_file ?? base
    if (!hidden.has(lane) && !hidden.has(base)) out.add(lane)
  }
  return out
}
const timelineFilesForEdl = (files: VideoFile[], edl: EDL | null): VideoFile[] => {
  if (!edl) return files
  const order = new Map<string, number>()
  const maxEndByKey = new Map<string, number>()
  for (const seg of bodySegs(edl)) {
    const keys = [seg.lane_file, seg.file, fileBase(seg.file)].filter((key): key is string => !!key)
    for (const key of keys) {
      if (!order.has(key)) order.set(key, order.size)
      maxEndByKey.set(key, Math.max(maxEndByKey.get(key) ?? 0, seg.end))
    }
  }
  const orderedFiles = order.size > 0
    ? [...files].sort((a, b) => {
        const ai = order.get(a.path) ?? order.get(a.name) ?? Number.MAX_SAFE_INTEGER
        const bi = order.get(b.path) ?? order.get(b.name) ?? Number.MAX_SAFE_INTEGER
        if (ai !== bi) return ai - bi
        return files.indexOf(a) - files.indexOf(b)
      })
    : files
  const widenedFiles = orderedFiles.map((file) => {
    const maxEnd = Math.max(
      maxEndByKey.get(file.path) ?? 0,
      maxEndByKey.get(file.name) ?? 0,
      maxEndByKey.get(fileBase(file.path)) ?? 0,
    )
    return maxEnd > file.duration_sec + 0.01
      ? { ...file, duration_sec: maxEnd }
      : file
  })
  const knownKeys = new Set<string>()
  for (const file of widenedFiles) {
    knownKeys.add(file.path)
    knownKeys.add(file.name)
    knownKeys.add(fileBase(file.path))
  }
  const externalMaxEndByFile = new Map<string, number>()
  for (const seg of segsOf(edl)) {
    if (!seg.file) continue
    if (knownKeys.has(seg.file) || knownKeys.has(fileBase(seg.file))) continue
    externalMaxEndByFile.set(seg.file, Math.max(externalMaxEndByFile.get(seg.file) ?? 0, seg.end))
  }
  if (externalMaxEndByFile.size === 0) return widenedFiles
  const external = Array.from(externalMaxEndByFile.entries()).map(([path, maxEnd]) => ({
    name: fileBase(path),
    path,
    duration_sec: Math.max(1, maxEnd),
    size_bytes: 0,
  }))
  return [...widenedFiles, ...external]
}
const applyFileOrder = (files: VideoFile[], orderedNames: string[]): VideoFile[] => {
  const order = new Map<string, number>()
  orderedNames.forEach((name, idx) => {
    if (name !== BODY_NONE_SENTINEL && !order.has(name)) order.set(name, idx)
  })
  if (order.size === 0) return files
  return [...files].sort((a, b) => {
    const ai = order.get(a.name) ?? Number.MAX_SAFE_INTEGER
    const bi = order.get(b.name) ?? Number.MAX_SAFE_INTEGER
    if (ai !== bi) return ai - bi
    return files.indexOf(a) - files.indexOf(b)
  })
}
const applyEdlFileOrder = (files: VideoFile[], edl: EDL): VideoFile[] => {
  const order = new Map<string, number>()
  for (const seg of bodySegs(edl)) {
    const base = fileBase(seg.file)
    if (!order.has(base)) order.set(base, order.size)
  }
  if (order.size === 0) return files
  return [...files].sort((a, b) => {
    const ai = order.get(a.name) ?? Number.MAX_SAFE_INTEGER
    const bi = order.get(b.name) ?? Number.MAX_SAFE_INTEGER
    if (ai !== bi) return ai - bi
    return files.indexOf(a) - files.indexOf(b)
  })
}
const sortSegmentsForTimeline = (segments: Segment[], timelineFiles: VideoFile[]): Segment[] => {
  const order = new Map<string, number>()
  timelineFiles.forEach((f, i) => {
    order.set(f.path, i)
    order.set(fileBase(f.path), i)
  })
  return [...segments].sort((a, b) => {
    const ai = order.get(a.file) ?? order.get(fileBase(a.file)) ?? Number.MAX_SAFE_INTEGER
    const bi = order.get(b.file) ?? order.get(fileBase(b.file)) ?? Number.MAX_SAFE_INTEGER
    if (ai !== bi) return ai - bi
    const fileCmp = fileBase(a.file).localeCompare(fileBase(b.file))
    if (fileCmp !== 0) return fileCmp
    return a.start - b.start
  })
}
const sameSourceFile = (a: string, b: string): boolean =>
  a === b || fileBase(a) === fileBase(b)
const normalizeEdlForTimeline = (edl: EDL, timelineFiles: VideoFile[]): EDL => {
  const orderedBody = sortSegmentsForTimeline(bodySegs(edl), timelineFiles)
  return {
    ...replaceBody(edl, orderedBody),
    actual_body_duration_sec: orderedBody.reduce((acc, s) => acc + (s.end - s.start), 0),
  }
}
const edlSignature = (edl: EDL | null): string =>
  segsOf(edl)
    .map((s) => `${fileBase(s.file)}|${Math.round(s.start * 10)}|${Math.round(s.end * 10)}|${s.label}`)
    .join(';')
const canonicalSourceRangeGroupId = (file: string): string =>
  `range_${fileBase(file).toLowerCase()}`
const buildEdlFromSegments = (segments: Segment[], timelineFiles: VideoFile[]): EDL => {
  const intro = segments.filter((seg) => seg.label === 'INTRO' && seg.end > seg.start)
  const orderedBody = sortSegmentsForTimeline(
    segments.filter((seg) => seg.label !== 'INTRO' && seg.end > seg.start),
    timelineFiles,
  )
  const bodyDuration = orderedBody.reduce((acc, seg) => acc + (seg.end - seg.start), 0)
  return {
    ...emptyEdl(),
    segments: [...intro, ...orderedBody],
    actual_body_duration_sec: bodyDuration,
    raw_body_duration_sec: bodyDuration,
  }
}
const buildWholeManualEdl = (files: VideoFile[]): EDL =>
  buildEdlFromSegments(
    files
      .filter((file) => file.duration_sec > 0)
      .map((file) => ({
        file: file.path,
        start: 0,
        end: file.duration_sec,
        label: 'HULL',
        score: 1,
        protected: false,
      })),
    files,
  )
const initialPipelineZoom = (edl: EDL, files: VideoFile[]): number => {
  const body = bodySegs(edl).filter((seg) => seg.end > seg.start)
  if (body.length === 0) return 1
  const fileByRef = new Map<string, VideoFile>()
  for (const file of files) {
    fileByRef.set(file.path, file)
    fileByRef.set(file.name, file)
    fileByRef.set(fileBase(file.path), file)
  }
  const laneSet = laneFilesForEdl(edl)
  let total = 0
  for (const lane of laneSet) {
    const file = fileByRef.get(lane) ?? fileByRef.get(fileBase(lane))
    if (file) total += Math.max(0, file.duration_sec)
  }
  if (total <= 0) {
    const maxEnd = body.reduce((acc, seg) => Math.max(acc, seg.end), 0)
    total = Math.max(maxEnd, body.reduce((acc, seg) => acc + (seg.end - seg.start), 0))
  }
  const firstWindow = body[0]
  const firstDuration = Math.max(1, firstWindow.end - firstWindow.start)
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, total / (firstDuration * 4)))
}
const buildManualEdlFromSourceRanges = (files: VideoFile[], ranges: SourceEDLSegment[]): EDL | null => {
  const segments: Segment[] = []
  for (const range of ranges) {
    if (range.enabled === false || range.end <= range.start) continue
    const file = files.find((item) => sameSourceFile(range.file, item.path) || sameSourceFile(range.file, item.name))
    if (!file) continue
    segments.push({
      file: file.path,
      start: Math.max(0, Math.min(file.duration_sec, range.start)),
      end: Math.max(0, Math.min(file.duration_sec, range.end)),
      label: range.label === 'INTRO' ? 'INTRO' : 'HULL',
      score: 1,
      protected: range.label === 'INTRO',
    })
  }
  return segments.length > 0 ? buildEdlFromSegments(segments, files) : null
}
const sourceRangesFromEdl = (edl: EDL | null): SourceEDLSegment[] =>
  segsOf(edl)
    .filter((seg) => seg.end > seg.start)
    .map((seg) => ({
      file: fileBase(seg.file),
      start: seg.start,
      end: seg.end,
      label: seg.label === 'INTRO' ? 'INTRO' : 'SOURCE',
      enabled: true,
      group_id: canonicalSourceRangeGroupId(seg.file),
    }))
const buildRawFileEdl = (file: VideoFile, manual: EDL | null, files: VideoFile[]): EDL => {
  const manualSegments = segsOf(manual)
    .filter((seg) => sameSourceFile(seg.file, file.path) || sameSourceFile(seg.file, file.name))
  if (manualSegments.length > 0) return buildEdlFromSegments(manualSegments, files)
  return buildEdlFromSegments([{
    file: file.path,
    start: 0,
    end: Math.max(0, file.duration_sec),
    label: 'HULL',
    score: 1,
    protected: false,
  }], files)
}
const mergeRawFileEdlIntoManual = (
  manual: EDL | null,
  rawEdl: EDL,
  file: VideoFile,
  files: VideoFile[],
): EDL => {
  const kept = segsOf(manual).filter((seg) =>
    !(sameSourceFile(seg.file, file.path) || sameSourceFile(seg.file, file.name)),
  )
  const updated = segsOf(rawEdl).filter((seg) =>
    (sameSourceFile(seg.file, file.path) || sameSourceFile(seg.file, file.name))
    && seg.end > seg.start,
  )
  return buildEdlFromSegments([...kept, ...updated], files)
}
const laneKeyForSegment = (seg: Segment): string => seg.lane_file ?? seg.file
const reorderEdlLanes = (edl: EDL, fromFile: string, toFile: string, placement: 'before' | 'after'): EDL => {
  const grouped = new Map<string, Segment[]>()
  const order: string[] = []
  for (const seg of bodySegs(edl)) {
    const key = laneKeyForSegment(seg)
    if (!grouped.has(key)) {
      grouped.set(key, [])
      order.push(key)
    }
    grouped.get(key)!.push(seg)
  }
  const fromKey = order.find((key) => sameSourceFile(key, fromFile) || sameSourceFile(fileBase(key), fileBase(fromFile)))
  const toKey = order.find((key) => sameSourceFile(key, toFile) || sameSourceFile(fileBase(key), fileBase(toFile)))
  if (!fromKey || !toKey || fromKey === toKey) return edl
  const nextOrder = order.filter((key) => key !== fromKey)
  const toIdx = nextOrder.indexOf(toKey)
  if (toIdx < 0) return edl
  nextOrder.splice(placement === 'after' ? toIdx + 1 : toIdx, 0, fromKey)
  const body = nextOrder.flatMap((key) =>
    [...(grouped.get(key) ?? [])].sort((a, b) => a.start - b.start),
  )
  return {
    ...replaceBody(edl, body),
    actual_body_duration_sec: body.reduce((acc, seg) => acc + (seg.end - seg.start), 0),
  }
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
  loadSourceEDL, saveSourceEDL, deleteSourceEDL,
  JobSaveConflictError, type RunEvent, type SystemInfo,
} from './lib/api'
import { lockTextSelect, unlockTextSelect } from './lib/dragLock'
import { translateAll } from './lib/userLogTranslator'

type RunPhase = 'idle' | 'running' | 'finished' | 'error'

const BODY_NONE_SENTINEL = '__DIVE_BODY_NONE__'
const MANUAL_CACHE_TOKEN = '__DIVE_MANUAL_CACHE__'
const PIPELINE_BASELINE_FILE = '__DIVE_PIPELINE_BASELINE__'
const PIPELINE_OUTPUT_TOKEN_PREFIX = '__DIVE_PIPELINE_OUTPUT__'

type TimelineMode =
  | { kind: 'empty' }
  | { kind: 'raw'; fileName: string }
  | { kind: 'manual' }
  | { kind: 'pipeline'; token: string }

interface PipelineOutputRecord {
  id: string
  token: string
  edl: EDL
  createdAt: number
}
interface PipelineOutputWindow extends SourceEDLSegment {
  exportedStart: number
  exportedEnd: number
}

const EMPTY_JOB: JobMeta = {
  job_no: '',
  vessel: '',
  intro_file: '',
  body_files: [],
  cover_lines: [],
  small_lines: [],
  target_duration_min: 0,
  intro_speech_override: null,
  filter_enabled: false,
  job_rev: null,
}

const MAX_HISTORY = 50

// User-facing pseudo-terminal that lives between the logo and the
// Export button. Raw log lines are filtered + translated via
// userLogTranslator: key progress lines are shown in readable form while
// noisy debug lines stay in run.log on disk. Matching lines render colourised
// tokens via the .tok-* CSS classes. Auto-scrolls to bottom on new content.
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
  align: 'left' | 'center' | 'right'
  onAlignChange: (v: 'left' | 'center' | 'right') => void
  // Same derived watermark lines that PreviewBox renders. Used as the
  // textbox fallback so what user sees in the input matches the overlay.
  effectiveSmallLines: string[]
  // Live log buffer driving the inline pseudo-terminal in the pipeline
  // panel. Replaces the old "Xs ago" activity readout; user wanted
  // a richer feed in that slot, see PipelineLogTerminal below.
  logs: string[]
  inputPanelWidth: number
  pipelinePanelWidth: number
}

function ControlPanel({
  jobMeta, onJobMetaChange, runPhase, canRun, edl, onRun, onForceStop, onExport,
  onOverlayReset,
  selectedOverlay, onSelectOverlay,
  overlayVisible, onOverlayToggleVisible,
  fontSize, onFontSizeChange,
  lineSpacing, onLineSpacingChange,
  letterSpacing, onLetterSpacingChange,
  align, onAlignChange,
  effectiveSmallLines,
  logs,
  inputPanelWidth,
  pipelinePanelWidth,
}: ControlPanelProps) {
  const canExport = edl !== null && bodySegs(edl).length > 0 && runPhase !== 'running'

  // Two side-by-side panels: INPUT (cover/small text) + PIPELINE
  // (Start, analysis stages, Export, render progress). Target field
  // was removed because backend defaults handle target duration.
  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        gridTemplateColumns: `${inputPanelWidth}px ${pipelinePanelWidth}px`,
        gap: 10,
        minHeight: 0,
        minWidth: inputPanelWidth + pipelinePanelWidth + 10,
      }}
    >
      {/*  INPUT  */}
      <div className="card-panel" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '12px 14px' }}>
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

        {/* Overlay parameter panel: 3 horizontal stepper rows on a
            single line. Each stepper = [icon box] [- value +]. Icons
            replace text labels for compactness. Reset is in header.
            Target selection: click a textarea below. */}
        <div data-overlay-controls style={{
          flexShrink: 0, marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          // space-evenly: 4 gaps (edge|S1|S2|S3|edge) all equal, scales
          // with panel width; 3 steppers stay rigid-content-sized but
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
          <div
            data-overlay-controls
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 28,
              border: '1px solid rgb(var(--border-subtle))',
              borderRadius: 6,
              overflow: 'hidden',
              background: 'rgb(var(--bg-raised) / 0.72)',
            }}
          >
            {([
              ['left', <AlignLeft size={13} />],
              ['center', <AlignCenter size={13} />],
              ['right', <AlignRight size={13} />],
            ] as const).map(([value, icon]) => (
              <Tooltip key={value} content={`Align ${value}`}>
                <button
                  type="button"
                  className={align === value ? 'btn icon sm primary' : 'btn icon sm'}
                  onClick={() => onAlignChange(value)}
                  disabled={!selectedOverlay}
                  aria-label={`align ${value}`}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 0,
                    border: 'none',
                    boxShadow: 'none',
                  }}
                >
                  {icon}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>

        {/* Title + Watermark textareas back to equal flex split.
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
                // Re-implements the deleted "Jump to Cover" target icon:
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
              value={(jobMeta.small_lines.length > 0 ? jobMeta.small_lines : effectiveSmallLines).join('\n')}
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
          the panel bottom edge (was 20px, +2px tweak per spec). */}
      <div className="card-panel" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0, padding: '12px 14px 22px' }}>
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

        {/* Pre-flight banner removed; Start button disabled state
            covers it. LogoWaveProgress also removed per fallback -
            the blank area between PIPELINE header and Export is now
            occupied entirely by the pseudo-terminal. */}
        <PipelineLogTerminal logs={logs} runPhase={runPhase} />

        {/* Export button pushed to bottom by `marginTop: auto`. The
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
  const edlReviewMode = useMemo(
    () => new URLSearchParams(window.location.search).get('edlReview') === '1',
    [],
  )
  const [folder, setFolder] = useState<string | null>(null)
  const [files, setFiles] = useState<VideoFile[]>([])
  const [sourceRanges, setSourceRanges] = useState<SourceEDLSegment[]>([])
  const [manualEdl, setManualEdl] = useState<EDL | null>(null)
  const [pipelineBaselineEdl, setPipelineBaselineEdl] = useState<EDL | null>(null)
  const [pipelineOutputRecords, setPipelineOutputRecords] = useState<PipelineOutputRecord[]>([])
  const [jobMeta, setJobMeta] = useState<JobMeta>(EMPTY_JOB)
  const [edl, setEDL] = useState<EDL | null>(null)
  const [timelineMode, setTimelineMode] = useState<TimelineMode>({ kind: 'empty' })
  const timelineModeRef = useRef<TimelineMode>({ kind: 'empty' })
  const setTimelineModeSafe = useCallback((next: TimelineMode) => {
    timelineModeRef.current = next
    setTimelineMode(next)
  }, [])
  const edlRefMirror = useRef<EDL | null>(null)
  edlRefMirror.current = edl
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
  const [logsOpen, setLogsOpen] = useState(false)
  const [, forceRerender] = useState(0)

  // Themed dialog state replaces window.confirm / window.alert.
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

  // System info (GPU detection): fetch on mount + on window focus.
  // Re-fetching on focus picks up backend restarts (e.g. user edited
  // gpu.py and restarted) without requiring a hard browser refresh.
  // Worker count is no longer user-tunable; backend uses DIVE_FORCE_CPU /
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
  // Intro selection is separate from body segment and lane selection.
  // Deleting an intro edits the EDL intro marker without treating body
  // windows as selected.
  const [selectedIntro, setSelectedIntro] = useState(false)
  // Preview segment is decoupled from selection: clicking a timeline window
  // only highlights it (selectedSegIdx); the preview / playhead stays put.
  // Other paths (drag-to-seek, prev/next, edl load, delete) explicitly sync
  // both via the helper below; only the timeline-click path skips the sync.
  const [previewSegIdx, setPreviewSegIdx] = useState<number | null>(null)
  // Shared playhead state used by timeline seek, PreviewBox seek, and
  // keyboard navigation.
  const [playheadSec, setPlayheadSec] = useState<number>(0)
  const [pendingSeek, setPendingSeek] = useState<{ offset: number; nonce: number } | null>(null)
  // "Add files to lane" mode, toggled by the FilePlus button in the
  // timeline toolbar. While true, every region except the INPUT card and
  // the FilePlus button is dimmed/blocked. Click on a file row in INPUT
  // (or shift-click for range) adds it to laneFiles. Click on the dim
  // overlay does nothing; exit only via the FilePlus button.
  const [addingFiles, setAddingFiles] = useState(false)
  // Reused for every region we want to obscure while in add-files mode.
  // Mirrors the old export backdrop look (blur 4px + slight tint).
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
  const [importSelectedFiles, setImportSelectedFiles] = useState<string[]>([])
  const updateImportSelectedFiles = useCallback((next: string[]) => {
    setImportSelectedFiles((prev) => {
      if (prev.length === next.length && prev.every((item, idx) => item === next[idx])) return prev
      return next
    })
  }, [])
  // Timeline lane cache stores windows for hidden lanes so re-adding a
  // file can restore the same windows without regenerating the EDL.
  const [laneFileCache, setLaneFileCache] = useState<Map<string, Segment[]>>(() => new Map())
  // Mirror state into refs so commitEdl can snapshot them synchronously
  // without waiting for React to flush. Updated AFTER the state change
  // commits, which matches what we want: snapshot reflects the state at
  // the time commitEdl runs (which is the state visible to the next render).
  const laneFilesRefMirror = useRef(laneFiles)
  laneFilesRefMirror.current = laneFiles
  const laneFileCacheRefMirror = useRef(laneFileCache)
  laneFileCacheRefMirror.current = laneFileCache
  const manualEdlRefMirror = useRef(manualEdl)
  manualEdlRefMirror.current = manualEdl
  const thumbnailQueuedRef = useRef<Set<string>>(new Set())
  const timelineFiles = useMemo(() => timelineFilesForEdl(files, edl), [files, edl])
  const timelineLaneFiles = timelineFiles
  const pipelineOutputSignatures = useMemo(() => {
    const signatures = new Set<string>()
    if (pipelineBaselineEdl && edlHasTimeline(pipelineBaselineEdl)) {
      signatures.add(edlSignature(pipelineBaselineEdl))
    }
    for (const record of pipelineOutputRecords) {
      if (edlHasTimeline(record.edl)) signatures.add(edlSignature(record.edl))
    }
    return signatures
  }, [pipelineBaselineEdl, pipelineOutputRecords])
  const currentEdlIsPipelineOutput = !!edl
    && pipelineOutputSignatures.size > 0
    && pipelineOutputSignatures.has(edlSignature(edl))
  const importSourceWindows = useMemo<SourceEDLSegment[]>(() => {
    const toSourceWindow = (f: VideoFile, seg: Segment): SourceEDLSegment => ({
      file: f.name,
      start: Math.max(0, Math.min(f.duration_sec, seg.start)),
      end: Math.max(0, Math.min(f.duration_sec, seg.end)),
      label: seg.label === 'INTRO' ? 'INTRO' : 'SOURCE',
      enabled: true,
      group_id: canonicalSourceRangeGroupId(f.name),
    })
    const dedupe = (items: SourceEDLSegment[]) => {
      const seen = new Set<string>()
      return items
        .filter((item) => item.enabled !== false && item.end > item.start)
        .sort((a, b) => a.start - b.start || a.end - b.end)
        .filter((item) => {
          const key = `${item.start.toFixed(3)}|${item.end.toFixed(3)}|${item.label ?? 'SOURCE'}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
    }
    const timelineWindows = segsOf(edl)
    const out: SourceEDLSegment[] = []
    for (const f of files) {
      const fromManual = dedupe(
        segsOf(manualEdl)
          .filter((seg) => sameSourceFile(seg.file, f.path) || sameSourceFile(seg.file, f.name))
          .map((seg) => toSourceWindow(f, seg)),
      )
      const fromEdl = dedupe(
        (currentEdlIsPipelineOutput ? [] : timelineWindows)
          .filter((seg) => sameSourceFile(seg.file, f.path) || sameSourceFile(seg.file, f.name))
          .map((seg) => toSourceWindow(f, seg)),
      )
      const cached = dedupe(
        [
          ...(laneFileCache.get(f.name) ?? []),
          ...(laneFileCache.get(f.path) ?? []),
        ].map((seg) => toSourceWindow(f, seg)),
      )
      const persisted = dedupe(
        sourceRanges
          .filter((range) =>
            range.enabled !== false
            && range.end > range.start
            && (sameSourceFile(range.file, f.path) || sameSourceFile(range.file, f.name)),
          )
          .map((range) => ({
            ...range,
            file: f.name,
            start: Math.max(0, Math.min(f.duration_sec, range.start)),
            end: Math.max(0, Math.min(f.duration_sec, range.end)),
            label: range.label === 'INTRO' ? 'INTRO' : 'SOURCE',
            enabled: true,
            group_id: canonicalSourceRangeGroupId(f.name),
          })),
      )
      const chosen = fromManual.length > 0
        ? fromManual
        : persisted.length > 0
          ? persisted
          : fromEdl.length > 0
          ? fromEdl
          : cached.length > 0
          ? cached
          : [{
                file: f.name,
                start: 0,
                end: Math.max(0, f.duration_sec),
                label: 'SOURCE',
                enabled: true,
                group_id: canonicalSourceRangeGroupId(f.name),
              }]
      out.push(...chosen)
    }
    return out
  }, [files, edl, laneFileCache, sourceRanges, currentEdlIsPipelineOutput, manualEdl])
  const pipelineOutputByToken = useMemo(() => {
    const map = new Map<string, PipelineOutputRecord>()
    for (const record of pipelineOutputRecords) map.set(record.token, record)
    return map
  }, [pipelineOutputRecords])
  const manualOutput = useMemo(() => {
    if (!manualEdl || !edlHasTimeline(manualEdl)) return null
    let cursor = 0
    const windows = segsOf(manualEdl)
      .filter((seg) => seg.end > seg.start)
      .map((seg): PipelineOutputWindow => {
        const duration = seg.end - seg.start
        const item = {
          file: seg.lane_file ?? seg.file,
          start: seg.start,
          end: seg.end,
          label: seg.label,
          enabled: true,
          group_id: MANUAL_CACHE_TOKEN,
          exportedStart: cursor,
          exportedEnd: cursor + duration,
        }
        cursor += duration
        return item
      })
    return windows.length > 0
      ? {
          token: MANUAL_CACHE_TOKEN,
          name: 'manual',
          durationSec: cursor,
          windows,
        }
      : null
  }, [manualEdl])
  const pipelineOutputs = useMemo(() => pipelineOutputRecords
    .filter((record) => edlHasTimeline(record.edl))
    .map((record, idx) => {
      let cursor = 0
      const windows = segsOf(record.edl)
        .filter((seg) => seg.end > seg.start)
        .map((seg): PipelineOutputWindow => {
          const duration = seg.end - seg.start
          const item = {
            file: seg.lane_file ?? seg.file,
            start: seg.start,
            end: seg.end,
            label: seg.label,
            enabled: true,
            group_id: record.token,
            exportedStart: cursor,
            exportedEnd: cursor + duration,
          }
          cursor += duration
          return item
        })
      return {
        token: record.token,
        name: `pipeline ${idx + 1}`,
        durationSec: cursor,
        windows,
      }
    })
    .filter((item) => item.windows.length > 0), [pipelineOutputRecords])
  const reorderImportFiles = useCallback((fromName: string, toName: string, placement: 'before' | 'after' = 'before') => {
    setFiles((prev) => {
      const fromIdx = prev.findIndex((f) => f.name === fromName)
      const toIdx = prev.findIndex((f) => f.name === toName)
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIdx, 1)
      const targetIdx = next.findIndex((f) => f.name === toName)
      if (targetIdx < 0) return prev
      next.splice(placement === 'after' ? targetIdx + 1 : targetIdx, 0, moved)
      setJobMeta((meta) => {
        if (meta.body_files.includes(BODY_NONE_SENTINEL)) return meta
        const selected = meta.body_files.length === 0
          ? new Set(next.map((f) => f.name))
          : new Set(meta.body_files)
        return {
          ...meta,
          body_files: next.map((f) => f.name).filter((name) => selected.has(name)),
        }
      })
      return next
    })
  }, [])
  // Forward-ref so addFileToLane / removeLaneFile (declared above commitEdl)
  // can still invoke it. Updated below once commitEdl is constructed.
  const commitEdlRef = useRef<(next: EDL) => void>(() => {})
  const [timelineZoom, setTimelineZoomRaw] = useState(1.0)
  const setTimelineZoom = useCallback((z: number) => {
    setTimelineZoomRaw(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parseFloat(z.toFixed(2)))))
  }, [])
  const focusBodySegment = useCallback((nextEdl: EDL, requestedIdx = 0) => {
    const body = bodySegs(nextEdl)
    if (body.length === 0) {
      setSelectedSegIdx(null)
      setSelectedSegIdxs(new Set())
      setPreviewSegIdx(null)
      setPreviewSource(null)
      setPlayheadSec(0)
      setPlayheadLaneFile(null)
      return
    }
    const idx = Math.max(0, Math.min(body.length - 1, requestedIdx))
    const seg = body[idx]
    setSelectedSegIdx(idx)
    setSelectedSegIdxs(new Set())
    setSelectedIntro(false)
    setPreviewSource(null)
    setPreviewSegIdx(idx)
    setPendingSeek({ offset: 0, nonce: Date.now() })
    setPlayheadSec(seg.start)
    setPlayheadLaneFile(seg.lane_file ?? seg.file)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('dive.scrollToSourceWindow', {
        detail: {
          pipelineWindowIndex: idx,
          file: seg.lane_file ?? seg.file,
          start: seg.start,
          end: seg.end,
        },
      }))
    }, 80)
  }, [])
  const loadCacheToTimeline = useCallback((token: string) => {
    const outputEdl = token === MANUAL_CACHE_TOKEN
      ? manualEdlRefMirror.current
      : pipelineOutputByToken.get(token)?.edl
        ?? (token === PIPELINE_BASELINE_FILE ? pipelineBaselineEdl : null)
    if (!outputEdl || !edlHasTimeline(outputEdl)) return
    const laneSet = laneFilesForEdl(outputEdl)
    laneFilesRefMirror.current = laneSet
    laneFileCacheRefMirror.current = new Map()
    const nextMode: TimelineMode = token === MANUAL_CACHE_TOKEN
      ? { kind: 'manual' }
      : { kind: 'pipeline', token }
    setTimelineModeSafe(nextMode)
    edlRefMirror.current = outputEdl
    setEDL(outputEdl)
    setLaneFiles(laneSet)
    setLaneFileCache(new Map())
    if (token !== MANUAL_CACHE_TOKEN) setTimelineZoom(initialPipelineZoom(outputEdl, files))
    setSelectedLaneFile(null)
    setSelectedLaneFiles(new Set())
    focusBodySegment(outputEdl)
    setHistoryDoc({
      entries: [{ edl: outputEdl, laneFiles: Array.from(laneSet), laneFileCache: [] }],
      cursor: 0,
    })
  }, [files, pipelineBaselineEdl, pipelineOutputByToken, setTimelineModeSafe, focusBodySegment, setTimelineZoom])
  const openRawFileInTimeline = useCallback((fileName: string) => {
    const file = files.find((item) => item.name === fileName)
    if (!file) return
    const rawEdl = buildRawFileEdl(file, manualEdlRefMirror.current, files)
    const laneSet = laneFilesForEdl(rawEdl, [file.name])
    setTimelineModeSafe({ kind: 'raw', fileName })
    edlRefMirror.current = rawEdl
    setEDL(rawEdl)
    setLaneFiles(laneSet)
    setLaneFileCache(new Map())
    setSelectedLaneFile(null)
    setSelectedLaneFiles(new Set())
    const firstIdx = bodySegs(rawEdl).length > 0 ? 0 : null
    setSelectedSegIdx(firstIdx)
    setSelectedSegIdxs(firstIdx === null ? new Set() : new Set([firstIdx]))
    setSelectedIntro(false)
    setPreviewSegIdx(firstIdx)
    setPreviewSource(null)
    setPendingSeek({ offset: 0, nonce: Date.now() })
    setPlayheadSec(0)
    setPlayheadLaneFile(file.path)
    setHistoryDoc({
      entries: [{ edl: rawEdl, laneFiles: Array.from(laneSet), laneFileCache: [] }],
      cursor: 0,
    })
  }, [files, setTimelineModeSafe])
  // addFileToLane rebuilds the visible EDL from cached windows, source
  // windows, or a full-duration fallback.
  const addFileToLane = useCallback((fileName: string) => {
    if (fileName === MANUAL_CACHE_TOKEN || fileName === PIPELINE_BASELINE_FILE || fileName.startsWith(PIPELINE_OUTPUT_TOKEN_PREFIX)) {
      loadCacheToTimeline(fileName)
      return
    }
    const matchedFile = files.find((f) => f.name === fileName)
    const fileExists = !!matchedFile
    const cached = laneFileCache.get(fileName)
    if (!fileExists && !cached) return
    const sourceWindows = matchedFile
      ? importSourceWindows
        .filter((range) =>
          range.enabled !== false
          && range.end > range.start
          && (sameSourceFile(range.file, matchedFile.path) || sameSourceFile(range.file, matchedFile.name)),
        )
        .sort((a, b) => a.start - b.start)
      : []
    let nextEdl: EDL | null = edl
    let nextCache = laneFileCache
    if (cached && cached.length > 0) {
      // Restore cached windows into the current EDL.
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
    } else if (matchedFile && sourceWindows.length > 0) {
      const baseEdl = edl ?? emptyEdl()
      const bodyWithoutFile = bodySegs(baseEdl).filter((seg) =>
        !(sameSourceFile(seg.file, matchedFile.path) || sameSourceFile(seg.file, matchedFile.name)),
      )
      const additions: Segment[] = sourceWindows.map((range) => ({
        file: matchedFile.path,
        start: Math.max(0, range.start),
        end: Math.min(matchedFile.duration_sec, range.end),
        label: range.label === 'INTRO' ? 'INTRO' : 'HULL',
        score: 1,
        protected: range.label === 'INTRO',
      })).filter((seg) => seg.end > seg.start)
      const nextBody = sortSegmentsForTimeline([...bodyWithoutFile, ...additions], timelineFiles)
      nextEdl = {
        ...replaceBody(baseEdl, nextBody),
        actual_body_duration_sec: nextBody.reduce((acc, seg) => acc + (seg.end - seg.start), 0),
      }
    } else if (matchedFile && matchedFile.duration_sec > 0) {
      const baseEdl = edl ?? emptyEdl()
      const body = bodySegs(baseEdl)
      const alreadyHasWindow = body.some((seg) =>
        !seg.lane_file
        && seg.start <= 0.01
        && Math.abs(seg.end - matchedFile.duration_sec) < 0.01
        && (seg.file === matchedFile.path || fileBase(seg.file) === matchedFile.name),
      )
      if (!alreadyHasWindow) {
        const fullCover: Segment = {
          file: matchedFile.path,
          start: 0,
          end: matchedFile.duration_sec,
          label: 'HULL',
          score: 1,
          protected: false,
        }
        const nextBody = sortSegmentsForTimeline([...body, fullCover], timelineFiles)
        nextEdl = {
          ...replaceBody(baseEdl, nextBody),
          actual_body_duration_sec: nextBody.reduce((acc, seg) => acc + (seg.end - seg.start), 0),
        }
      }
    }
    const nextLf = new Set(laneFiles)
    nextLf.add(fileName)
    // Keep refs in sync with state before committing EDL.
    laneFilesRefMirror.current = nextLf
    laneFileCacheRefMirror.current = nextCache
    setLaneFiles(nextLf)
    if (nextCache !== laneFileCache) setLaneFileCache(nextCache)
    if (nextEdl) {
      const mustRegisterManual =
        nextEdl !== edl
        || timelineModeRef.current.kind !== 'manual'
        || !manualEdlRefMirror.current
        || !edlHasTimeline(manualEdlRefMirror.current)
      if (mustRegisterManual) {
        setTimelineModeSafe({ kind: 'manual' })
        commitEdlRef.current(nextEdl)
      }
    }
  }, [edl, files, laneFiles, laneFileCache, timelineFiles, importSourceWindows, loadCacheToTimeline, setTimelineModeSafe])
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
  // Track which lane owns the current playhead.
  const [playheadLaneFile, setPlayheadLaneFile] = useState<string | null>(null)
  useEffect(() => {
    if (!isPreviewPlaying) return
    if (previewSegIdx === null || !edl) return
    const seg = bodySegs(edl)[previewSegIdx]
    const file = seg ? (seg.lane_file ?? seg.file) : null
    setPlayheadLaneFile((prev) => (prev === file ? prev : file))
  }, [isPreviewPlaying, previewSegIdx, edl])
  // removeLaneFile hides a lane while caching its windows for undo-style
  // restoration through addFileToLane.
  const removeLaneFile = useCallback((filePath: string) => {
    const base = filePath.split(/[\\/]/).pop() ?? filePath
    const isRangeLane = filePath.startsWith('SOURCE_RANGE::')
    const curEdl = edl
    if (!curEdl) {
      // No EDL yet: only update the visible lane set.
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
    const matchSegment = (seg: Segment) =>
      isRangeLane ? seg.lane_file === filePath : !seg.lane_file && matchFile(seg.file)
    const toCache = bodySegs(curEdl).filter(matchSegment)
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
      bodySegs(curEdl).filter((s) => !matchSegment(s)),
    )
    // Keep refs in sync before commitEdl builds the history snapshot.
    laneFilesRefMirror.current = nextLf
    laneFileCacheRefMirror.current = nextCache
    setLaneFiles(nextLf)
    setLaneFileCache(nextCache)
    commitEdlRef.current(nextEdl)
  }, [edl, laneFiles, laneFileCache])
  // Auto-add files referenced by the current EDL into laneFiles. Runs
  // when EDL changes (load/run-finish/edit); additive only, so a manual
  // entry stays in the lane even after the user deletes its windows.
  // Start thumbnail extraction as soon as the import list is available.
  // Timeline lanes and source ranges reuse this cache instead of triggering
  // extraction only after the user drags media into the timeline.
  useEffect(() => {
    if (!folder) return
    const queued = thumbnailQueuedRef.current
    const importPaths = [...new Set(files.map((f) => f.path))]
      .filter((path) => !queued.has(path))
    if (importPaths.length === 0) return
    for (const path of importPaths) queued.add(path)
    void startThumbnails(folder, importPaths)
  }, [folder, files])
  useEffect(() => {
    if (!edl) return
    const filesInEdl = new Set<string>()
    for (const seg of bodySegs(edl)) {
      const base = seg.file.split(/[\\/]/).pop() ?? seg.file
      filesInEdl.add(base)
    }
    // Include body and intro source files from the current EDL.
    if ((introOf(edl)?.file ?? "")) {
      const base = (introOf(edl)?.file ?? "").split(/[\\/]/).pop() ?? (introOf(edl)?.file ?? "")
      filesInEdl.add(base)
    }
    if (filesInEdl.size === 0) return
    setLaneFiles((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const n of filesInEdl) {
        // Do not auto-add lanes hidden into laneFileCache; addFileToLane
        // is responsible for restoring those windows.
        if (laneFileCache.has(n)) continue
        if (!next.has(n)) { next.add(n); changed = true }
      }
      return changed ? next : prev
    })
  }, [edl, laneFileCache])
  // Backend ASS state removed; overlay is now computed client-side
  // (see previewOverlayAss useMemo below) so cover/watermark text edits
  // stay in sync with the intro window in real time. Backend still writes
  // its own _overlay.ass at render time for the ffmpeg bake, but the
  // preview never reads it.
  // overlayVisible mirrors jobMeta.overlay_enabled and controls title,
  // watermark, and logo preview/export visibility.
  const overlayVisible = jobMeta.overlay_enabled !== false
  const setOverlayVisible = useCallback((v: boolean) => {
    setJobMeta((p) => ({ ...p, overlay_enabled: v }))
  }, [])
  // Which overlay block (Cover title or Watermark) the toolbar steppers
  // act on. PreviewBox arms via double-click which also flips this.
  // null = no selection; both overlays hide outlines/handles. User
  // selects by clicking the matching textarea in INPUT, or directly on
  // an overlay element in the preview. Clicking anywhere outside both
  // textareas + overlay handles + parameter steppers clears it back to
  // null (handled by the document mousedown listener below).
  const [selectedOverlay, setSelectedOverlay] = useState<'cover' | 'small' | null>(null)
  // Cache overlay defaults so a newly loaded job keeps the user's last
  // placement until this job provides explicit overlay settings.
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
    // Avoid depending on cachedOverlayDefaults here; this effect writes it.
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
  // Click Title / Watermark textarea to move the playhead to that overlay's
  // start. Title plays during the intro window; watermark plays from the
  // first body segment onward. Without this jump the user would have to
  // drag the playhead back manually to see the overlay update.
  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent).detail?.target ?? 'watermark'
      if (target === 'title') {
        // Title overlay belongs to the intro window, so preview the intro
        // source directly instead of the first body window.
        if (!edl || !(introOf(edl)?.file ?? "")) return
        const introBase = (introOf(edl)?.file ?? "").split(/[\\/]/).pop() ?? (introOf(edl)?.file ?? "")
        const matched = timelineFiles.find((f) => f.name === introBase)
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
      // Watermark overlay belongs to body footage; jump to the first body
      // segment so PreviewBox renders it.
      setPreviewSource(null)
      setSelectedSegIdx(0)
      setPreviewSegIdx(0)
      setPendingSeek({ offset: 0, nonce: Date.now() })
    }
    window.addEventListener('dive.scrollToCover', handler)
    return () => window.removeEventListener('dive.scrollToCover', handler)
  }, [edl, timelineFiles])

  // Watermark default = title (cover_lines). Per user spec, when the
  // user hasn't typed a custom watermark, just mirror the title verbatim
  // instead of running the legacy derive-short-form transform.
  const effectiveSmallLines = useMemo(() => {
    const small = jobMeta.small_lines.filter((line) => line && line.trim() !== '')
    if (small.length > 0) return small
    return jobMeta.cover_lines
  }, [jobMeta.small_lines, jobMeta.cover_lines])

  // The preview uses HTML overlays. The backend still emits _overlay.ass
  // at render time for ffmpeg to bake.

  //  Canvas zoom: Ctrl+wheel, mouse-anchored 
  const [appZoom, setAppZoom] = useState(1)
  const canvasOuterRef = useRef<HTMLDivElement>(null)
  const [canvasBase, setCanvasBase] = useState({ w: 1280, h: 720 })
  const [viewportSize, setViewportSize] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }))
  const zoomAnchorRef = useRef<{ mx: number; my: number; prevScale: number } | null>(null)
  const appZoomRef = useRef(appZoom)
  appZoomRef.current = appZoom

  useEffect(() => {
    // 2026-05-05: compute a fixed 16:9-ish canvas baseline from the
    // available screen size. Window resize changes scroll/crop only.
    const MIN_CANVAS_W = 1280
    const MIN_CANVAS_H = 720
    const computeBaseline = (): { w: number; h: number } => {
      // 4px WebView2 overlay scrollbar gutter=0, Header=42px.
      //   canvasBase.w = mainW - 24 = innerWidth - 24; left=right=12
      //   canvasBase.h = mainH - 24 = innerHeight - 42 - 24 = innerHeight - 66
      //                                                    top=bottom=12
      // Near-16:9 viewports are height-bound so PreviewBox keeps 16:9.
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
    const update = () => setViewportSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const coverZoom = useMemo(() => {
    const HEADER_H = 42
    const availableW = Math.max(1, viewportSize.w - 24)
    const availableH = Math.max(1, viewportSize.h - HEADER_H - 24)
    return Math.max(availableW / canvasBase.w, availableH / canvasBase.h)
  }, [canvasBase, viewportSize])
  const renderZoom = appZoom * coverZoom
  const coverZoomRef = useRef(coverZoom)
  coverZoomRef.current = coverZoom
  const renderZoomRef = useRef(renderZoom)
  renderZoomRef.current = renderZoom
  const getScrollLayout = useCallback((scale: number) => {
    const HEADER_H = 42
    const mainW = Math.max(1, viewportSize.w)
    const mainH = Math.max(1, viewportSize.h - HEADER_H)
    const scaledW = canvasBase.w * scale
    const scaledH = canvasBase.h * scale
    const scrollW = Math.max(mainW, scaledW)
    const scrollH = Math.max(mainH, scaledH)
    return {
      mainW,
      mainH,
      scaledW,
      scaledH,
      scrollW,
      scrollH,
      contentLeft: Math.floor((scrollW - scaledW) / 2),
      contentTop: Math.floor((scrollH - scaledH) / 2),
    }
  }, [canvasBase, viewportSize])
  const canvasLayout = useMemo(() => getScrollLayout(renderZoom), [getScrollLayout, renderZoom])

  useEffect(() => {
    const outer = canvasOuterRef.current
    if (!outer) return
    const anchor = zoomAnchorRef.current
    if (anchor) {
      zoomAnchorRef.current = null
      const prev = anchor.prevScale
      const next = renderZoom
      const prevLayout = getScrollLayout(prev)
      const nextLayout = getScrollLayout(next)
      const canvasX = (outer.scrollLeft + anchor.mx - prevLayout.contentLeft) / prev
      const canvasY = (outer.scrollTop + anchor.my - prevLayout.contentTop) / prev
      const maxLeft = Math.max(0, nextLayout.scrollW - nextLayout.mainW)
      const maxTop = Math.max(0, nextLayout.scrollH - nextLayout.mainH)
      outer.scrollLeft = Math.max(0, Math.min(maxLeft, nextLayout.contentLeft + canvasX * next - anchor.mx))
      outer.scrollTop = Math.max(0, Math.min(maxTop, nextLayout.contentTop + canvasY * next - anchor.my))
      return
    }
    if (appZoom === 1) {
      const layout = getScrollLayout(renderZoom)
      outer.scrollLeft = Math.max(0, (layout.scrollW - layout.mainW) / 2)
      outer.scrollTop = Math.max(0, (layout.scrollH - layout.mainH) / 2)
    }
  }, [appZoom, getScrollLayout, renderZoom])

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
  // button anywhere in the UI; cursor switches to grabbing and moving
  // the mouse scrolls the canvas in the opposite direction (1:1, not
  // velocity-based), release wheel button stops. This is the original
  // pre-rev behaviour the user wants back, scoped to the WHOLE UI so
  // any spot inside `canvasOuterRef` is a valid grab handle.
  const [isPanning, setIsPanning] = useState(false)
  const panStart = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)

  useEffect(() => {
    const outer = canvasOuterRef.current
    if (!outer) return

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      if (!(e.target instanceof Node) || !outer.contains(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      const rect = outer.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setAppZoom((prev) => {
        const step = e.deltaY > 0 ? -0.1 : 0.1
        const next = Math.round(Math.min(3, Math.max(0.3, prev + step)) * 100) / 100
        if (next === prev) return prev
        zoomAnchorRef.current = { mx, my, prevScale: prev * coverZoomRef.current }
        return next
      })
    }

    const clearGlobalPan = () => {
      if (panStart.current) {
        panStart.current = null
        setIsPanning(false)
        document.body.style.cursor = ''
        unlockTextSelect()
      }
    }
    const cancelPointerOps = () => {
      clearGlobalPan()
      window.dispatchEvent(new CustomEvent('dive.cancelPointerOps'))
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      document.body.style.cursor = ''
      delete document.body.dataset.draggingFile
      unlockTextSelect()
    }
    const onDocumentMouseLeave = (e: MouseEvent) => {
      if (e.relatedTarget === null) cancelPointerOps()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') cancelPointerOps()
    }
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return
      if (!(e.target instanceof Node) || !outer.contains(e.target)) return
      if (e.target instanceof HTMLElement && e.target.closest('[data-timeline-zoom-scope="true"]')) return
      e.preventDefault()
      e.stopPropagation()
      setIsPanning(true)
      document.body.style.cursor = 'grabbing'
      lockTextSelect()
      panStart.current = { x: e.clientX, y: e.clientY, sl: outer.scrollLeft, st: outer.scrollTop }
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!panStart.current) return
      e.preventDefault()
      outer.scrollLeft = panStart.current.sl - (e.clientX - panStart.current.x)
      outer.scrollTop = panStart.current.st - (e.clientY - panStart.current.y)
    }
    const onMouseUp = () => clearGlobalPan()
    // Suppress the OS/browser middle-click autoscroll widget that would
    // otherwise hijack the pan.
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }

    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    window.addEventListener('mousedown', onMouseDown, true)
    outer.addEventListener('auxclick', onAuxClick)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('blur', cancelPointerOps)
    document.addEventListener('mouseleave', onDocumentMouseLeave)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelPointerOps()
      window.removeEventListener('wheel', onWheel, true)
      window.removeEventListener('mousedown', onMouseDown, true)
      outer.removeEventListener('auxclick', onAuxClick)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('blur', cancelPointerOps)
      document.removeEventListener('mouseleave', onDocumentMouseLeave)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(null)
  const [previewFullscreenRequestKey, setPreviewFullscreenRequestKey] = useState<number | null>(null)
  const [previewVideoAspect, setPreviewVideoAspect] = useState(16 / 9)
  const [initialLoad, setInitialLoad] = useState(false)
  const wsCloserRef = useRef<(() => void) | null>(null)
  const fireResultSanityRef = useRef<(newEdl: EDL | null) => void>(() => {})
  const previewSourceIsIntro = useMemo(() => {
    if (!previewSource || !edl) return false
    const intro = introOf(edl)
    if (!intro) return false
    return previewSource.start >= intro.start - 0.05
      && previewSource.start <= intro.end + 0.05
      && Math.abs(previewSource.end - intro.end) < 0.05
      && sameSourceFile(previewSource.filePath, intro.file)
  }, [edl, previewSource])

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
  const previewSourceFile = useCallback((file: VideoFile, fullscreen = false) => {
    setPreviewSource({
      filePath: file.path,
      start: 0,
      end: Math.max(0, file.duration_sec),
    })
    setPreviewSegIdx(null)
    setSelectedSegIdx(null)
    setSelectedIntro(false)
    setPendingSeek({ offset: 0, nonce: Date.now() })
    setPlayheadSec(0)
    setPlayheadLaneFile(file.path)
    if (fullscreen) setPreviewFullscreenRequestKey(Date.now())
  }, [])
  const currentIntro = introOf(edl)
  const showCoverTitle = !!currentIntro && !!previewSegment
    && previewSegment.file === currentIntro.file
    && Math.abs(previewSegment.start - currentIntro.start) < 0.05
    && Math.abs(previewSegment.end - currentIntro.end) < 0.05

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
    edlRefMirror.current = next
    setEDL(next)
    const mode = timelineModeRef.current
    if (mode.kind === 'manual') {
      manualEdlRefMirror.current = next
      setManualEdl(next)
    } else if (mode.kind === 'raw') {
      const file = files.find((item) => item.name === mode.fileName)
      if (file) {
        const mergedManual = mergeRawFileEdlIntoManual(manualEdlRefMirror.current, next, file, files)
        manualEdlRefMirror.current = mergedManual
        setManualEdl(mergedManual)
      }
    } else if (mode.kind === 'pipeline') {
      setPipelineOutputRecords((prev) => prev.map((record) =>
        record.token === mode.token ? { ...record, edl: next } : record,
      ))
    }
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
  }, [folder, buildSnapshot, files])
  // Forward-ref bridge for addFileToLane / removeLaneFile (declared above).
  commitEdlRef.current = commitEdl

  // Restore full snapshot (EDL + lane state) when walking the history.
  const restoreSnapshot = useCallback((snap: HistorySnap) => {
    edlRefMirror.current = snap.edl
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

  const saveHistoryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const saveTimelineNow = useCallback(async () => {
    const currentEdl = edlRefMirror.current
    if (!folder || !currentEdl) return
    const normalizedEdl = normalizeEdlForTimeline(currentEdl, timelineFiles)
    edlRefMirror.current = normalizedEdl
    setEDL(normalizedEdl)
    if (saveEdlTimerRef.current) clearTimeout(saveEdlTimerRef.current)
    if (saveHistoryTimerRef.current) clearTimeout(saveHistoryTimerRef.current)
    const snap = buildSnapshot(normalizedEdl)
    const cursorEntry = historyDoc.cursor >= 0 ? historyDoc.entries[historyDoc.cursor] : null
    const historyToSave = cursorEntry?.edl === normalizedEdl
      ? historyDoc
      : (() => {
          const head = historyDoc.cursor >= 0
            ? historyDoc.entries.slice(0, historyDoc.cursor + 1)
            : []
          const entries = [...head, snap]
          const limited = entries.length > MAX_HISTORY ? entries.slice(-MAX_HISTORY) : entries
          return { entries: limited, cursor: limited.length - 1 }
        })()
    const jobRev = await saveJob(folder, jobMeta)
    if (jobRev) {
      const savedJob = { ...jobMeta, job_rev: jobRev }
      lastSavedJobRef.current = JSON.stringify(savedJob)
      setJobMeta(savedJob)
    }
    await Promise.all([
      saveEDL(folder, normalizedEdl),
      saveEDLHistory(folder, historyToSave),
    ])
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] Timeline saved`])
  }, [folder, historyDoc, jobMeta, buildSnapshot, timelineFiles])

  const saveSourceRanges = useCallback(async (nextRanges: SourceEDLSegment[]) => {
    if (!folder) return
    const saved = nextRanges.length > 0
      ? await saveSourceEDL(folder, nextRanges)
      : (await deleteSourceEDL(folder), [])
    setSourceRanges(saved)
  }, [folder])

  // Persist historyDoc to disk (debounced). Survives across sessions so
  // closing/reopening the folder keeps the entire undo chain back to the
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
      else if (e.key === 's') { e.preventDefault(); void saveTimelineNow() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, saveTimelineNow])

  const folderRef = useRef<string | null>(null)
  useEffect(() => { folderRef.current = folder }, [folder])
  const folderLoadSeqRef = useRef(0)

  // Debounced auto-save: any jobMeta change (overlay drag, cover/small text
  // edit, etc.) writes back to job.yaml after 600ms of quiet. Without this,
  // overlay tweaks would only land on disk when the user hits Run/Export and
  // a browser refresh in between would drop them.
  const lastSavedJobRef = useRef<string>('')
  const loadingJobRef = useRef(false)
  const reloadJobFromDisk = useCallback(async () => {
    const activeFolder = folderRef.current
    if (!activeFolder) return null
    loadingJobRef.current = true
    try {
      const fresh = await loadJob(activeFolder)
      if (fresh) {
        lastSavedJobRef.current = JSON.stringify(fresh)
        setJobMeta(fresh)
      }
      return fresh
    } finally {
      loadingJobRef.current = false
    }
  }, [])

  useEffect(() => {
    if (edlReviewMode) return
    if (!folder) return
    if (loadingJobRef.current) return
    const serialised = JSON.stringify(jobMeta)
    if (serialised === lastSavedJobRef.current) return
    const timer = setTimeout(() => {
      void saveJob(folder, jobMeta)
        .then((jobRev) => {
          const savedJob = jobRev ? { ...jobMeta, job_rev: jobRev } : jobMeta
          lastSavedJobRef.current = JSON.stringify(savedJob)
          setJobMeta((prev) => (JSON.stringify(prev) === serialised ? savedJob : prev))
        })
        .catch((err) => {
          if (err instanceof JobSaveConflictError) {
            void reloadJobFromDisk()
          }
        })
    }, 600)
    return () => clearTimeout(timer)
  }, [edlReviewMode, folder, jobMeta, reloadJobFromDisk])

  const loadFolderContents = useCallback(async (path: string) => {
    const seq = folderLoadSeqRef.current + 1
    folderLoadSeqRef.current = seq
    loadingJobRef.current = true
    const stale = () => folderLoadSeqRef.current !== seq
    // Cache is owned by the job folder itself (transcripts / EDL / logs /
    // preview_cache all live next to the videos), so swapping the
    // workspace doesn't need any cleanup; re-opening any folder later
    // re-uses whatever cache is already there. Pipeline output overwrites
    // existing cache files in place.
    thumbnailQueuedRef.current = new Set()
    setFolder(path)
    pushRecentFolder(path)
    setFiles([])
    setSourceRanges([])
    setManualEdl(null)
    setPipelineBaselineEdl(null)
    setPipelineOutputRecords([])
    setEDL(null)
    setTimelineModeSafe({ kind: 'empty' })
    setHistoryDoc({ entries: [], cursor: -1 })
    setSelectedSegIdx(null)
    setSelectedIntro(false)
    setSelectedLaneFile(null)
    setPreviewSource(null)
    setPreviewSegIdx(null)
    setInitialLoad(false)
    setRunPhase('idle')
    setLaneFiles(new Set())  // wipe lane state when switching folders
    setLaneFileCache(new Map())

    const fs = await listFiles(path)
    if (stale()) return
    setFiles(fs)
    const preloadPaths = [...new Set(fs.map((f) => f.path))]
    for (const filePath of preloadPaths) thumbnailQueuedRef.current.add(filePath)
    if (preloadPaths.length > 0) void startThumbnails(path, preloadPaths)

    // Hydrate jobMeta from this folder's job.yaml so cover_lines,
    // small_lines, and target survive UI restarts.
    const persistedJob = await loadJob(path)
    if (stale()) return
    if (persistedJob) {
      // Pre-seed the auto-save fingerprint so the debounced effect that runs
      // right after setJobMeta doesn't immediately write the freshly-loaded
      // copy back to disk.
      lastSavedJobRef.current = JSON.stringify(persistedJob)
      setJobMeta(persistedJob)
      setFiles(applyFileOrder(fs, persistedJob.body_files))
    } else {
      const next = { ...EMPTY_JOB }
      lastSavedJobRef.current = JSON.stringify(next)
      setJobMeta(next)
      setFiles(fs)
    }
    const persistedSourceRanges = await loadSourceEDL(path)
    if (stale()) return
    setSourceRanges(persistedSourceRanges)
    setManualEdl(buildManualEdlFromSourceRanges(fs, persistedSourceRanges))
    loadingJobRef.current = false

    // Load order:
    //   1. edl.baseline.json  (pipeline output; wins on project open)
    //   2. edl.history.json   (manual/session state when no pipeline exists)
    //   3. edl.json + draft   (current job folder state)
    const baseline = await loadEDLBaseline(path)
    if (stale()) return
    const baselineToken = `${PIPELINE_OUTPUT_TOKEN_PREFIX}baseline`
    const baselineReady = baseline !== null && edlHasTimeline(baseline)
    setPipelineBaselineEdl(baselineReady ? baseline : null)
    setPipelineOutputRecords(baselineReady
      ? [{
          id: 'baseline',
          token: baselineToken,
          edl: baseline,
          createdAt: Date.now(),
        }]
      : [])
    if (baselineReady) {
      const laneSet = laneFilesForEdl(baseline)
      const firstIdx = bodySegs(baseline).length > 0 ? 0 : null
      setTimelineModeSafe({ kind: 'pipeline', token: baselineToken })
      setEDL(baseline)
      setLaneFiles(laneSet)
      setLaneFileCache(new Map())
      setHistoryDoc({
        entries: [{ edl: baseline, laneFiles: Array.from(laneSet), laneFileCache: [] }],
        cursor: 0,
      })
      setRunPhase('finished')
      setInitialLoad(true)
      setTimelineZoom(initialPipelineZoom(baseline, fs))
      if (firstIdx !== null) focusBodySegment(baseline, firstIdx)
      return
    }
    const persistedHistory = await loadEDLHistory(path)
    if (stale()) return
    const existingEdl = await loadEDL(path)
    if (stale()) return
    if (persistedHistory && persistedHistory.entries.length > 0
        && persistedHistory.cursor >= 0
        && persistedHistory.cursor < persistedHistory.entries.length
        && edlHasTimeline(persistedHistory.entries[persistedHistory.cursor]?.edl ?? null)) {
      const snap = persistedHistory.entries[persistedHistory.cursor]
      const snapCache = snap.laneFileCache ?? []
      const firstIdx = bodySegs(snap.edl).length > 0 ? 0 : null
      setTimelineModeSafe({ kind: 'manual' })
      setEDL(snap.edl)
      setLaneFiles(laneFilesForEdl(snap.edl, snap.laneFiles, snapCache))
      setLaneFileCache(new Map(snapCache))
      setHistoryDoc(persistedHistory)
      setRunPhase('finished')
      setInitialLoad(true)
      if (firstIdx !== null) focusBodySegment(snap.edl, firstIdx)
      return
    }
    if (existingEdl && edlHasTimeline(existingEdl)) {
      const laneSet = laneFilesForEdl(existingEdl)
      const firstIdx = bodySegs(existingEdl).length > 0 ? 0 : null
      const entries: HistorySnap[] = []
      if (baseline && edlHasTimeline(baseline) && edlSignature(baseline) !== edlSignature(existingEdl)) {
        const baseLaneSet = laneFilesForEdl(baseline)
        entries.push({ edl: baseline, laneFiles: Array.from(baseLaneSet), laneFileCache: [] })
      }
      entries.push({ edl: existingEdl, laneFiles: Array.from(laneSet), laneFileCache: [] })
      setTimelineModeSafe({ kind: 'manual' })
      setEDL(existingEdl)
      setLaneFiles(laneSet)
      // Current saved EDL wins on folder open. If a pipeline baseline exists,
      // keep it as the first super-undo entry only.
      setHistoryDoc({
        entries,
        cursor: entries.length - 1,
      })
      setRunPhase('finished')
      setInitialLoad(true)
      if (firstIdx !== null) focusBodySegment(existingEdl, firstIdx)
      return
    }
  }, [setTimelineModeSafe, focusBodySegment, setTimelineZoom])

  useEffect(() => {
    const initialFolder = new URLSearchParams(window.location.search).get('folder')
    if (initialFolder) void loadFolderContents(initialFolder)
  }, [loadFolderContents])

  const handleRun = useCallback(async () => {
    if (!folder) return
    const runManualEdl = manualEdlRefMirror.current && edlHasTimeline(manualEdlRefMirror.current)
      ? manualEdlRefMirror.current
      : buildWholeManualEdl(files)
    if (!manualEdlRefMirror.current || !edlHasTimeline(manualEdlRefMirror.current)) {
      manualEdlRefMirror.current = runManualEdl
      setManualEdl(runManualEdl)
    }
    const runWindows = sourceRangesFromEdl(runManualEdl)
    const selectedBodyFiles = [...new Set(runWindows.map((win) => fileBase(win.file)))]
      .filter((name) => files.some((file) => file.name === name))
    const manualIntro = introOf(runManualEdl)
    const introName = manualIntro ? fileBase(manualIntro.file) : ''
    const introSelectedForRun = !!introName && selectedBodyFiles.includes(introName)
    const runMeta: JobMeta = {
      ...jobMeta,
      intro_file: introSelectedForRun ? introName : '',
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
    try {
      await saveSourceRanges(runWindows)
      setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] Source windows prepared (${runWindows.length})`])
    } catch (err) {
      setDialog({
        title: 'Source windows prepare failed',
        body: String(err),
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
    const runWorkers = runSystemInfo ? Math.max(1, runSystemInfo.workers_cap) : 1
    const runMode = runSystemInfo && !runSystemInfo.force_cpu
      && runSystemInfo.cuda_runtime_ok
      && runSystemInfo.cuda_status !== 'none'
      && !runSystemInfo.cudnn_status.startsWith('missing')
      ? 'gpu'
      : 'cpu'
    const runDetail = runSystemInfo
      ? (runMode === 'gpu'
          ? runSystemInfo.gpu_msg
          : runSystemInfo.force_cpu
            ? (runSystemInfo.gpu_available ? 'GPU available but CPU mode is forced' : 'CPU mode is forced')
            : runSystemInfo.gpu_available
              ? 'GPU detected but runtime is unavailable; using CPU mode'
              : 'No usable GPU detected; using CPU mode')
      : ''
    const initialLogs = runSystemInfo
      ? [
          `[system] mode=${runMode} workers=${runWorkers} gpu=${runSystemInfo.gpu_available ? 'available' : 'not_available'} detail=${runDetail}`,
        ]
      : ['[system] hardware check unavailable']
    setLogs(initialLogs)
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
      const jobRev = await saveJob(folder, runMeta)
      if (jobRev) {
        const savedRunMeta = { ...runMeta, job_rev: jobRev }
        lastSavedJobRef.current = JSON.stringify(savedRunMeta)
        setJobMeta(savedRunMeta)
      }
    } catch (err) {
      if (err instanceof JobSaveConflictError) {
        const fresh = await reloadJobFromDisk()
        setLogs((prev) => [
          ...prev,
          `[${new Date().toLocaleTimeString()}] ERROR Job settings changed on disk; reloaded ${fresh ? 'current job.yaml' : 'nothing'}. Run again.`,
        ])
        setRunPhase('error')
        return
      }
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
      } else if (ev.type === 'done') {
        setRunPhase('finished')
        // Pipeline output becomes the new visible EDL; clear hidden-lane
        // cache so stale manual windows do not override it.
        setLaneFileCache(new Map())
        void loadEDL(folder).then((newEdl) => {
          if (newEdl) {
            const createdAt = Date.now()
            const token = `${PIPELINE_OUTPUT_TOKEN_PREFIX}${createdAt}`
            setPipelineBaselineEdl(newEdl)
            setPipelineOutputRecords((prev) => [
              ...prev,
              {
                id: String(createdAt),
                token,
                edl: newEdl,
                createdAt,
              },
            ])
            setTimelineModeSafe({ kind: 'pipeline', token })
            setFiles((prev) => applyEdlFileOrder(prev, newEdl))
            const laneSet = laneFilesForEdl(newEdl)
            setEDL(newEdl)
            setLaneFiles(laneSet)
            setInitialLoad(true)
            const firstIdx = bodySegs(newEdl).length > 0 ? 0 : null
            if (firstIdx !== null) focusBodySegment(newEdl, firstIdx)
            // Seed undo history with this baseline so subsequent edits
            // build a chain that can always undo back to the pipeline
            // output. Server already wrote edl.baseline.json + cleared
            // edl.history.json in main.py.
            setHistoryDoc({
              entries: [{ edl: newEdl, laneFiles: Array.from(laneSet), laneFileCache: [] }],
              cursor: 0,
            })
          }
          // Result sanity modal fires only on real run completion,
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
  }, [folder, jobMeta, files, systemInfo, reloadJobFromDisk, saveSourceRanges, setTimelineModeSafe, focusBodySegment])

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
    const currentEdl = edlRefMirror.current
    if (currentEdl === null) {
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

    const performExport = async (edlToExport: EDL) => {
      const outputDir = await pickFolder()
      if (!outputDir) return
      const normalizedEdl = normalizeEdlForTimeline(edlToExport, timelineFiles)
      edlRefMirror.current = normalizedEdl
      setEDL(normalizedEdl)

      if (wsCloserRef.current) {
        wsCloserRef.current()
        wsCloserRef.current = null
      }

      try {
        const jobRev = await saveJob(folder, jobMeta)
        if (jobRev) {
          const savedJob = { ...jobMeta, job_rev: jobRev }
          lastSavedJobRef.current = JSON.stringify(savedJob)
          setJobMeta(savedJob)
        }
        await saveEDL(folder, normalizedEdl)
      } catch (err) {
        if (err instanceof JobSaveConflictError) {
          await reloadJobFromDisk()
        }
        setDialog({
          title: 'Save failed',
          body: err instanceof JobSaveConflictError
            ? 'Job settings changed on disk. Reloaded current job.yaml.'
            : String(err),
          confirmLabel: 'OK',
          cancelLabel: '',
          variant: 'danger',
          onConfirm: () => setDialog(null),
        })
        return
      }

      setRunPhase('running')
      setLogs([
        `[${new Date().toLocaleTimeString()}] Export started`,
        `[${new Date().toLocaleTimeString()}] Output folder: ${outputDir}`,
      ])

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
        } else if (ev.type === 'done') {
          setRunPhase('finished')
          setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] Export finished`])
        } else if (ev.type === 'error') {
          setRunPhase('error')
          setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ERROR Export failed`])
        }
      }

      const closer = connectLogs(jobId, handleEvent, () => {
        setActiveJobId(null)
      })
      wsCloserRef.current = closer
    }

    if (timelineModeRef.current.kind === 'raw') {
      setDialog({
        title: 'Export raw view?',
        body: 'Timeline is showing one source file only. Export will render only this raw view, not manual or pipeline cache.',
        confirmLabel: 'Export this raw view',
        cancelLabel: 'Cancel',
        variant: 'default',
        onConfirm: () => {
          setDialog(null)
          void performExport(currentEdl)
        },
      })
      return
    }

    await performExport(currentEdl)
  }, [folder, jobMeta, timelineFiles, reloadJobFromDisk])

  const ensureVisibleLaneWindows = useCallback((segments: Segment[]): Segment[] => {
    const next = [...segments]
    const intro = introOf(edl)
    const visibleLaneFileList = timelineLaneFiles.filter((f) => laneFiles.has(f.name) || laneFiles.has(f.path))
    for (const file of visibleLaneFileList) {
      if (file.duration_sec <= 0) continue
      const hasBodyWindow = next.some((seg) =>
        !seg.lane_file
        && (sameSourceFile(seg.file, file.path) || sameSourceFile(seg.file, file.name))
        && seg.end > seg.start,
      )
      const hasIntroWindow = !!intro
        && !intro.lane_file
        && (sameSourceFile(intro.file, file.path) || sameSourceFile(intro.file, file.name))
        && intro.end > intro.start
      const hasWindow = hasBodyWindow || hasIntroWindow
      if (hasWindow) continue
      next.push({
        file: file.path,
        start: 0,
        end: file.duration_sec,
        label: 'HULL',
        score: 1,
        protected: false,
      })
    }
    return next
  }, [edl, timelineLaneFiles, laneFiles])

  const handleSegmentsChange = useCallback((segments: Segment[]) => {
    const baseEdl = edl ?? emptyEdl()
    const orderedSegments = sortSegmentsForTimeline(ensureVisibleLaneWindows(segments), timelineFiles)
    commitEdl({
      ...replaceBody(baseEdl, orderedSegments),
      actual_body_duration_sec: orderedSegments.reduce((acc, s) => acc + (s.end - s.start), 0),
    })
  }, [edl, commitEdl, timelineFiles, ensureVisibleLaneWindows])

  const reorderTimelineLanes = useCallback((fromFile: string, toFile: string, placement: 'before' | 'after' = 'before') => {
    const currentEdl = edlRefMirror.current
    if (!currentEdl) return
    const next = reorderEdlLanes(currentEdl, fromFile, toFile, placement)
    if (next === currentEdl) return
    commitEdl(next)
  }, [commitEdl])

  useEffect(() => {
    if (!edl) return
    const body = bodySegs(edl)
    const fixed = ensureVisibleLaneWindows(body)
    if (fixed.length === body.length) return
    const orderedSegments = sortSegmentsForTimeline(fixed, timelineFiles)
    commitEdl({
      ...replaceBody(edl, orderedSegments),
      actual_body_duration_sec: orderedSegments.reduce((acc, s) => acc + (s.end - s.start), 0),
    })
  }, [edl, ensureVisibleLaneWindows, timelineFiles, commitEdl])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // Shift+A toggles "add files to lane" mode (mirror of toolbar
      // FilePlus button). Sorted alphabetically with other shortcuts so
      // the timeline shortcut hint shows it first ("a"-prefix wins).
      if (e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault()
        setAddingFiles((v) => !v)
        return
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      // Intro-level delete removes only the EDL intro marker. Body
      // windows remain available for ffmpeg and later edits.
      if (selectedIntro && edl) {
        e.preventDefault()
        commitEdl(deleteIntroWindow(edl))
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

  // Pipeline can start when a folder is loaded and, if overlays are
  // enabled, at least one title/watermark line is present.
  const overlayTextPresent =
    jobMeta.cover_lines.some((l) => l.trim() !== '')
    || jobMeta.small_lines.some((l) => l.trim() !== '')
  const isJobInfoComplete =
    folder !== null && (!overlayVisible || overlayTextPresent)

  // Pre-flight banner removed entirely; Start button's disabled
  // state (canRun = isJobInfoComplete) already prevents launching with
  // missing folder / title, so the banner just duplicated info.

  // Result sanity (Poka-yoke 3) fires as a centered modal exactly
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
      <main ref={canvasOuterRef} className="flex-1 min-h-0" style={{ position: 'relative', overflow: 'auto', cursor: isPanning ? 'grabbing' : undefined }}>
        {(() => {
          // Fixed-design canvas. Window resize only changes this outer scale:
          // same aspect ratio = full-frame proportional scale; mismatched
          // aspect ratio = scrollable crop. Individual panels never reflow.
          const topRowHeight = (canvasBase.h - 30) / 2
          const previewControlHeight = 48
          const previewAspect = Math.max(0.75, Math.min(16 / 9, previewVideoAspect || 16 / 9))
          const topContentWidth = canvasBase.w - 20
          const topGap = 10
          const importBaseWidth = 280
          const inputBaseWidth = 370
          const pipelineBaseWidth = 260
          const importMinWidth = 240
          const inputMinWidth = 330
          const pipelineMinWidth = 220
          const previewMinWidth = 380
          const previewIdealWidth = Math.max(previewMinWidth, (topRowHeight - previewControlHeight) * previewAspect)
          const basePanelWidth = importBaseWidth + inputBaseWidth + pipelineBaseWidth
          const minPanelWidth = importMinWidth + inputMinWidth + pipelineMinWidth
          const previewMaxWithBasePanels = topContentWidth - basePanelWidth - topGap * 3
          const previewMaxWithMinPanels = topContentWidth - minPanelWidth - topGap * 3
          const previewTargetWidth = Math.max(
            320,
            Math.min(
              previewIdealWidth,
              previewMaxWithBasePanels >= previewMinWidth
                ? previewMaxWithBasePanels
                : previewMaxWithMinPanels,
            ),
          )
          const panelSpace = Math.max(minPanelWidth, topContentWidth - previewTargetWidth - topGap * 3)
          const panelExtra = Math.max(0, panelSpace - basePanelWidth) / 3
          const panelShortage = Math.max(0, basePanelWidth - panelSpace)
          const importShrinkLimit = importBaseWidth - importMinWidth
          const inputShrinkLimit = inputBaseWidth - inputMinWidth
          const pipelineShrinkLimit = pipelineBaseWidth - pipelineMinWidth
          const importShrink = Math.min(importShrinkLimit, panelShortage * 0.3)
          const inputShrink = Math.min(inputShrinkLimit, panelShortage * 0.45)
          const pipelineShrink = Math.min(pipelineShrinkLimit, Math.max(0, panelShortage - importShrink - inputShrink))
          const importPanelWidth = importBaseWidth + panelExtra - importShrink
          const inputPanelWidth = inputBaseWidth + panelExtra - inputShrink
          const pipelinePanelWidth = pipelineBaseWidth + panelExtra - pipelineShrink
          const controlPanelWidth = inputPanelWidth + pipelinePanelWidth + topGap

          return <>
            <div style={{
              position: 'relative',
              width: canvasLayout.scrollW,
              height: canvasLayout.scrollH,
              minWidth: canvasLayout.scrollW,
              minHeight: canvasLayout.scrollH,
            }}>
            <div style={{
              position: 'absolute',
              top: canvasLayout.contentTop,
              left: canvasLayout.contentLeft,
              width: canvasBase.w,
          height: canvasBase.h,
          transform: `scale(${renderZoom})`,
          transformOrigin: '0 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          // 10px on every side; top/bottom/left/right gap from canvas
          // edge is uniform. Top edge butts against the Header.
          padding: '10px',
        }}>
        {/* Top row */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 10 }}>
          <div style={{
            width: importPanelWidth, flexShrink: 0, minHeight: 0,
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
              onPreviewFile={(file) => previewSourceFile(file, false)}
              onPreviewFileFullscreen={(file) => previewSourceFile(file, true)}
              addingFiles={addingFiles}
              onAddFileToLane={addFileToLane}
              manualOutput={manualOutput}
              pipelineOutputs={pipelineOutputs}
              activeRawFile={timelineMode.kind === 'raw' ? timelineMode.fileName : null}
              activeCacheToken={timelineMode.kind === 'manual'
                ? MANUAL_CACHE_TOKEN
                : timelineMode.kind === 'pipeline'
                  ? timelineMode.token
                  : null}
              onSelectedFilesChange={updateImportSelectedFiles}
              onReorderFiles={reorderImportFiles}
              onOpenRawFile={openRawFileInTimeline}
              onOpenCache={loadCacheToTimeline}
            />
          </div>
          <div style={{
            flex: 1, minWidth: 0, minHeight: 0, display: 'flex', gap: 10,
            // Add-mode dim: same blur look as the old export backdrop.
            ...(dimStyle ?? {}),
          }}>
            {/* Width is based on the video area, not the whole card: the
                card includes a bottom control row, so making the entire
                wrapper 16:9 makes the actual video stage too wide. */}
            <div style={{
              height: '100%',
              flex: `0 0 ${previewTargetWidth}px`,
              width: previewTargetWidth,
              minWidth: 320,
            }}>
              <PreviewBox
                segment={previewSegment}
                currentIdx={previewSegIdx}
                total={bodySegs(edl).length ?? 0}
                isSourcePreview={previewSource !== null && !previewSourceIsIntro}
                initialPaused={initialLoad}
                pendingSeek={pendingSeek}
                fullscreenRequestKey={previewFullscreenRequestKey}
                // HTML overlays are the visible preview renderer.
                coverLines={overlayVisible && showCoverTitle ? jobMeta.cover_lines : []}
                smallLines={previewSource ? [] : overlayVisible && !showCoverTitle ? effectiveSmallLines : []}
                coverOverlay={coverOverlay}
                smallOverlay={smallOverlay}
                logoOverlay={overlayVisible && (!previewSource || showCoverTitle) ? logoOverlay : undefined}
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
                  if (total === 0) return false
                  const next = previewSegIdx === null ? 0 : previewSegIdx + 1
                  if (next >= total) return false
                  const nextSeg = bodySegs(edl)[next]
                  if (!nextSeg) return false
                  setPreviewSource(null)
                  setSelectedIntro(false)
                  setSelectedSegIdx(next)
                  setPreviewSegIdx(next)
                  setPendingSeek({ offset: 0, nonce: Date.now() })
                  setPlayheadSec(nextSeg.start)
                  setPlayheadLaneFile(nextSeg.lane_file ?? nextSeg.file)
                  return true
                }}
                /* Playhead/video bidirectional logic:
                   - paused: playhead is user-owned (drag), video does NOT
                     advance the playhead (PreviewBox.onTimeUpdate gates
                     publishing on isPlaying)
                   - playing: video pushes the playhead forward, the user
                     reclaims control by pausing
                   - drag-playhead -> onSeek -> video seeks (setPlayheadSec
                     also called explicitly there to lock the new spot) */
                onPlayheadChange={(v) => {
                  // Ignore source-preview null events; segment preview
                  // owns timeline playhead updates.
                  if (v === null) return
                  setPlayheadSec(v)
                  if (previewSegment?.file) setPlayheadLaneFile(previewSegment.lane_file ?? previewSegment.file)
                }}
                onPlayingChange={setIsPreviewPlaying}
                onVideoAspectChange={setPreviewVideoAspect}
              />
            </div>
            <div className="flex-1 min-h-0" style={{ flex: `0 0 ${controlPanelWidth}px`, minWidth: controlPanelWidth, maxWidth: controlPanelWidth }}>
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
                align={activeOverlay.align ?? (selectedOverlay === 'small' ? 'left' : 'center')}
                onAlignChange={(v) => selectedOverlay && updateOverlay(selectedOverlay, { align: v })}
                onOverlayReset={() => {
                  // Reset overlay placement to the project defaults and
                  // refresh cached defaults with the same values.
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
                inputPanelWidth={inputPanelWidth}
                pipelinePanelWidth={pipelinePanelWidth}
              />
            </div>
          </div>
        </div>

        {/* Timeline full width, equal share with the top row (flex:1
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
            files={timelineLaneFiles.filter((f) => laneFiles.has(f.name) || laneFiles.has(f.path))}
            selectedIdx={selectedSegIdx}
            selectedIdxs={Array.from(selectedSegIdxs)}
            onSelectIdx={(idx, additive = false) => {
              // Timeline click updates selection. PreviewBox playback
              // remains driven by onPlayheadChange.
              selectSegment(idx, additive)
              if (idx !== null) {
                setPreviewSource(null)
                setPreviewSegIdx(idx)
              }
              if (!additive) setSelectedIntro(false)
            }}
            onSegmentsChange={handleSegmentsChange}
            canSetIntro={selectedSegIdxs.size === 1 || selectedSegIdx !== null}
            onSetSelectedAsIntro={() => {
              if (!edl) return
              const selectedIdx = selectedSegIdxs.size === 1
                ? Array.from(selectedSegIdxs)[0]
                : selectedSegIdx
              if (selectedIdx === null || selectedIdx === undefined) return
              const beforeBody = bodySegs(edl)
              const source = beforeBody[selectedIdx]
              if (!source) return
              const remainingKeys = new Set(
                Array.from(selectedSegIdxs)
                  .filter((idx) => idx !== selectedIdx)
                  .map((idx) => beforeBody[idx])
                  .filter((seg): seg is Segment => !!seg)
                  .map(segmentSelectionKey),
              )
              const next = promoteBodyToIntro(edl, selectedIdx)
              const nextSelectedIdxs = new Set<number>()
              bodySegs(next).forEach((seg, idx) => {
                if (remainingKeys.has(segmentSelectionKey(seg))) nextSelectedIdxs.add(idx)
              })
              commitEdl(next)
              setSelectedIntro(true)
              const nextPrimary = nextSelectedIdxs.values().next().value
              setSelectedSegIdx(nextPrimary === undefined ? null : nextPrimary)
              setSelectedSegIdxs(nextSelectedIdxs)
              setSelectedLaneFile(null)
              setPreviewSegIdx(null)
              setPreviewSource({
                filePath: source.file,
                start: source.start,
                end: source.end,
              })
              setPlayheadSec(source.start)
              setPlayheadLaneFile(source.lane_file ?? source.file)
            }}
            playheadSec={playheadSec}
            onSeek={(idx, offset) => {
              // Seek can target the intro marker (idx=-1) or a body lane.
              if (!edl) return
              if (idx === -1) {
                const introBase = (introOf(edl)?.file ?? "").split(/[\\/]/).pop() ?? (introOf(edl)?.file ?? "")
                const matched = timelineFiles.find((f) => f.name === introBase)
                const filePath = matched ? matched.path : (introOf(edl)?.file ?? "")
                setPreviewSource({
                  filePath,
                  start: (introOf(edl)?.start ?? 0) + offset,
                  end: (introOf(edl)?.end ?? 0),
                })
                setPreviewSegIdx(null)
                setPlayheadSec((introOf(edl)?.start ?? 0) + offset)
                setPlayheadLaneFile(filePath)
                return
              }
              const body = bodySegs(edl)
              const requestedSeg = body[idx]
              const requestedDuration = requestedSeg ? requestedSeg.end - requestedSeg.start : 0
              if (requestedSeg && offset >= requestedDuration - 0.08) {
                const nextIdx = body.findIndex((seg, segIdx) =>
                  segIdx !== idx
                  && (seg.lane_file ?? seg.file) === (requestedSeg.lane_file ?? requestedSeg.file)
                  && seg.start >= requestedSeg.end - 0.08
                )
                if (nextIdx >= 0) {
                  const nextSeg = body[nextIdx]
                  setPreviewSource(null)
                  setPreviewSegIdx(nextIdx)
                  setPendingSeek({ offset: 0, nonce: Date.now() })
                  setSelectedIntro(false)
                  setPlayheadSec(nextSeg.start)
                  setPlayheadLaneFile(nextSeg.lane_file ?? nextSeg.file)
                  return
                }
              }
              setPreviewSource(null)
              setPreviewSegIdx(idx)
              setPendingSeek({ offset, nonce: Date.now() })
              setSelectedIntro(false)
              const seg = body[idx]
              if (seg) {
                setPlayheadSec(seg.start + offset)
                setPlayheadLaneFile(seg.lane_file ?? seg.file)
              }
            }}
            zoom={timelineZoom}
            onZoomChange={setTimelineZoom}
            addingFiles={addingFiles}
            onToggleAddFiles={() => setAddingFiles((v) => !v)}
            onRemoveLaneFile={removeLaneFile}
            selectedLaneFile={selectedLaneFile}
            selectedLaneFiles={Array.from(selectedLaneFiles)}
            importSelectedFiles={importSelectedFiles}
            onSelectLaneFile={(f, additive = false) => { selectLaneFile(f, additive); if (f) setSelectedIntro(false) }}
            onReorderLane={reorderTimelineLanes}
            playheadLaneFile={playheadLaneFile}
            introMarker={(() => {
              if (!edl || !(introOf(edl)?.file ?? "")) return null
              // Build the intro marker from the current EDL and lane list.
              const introBase = (introOf(edl)?.file ?? "").split(/[\\/]/).pop() ?? (introOf(edl)?.file ?? "")
              const matched = timelineFiles.find((f) => f.name === introBase)
              return {
                file: matched ? matched.path : (introOf(edl)?.file ?? ""),
                start: (introOf(edl)?.start ?? 0),
                end: (introOf(edl)?.end ?? 0),
              }
            })()}
            introSelected={selectedIntro}
            onSelectIntro={(additive = false) => {
              if (!edl || !(introOf(edl)?.file ?? "")) return
              // Select intro marker and preview its source window.
              const introBase = (introOf(edl)?.file ?? "").split(/[\\/]/).pop() ?? (introOf(edl)?.file ?? "")
              const matched = timelineFiles.find((f) => f.name === introBase)
              const filePath = matched ? matched.path : (introOf(edl)?.file ?? "")
              setPreviewSource({
                filePath,
                start: (introOf(edl)?.start ?? 0),
                end: (introOf(edl)?.end ?? 0),
              })
              if (!additive) setSelectedSegIdx(null)
              setPreviewSegIdx(null)
              setSelectedLaneFile(null)
              setSelectedIntro((prev) => additive ? !prev : true)
              setPendingSeek({ offset: 0, nonce: Date.now() })
              setPlayheadSec(introOf(edl)?.start ?? 0)
              setPlayheadLaneFile(filePath)
            }}
            onDeleteIntro={() => {
              if (!edl) return
              commitEdl(deleteIntroWindow(edl))
              setSelectedIntro(false)
            }}
            onUnsetIntro={() => {
              if (!edl) return
              commitEdl(unsetIntroWindow(edl))
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
        </div>
        </>
        })()}
      </main>

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
