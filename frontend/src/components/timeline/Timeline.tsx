import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Segment, VideoFile } from '@/types/edl'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { lockTextSelect, unlockTextSelect } from '@/lib/dragLock'
import FilmStrip from './FilmStrip'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from './zoom'

// 1:1 port of v5-app.jsx Ribbon (glass-lens timeline):
//   track area contains:
//     - ruler (sticky top): adaptive "nice" interval marks
//     - file labels band: hue dot + filename · duration
//     - filmstrip row:
//         * real LaneThumbs (video frames) per lane — base layer
//         * FilmStrip fogged overlay on lanes — dims discarded regions
//         * kept segment windows: thumbs without fog + blue border
//         * create-preview rectangle (green dashed)
//         * split-cursor vertical red line
//         * playhead blue vertical line + triangle handle

// Fallback px/sec when viewport or total duration isn't measured yet. Once
// the ResizeObserver fires we switch to a dynamic base where zoom=1 means
// "rail fills viewport exactly".
const BASE_PX_PER_SEC_FALLBACK = 0.5

const RULER_HEIGHT_PX = 22
const FILE_LABEL_HEIGHT_PX = 18
const TRACK_HEIGHT_PX = 188
const MIN_SEG_DURATION = 10
const MIN_WIN_PX = 10
const COMPACT_WIN_PX = 50
const LANE_GAP_PX = 2  // visual separator between adjacent file lanes

const RULER_NICE_INTERVALS_SEC = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

// Trim cursor: neutral ⇆ shape used during shift-trim hover.
// (Directional ◀] / [▶ variants were dropped — neutral arrows handle both edges.)
const trimCursorNeutral = (c: string) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cg fill='${c}'%3E%3Cpolygon points='2,12 8,7 8,17'/%3E%3Crect x='7' y='11' width='10' height='2'/%3E%3Cpolygon points='22,12 16,7 16,17'/%3E%3C/g%3E%3C/svg%3E") 12 12, ew-resize`
const RULER_MIN_TICK_PX = 70

// Deterministic hue per file — stable colour dot on the lane label.
function hueFor(file: string): number {
  let h = 0
  for (let i = 0; i < file.length; i++) h = (h * 31 + file.charCodeAt(i)) & 0xffff
  return 180 + (h % 60)
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

function formatSignedMinutes(sec: number): string {
  const sign = sec >= 0 ? '+' : '-'
  const total = Math.round(Math.abs(sec))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${sign}${minutes}:${String(seconds).padStart(2, '0')}`
}

export type TimelineMode = 'pointer' | 'split' | 'create'

interface Props {
  segments: Segment[]
  files: VideoFile[]
  onChange: (segments: Segment[]) => void
  selectedIdx: number | null
  selectedIdxs?: number[]
  onSelectIdx: (idx: number | null, additive?: boolean) => void
  playheadSec: number | null
  onSeek?: (segIdx: number, offsetInSeg: number) => void
  selectedLaneFile?: string | null
  selectedLaneFiles?: string[]
  importSelectedFiles?: string[]
  onSelectLaneFile?: (file: string | null, additive?: boolean) => void
  onReorderLane?: (fromFile: string, toFile: string, placement?: 'before' | 'after') => void
  // File whose timeline lane the playhead currently lives in. Driven by
  // PreviewBox's segment (previewSegIdx) — NOT by selectedIdx, so clicking
  // a window doesn't move the playhead.
  playheadLaneFile?: string | null
  // Intro speech region — purely a read-only marker on the lane that owns
  // the intro file. Tells the user "this part is the introduction (kept
  // by the pipeline as the cover-overlay segment)" so they don't think
  // it was dropped just because there's no editable body window over it.
  introMarker?: { file: string; start: number; end: number } | null
  // INTRO is rendered as a pseudo SegmentWindow (globalIdx = -1). Drag /
  // resize / select on it route through these intro-specific callbacks
  // instead of EDL.body_segments (the intro lives in EDL.intro_speech_*).
  introSelected?: boolean
  onSelectIntro?: (additive?: boolean) => void
  onIntroResize?: (edge: 'start' | 'end', newVal: number) => void
  onIntroMove?: (start: number, end: number) => void
  zoom: number
  onZoomChange: (zoom: number) => void
  mode?: TimelineMode
  onModeChange?: (mode: TimelineMode) => void
  onAddSegment?: (file: string, start: number, end: number) => void
  onSplitSegment?: (segIdx: number, srcSec: number) => void
  // 当前作业文件夹绝对路径,FilmStrip 用它向后端拉缓存缩略图。
  folder?: string | null
}

interface FileLane {
  file: string
  sourceFile: string
  name: string
  duration: number
  offsetSec: number
  // Pixels of empty gap inserted BEFORE this lane (between this lane and
  // the previous one). 0 for the first lane. Decouples visual separation
  // from time, so gap stays a constant 10px regardless of zoom.
  gapPxBefore: number
  segments: { seg: Segment; globalIdx: number }[]
}

const laneKeyOf = (seg: Segment): string => seg.lane_file ?? seg.file

export default function Timeline({
  segments, files, onChange, selectedIdx, selectedIdxs = [], onSelectIdx, playheadSec, onSeek, zoom, onZoomChange,
  mode = 'pointer', onModeChange, onAddSegment, onSplitSegment,
  selectedLaneFile, selectedLaneFiles = [], importSelectedFiles = [], onSelectLaneFile, onReorderLane,
  playheadLaneFile = null,
  introMarker = null, introSelected = false,
  onSelectIntro, onIntroResize, onIntroMove,
  folder = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectedIdxSet = useMemo(() => new Set(selectedIdxs), [selectedIdxs])
  const selectedLaneFileSet = useMemo(() => new Set(selectedLaneFiles), [selectedLaneFiles])
  const laneHeaderDidDragRef = useRef(false)
  const importSelectedFileSet = useMemo(() => {
    const next = new Set<string>()
    for (const file of importSelectedFiles) {
      const normalized = file.toLowerCase()
      next.add(normalized)
      next.add(basename(file).toLowerCase())
    }
    return next
  }, [importSelectedFiles])
  // Track scroll viewport width — zoom=1 is defined as "rail fills viewport".
  // Use a ref callback so the ResizeObserver re-attaches whenever the scroll
  // container element changes (e.g. when the placeholder unmounts and the
  // main render mounts after EDL loads). A plain useLayoutEffect with deps
  // [] would only fire once and miss that swap, leaving the timeline stuck
  // on the fallback width.
  // Video-lane middle-drag scope. App-level pan handles the rest of the UI,
  // but lane mouse handlers stop bubbling, so the lane needs a local bridge.
  const panScopeRef = useRef<HTMLDivElement>(null)
  const [viewportWidthState, setViewportWidth] = useState(1200)
  const [scrollLeftPx, setScrollLeftPx] = useState(0)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const scrollCleanupRef = useRef<(() => void) | null>(null)
  const attachScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollCleanupRef.current?.()
    scrollCleanupRef.current = null
    scrollRef.current = el
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect()
      resizeObserverRef.current = null
    }
    if (!el) return
    setViewportWidth(el.clientWidth)
    setScrollLeftPx(el.scrollLeft)
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth))
    ro.observe(el)
    resizeObserverRef.current = ro
    const onScroll = () => setScrollLeftPx(el.scrollLeft)
    el.addEventListener('scroll', onScroll, { passive: true })
    scrollCleanupRef.current = () => el.removeEventListener('scroll', onScroll)
  }, [])
  const viewportWidth = viewportWidthState

  useEffect(() => {
    return () => {
      resizeObserverRef.current?.disconnect()
      scrollCleanupRef.current?.()
    }
  }, [])

  const [dragPlayheadPx, setDragPlayheadPx] = useState<number | null>(null)
  const playheadDragStartRef = useRef<{ startX: number; startPx: number } | null>(null)

  const zoomAnchorRef = useRef<{ worldSec: number; xInView: number } | null>(null)
  const prevZoomRef = useRef(zoom)

  // Lanes + totals must be computed BEFORE pxPerSec (which depends on total).
  // Lane order = `files` natural order (which is the listFiles backend
  // sort, i.e. filename-natural / chronological). This keeps lanes
  // stable when segments are deleted: the lane stays in the same slot
  // and just renders empty filmstrip until the user pulls clips back
  // out. Files that exist in segments but not in `files` (rare race
  // during folder switch) are appended at the end so we never drop a
  // segment off-screen.
  const lanes: FileLane[] = useMemo(() => {
    const segsByFile = new Map<string, { seg: Segment; globalIdx: number }[]>()
    segments.forEach((seg, i) => {
      const key = laneKeyOf(seg)
      const arr = segsByFile.get(key) ?? []
      arr.push({ seg, globalIdx: i })
      segsByFile.set(key, arr)
    })
    const collectLaneSegments = (f: VideoFile): { seg: Segment; globalIdx: number }[] => {
      const keys = [f.path, f.name, basename(f.path)].filter(Boolean)
      const seen = new Set<string>()
      const items: { seg: Segment; globalIdx: number }[] = []
      for (const key of keys) {
        for (const item of segsByFile.get(key) ?? []) {
          const dedupeKey = `${item.globalIdx}|${item.seg.file}|${item.seg.start.toFixed(3)}|${item.seg.end.toFixed(3)}|${item.seg.label ?? ''}`
          if (seen.has(dedupeKey)) continue
          seen.add(dedupeKey)
          items.push(item)
        }
      }
      return items.sort((a, b) => a.seg.start - b.seg.start)
    }
    // Inject INTRO as a pseudo-segment (globalIdx = -1) on its lane so it
    // renders through the SAME SegmentWindow path as body segments. Drag
    // / resize / select all behave identically — only colour + the special
    // globalIdx=-1 routes commits to onIntroResize/Move instead of EDL.
    if (introMarker) {
      const introSeg: Segment = {
        file: introMarker.file,
        start: introMarker.start,
        end: introMarker.end,
        label: 'INTRO',
        score: 0,
        protected: true,
      }
      const arr = segsByFile.get(introMarker.file) ?? []
      arr.push({ seg: introSeg, globalIdx: -1 })
      segsByFile.set(introMarker.file, arr)
    }
    let off = 0
    const out: FileLane[] = []
    // Lanes are strictly the files the user has chosen (props.files).
    // Cache segments belonging to files NOT on that list are ignored —
    // the EDL cache cannot resurrect dropped/unchecked files into the
    // timeline. Orphan-pass removed (2026-05-07) for cache decoupling.
    files.forEach((f, idx) => {
      const segs = collectLaneSegments(f)
      out.push({
        file: f.path,
        sourceFile: f.source_path ?? f.path,
        name: f.name || basename(f.path),
        duration: f.duration_sec,
        offsetSec: off,
        gapPxBefore: idx * LANE_GAP_PX,
        segments: segs,
      })
      off += f.duration_sec
    })
    return out
  }, [segments, files, introMarker])

  const totalExpandedSec = useMemo(() => lanes.reduce((a, l) => a + l.duration, 0), [lanes])

  // Edge-resize gate: a window's edge handle accepts mousedown only when
  // that window is currently selected. Unselected → mousedown falls
  // through to the SegmentWindow body (= select). This replaces the
  // earlier double-click-to-arm ritual — selection itself is the gate.

  // Live overrides for segments currently being dragged. Lets the cover
  // bar reflect the in-flight start/end without polluting the undo
  // history (the SegmentWindow only commits to props.segments on mouseup).
  const [liveOverrides, setLiveOverrides] = useState<Map<number, { start: number; end: number }>>(() => new Map())
  const handleLiveChange = useCallback((idx: number, start: number, end: number) => {
    setLiveOverrides((prev) => {
      const next = new Map(prev)
      next.set(idx, { start, end })
      return next
    })
  }, [])
  const handleLiveEnd = useCallback((idx: number) => {
    setLiveOverrides((prev) => {
      if (!prev.has(idx)) return prev
      const next = new Map(prev)
      next.delete(idx)
      return next
    })
  }, [])

  // lanes with live drag overrides applied per-segment. Cover-bar boundary
  // markers + anything else that needs to track in-flight drags reads from
  // this; lanes itself stays committed to props.segments for stable
  // SegmentWindow keys.
  const liveLanes = useMemo(() => {
    if (liveOverrides.size === 0) return lanes
    return lanes.map((l) => ({
      ...l,
      segments: l.segments.map(({ seg, globalIdx }) => {
        const ov = liveOverrides.get(globalIdx)
        if (!ov) return { seg, globalIdx }
        return { seg: { ...seg, start: ov.start, end: ov.end }, globalIdx }
      }),
    }))
  }, [lanes, liveOverrides])
  const laneMatchesImportSelection = useCallback((lane: FileLane): boolean => {
    if (importSelectedFileSet.size === 0) return false
    return [lane.file, lane.sourceFile, lane.name, basename(lane.file), basename(lane.sourceFile)]
      .some((item) => importSelectedFileSet.has(item.toLowerCase()))
  }, [importSelectedFileSet])

  // Reads liveLanes (not lanes) so the divider tracks an in-flight INTRO
  // drag in real time — otherwise the title block snaps only on mouseup.
  const overlayAnchorGlobalStarts = useMemo(() => {
    let introStart: number | null = null
    let bodyStart: number | null = null
    for (const lane of liveLanes) {
      const sorted = [...lane.segments].sort((a, b) => a.seg.start - b.seg.start)
      for (const { seg } of sorted) {
        if (seg.label === 'INTRO') {
          if (introStart === null) introStart = lane.offsetSec + seg.start
        } else if (bodyStart === null) {
          bodyStart = lane.offsetSec + seg.start
        }
      }
    }
    return {
      title: introStart ?? bodyStart ?? 0,
      watermark: bodyStart ?? introStart ?? 0,
    }
  }, [liveLanes])

  const laneByFile = useMemo(() => {
    const m = new Map<string, FileLane>()
    for (const l of lanes) m.set(l.file, l)
    return m
  }, [lanes])

  // Dynamic px/sec: zoom=1 → rail fits viewport exactly even after lane
  // gaps are added. Lane gaps are constant pixels (don't scale with zoom),
  // so we subtract them from viewport before dividing into pxPerSec so the
  // zoom=1 base case still fits the whole rail in view.
  const totalGapPx = lanes.length > 1 ? (lanes.length - 1) * LANE_GAP_PX : 0
  const pxPerSec = (totalExpandedSec > 0 && viewportWidth > 0)
    ? Math.max(0.01, (viewportWidth - totalGapPx) / totalExpandedSec) * zoom
    : BASE_PX_PER_SEC_FALLBACK * zoom
  const totalWidth = Math.max(200, totalExpandedSec * pxPerSec + totalGapPx)

  const handleLaneHeaderPointerDown = useCallback((e: React.PointerEvent, lane: FileLane) => {
    if (!onReorderLane || e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    let didDrag = false
    laneHeaderDidDragRef.current = false
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture?.(e.pointerId)

    const laneAtClientX = (clientX: number): { lane: FileLane; placement: 'before' | 'after' } | null => {
      const scroll = scrollRef.current
      if (!scroll) return null
      const rect = scroll.getBoundingClientRect()
      const x = clientX - rect.left + scroll.scrollLeft
      for (const candidate of lanes) {
        const left = candidate.offsetSec * pxPerSec + candidate.gapPxBefore
        const width = candidate.duration * pxPerSec
        if (x < left || x > left + width) continue
        return {
          lane: candidate,
          placement: x < left + width / 2 ? 'before' : 'after',
        }
      }
      return null
    }

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!didDrag && Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      if (!didDrag) {
        didDrag = true
        laneHeaderDidDragRef.current = true
        lockTextSelect()
        document.body.style.cursor = 'grabbing'
      }
      ev.preventDefault()
    }
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('dive.cancelPointerOps', onCancel)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      document.removeEventListener('mouseleave', onDocumentMouseLeave)
      target.releasePointerCapture?.(e.pointerId)
      if (didDrag) unlockTextSelect()
      document.body.style.cursor = ''
      window.setTimeout(() => { laneHeaderDidDragRef.current = false }, 0)
    }
    const onUp = (ev: PointerEvent) => {
      if (didDrag) {
        const hit = laneAtClientX(ev.clientX)
        if (hit && hit.lane.file !== lane.file) onReorderLane(lane.file, hit.lane.file, hit.placement)
      }
      cleanup()
    }
    const onCancel = () => cleanup()
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') cleanup()
    }
    const onDocumentMouseLeave = (ev: MouseEvent) => {
      if (ev.relatedTarget === null) cleanup()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    window.addEventListener('dive.cancelPointerOps', onCancel)
    document.addEventListener('visibilitychange', onVisibilityChange)
    document.addEventListener('mouseleave', onDocumentMouseLeave)
  }, [lanes, onReorderLane, pxPerSec])

  const expandedSecToPx = useCallback((sec: number, scale = pxPerSec): number => {
    if (lanes.length === 0) return Math.max(0, sec) * scale
    const clamped = Math.max(0, Math.min(totalExpandedSec, sec))
    let gapPxBefore = 0
    for (const lane of lanes) {
      if (clamped >= lane.offsetSec) gapPxBefore = lane.gapPxBefore
      if (clamped <= lane.offsetSec + lane.duration) break
    }
    return clamped * scale + gapPxBefore
  }, [lanes, pxPerSec, totalExpandedSec])

  const pxToExpandedSec = useCallback((px: number, scale = pxPerSec): number => {
    if (lanes.length === 0) return Math.max(0, px) / scale
    for (const lane of lanes) {
      const laneStartPx = lane.offsetSec * scale + lane.gapPxBefore
      const laneEndPx = (lane.offsetSec + lane.duration) * scale + lane.gapPxBefore
      if (px < laneStartPx) return lane.offsetSec
      if (px <= laneEndPx) return lane.offsetSec + Math.max(0, px - laneStartPx) / scale
    }
    return totalExpandedSec
  }, [lanes, pxPerSec, totalExpandedSec])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      const wheelUnits = Math.max(0.2, Math.min(1, Math.abs(e.deltaY) / 100))
      const delta = (e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP) * wheelUnits
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + delta))
      if (next === zoom) return
      const s = scrollRef.current
      if (s) {
        const rect = s.getBoundingClientRect()
        const xInView = e.clientX - rect.left
        const worldSec = pxToExpandedSec(s.scrollLeft + xInView, pxPerSec)
        zoomAnchorRef.current = { worldSec, xInView }
      }
      onZoomChange(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [zoom, pxPerSec, pxToExpandedSec, onZoomChange])

  // Middle-click pan is now handled at App level (canvasOuterRef) and
  // covers the whole UI uniformly — press wheel anywhere → cursor turns
  // to grabbing → drag to scroll. Timeline no longer captures middle
  // clicks, so they bubble up to App and the whole-UI pan behaves the
  // same on or off the lane area.

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let lastX = 0
    let active = false
    const cleanup = () => {
      if (!active) return
      active = false
      document.body.style.cursor = ''
      unlockTextSelect()
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', cleanup, true)
      window.removeEventListener('blur', cleanup, true)
    }
    const onMove = (ev: MouseEvent) => {
      if (!active) return
      ev.preventDefault()
      const dx = ev.clientX - lastX
      lastX = ev.clientX
      const s = scrollRef.current
      if (s) s.scrollLeft -= dx
    }
    const onDown = (e: MouseEvent) => {
      if (e.button !== 1) return
      const scope = panScopeRef.current
      if (!scope || !(e.target instanceof Node) || !scope.contains(e.target)) return
      if (!scrollRef.current) return
      e.preventDefault()
      e.stopPropagation()
      active = true
      lastX = e.clientX
      document.body.style.cursor = 'grabbing'
      lockTextSelect()
      window.addEventListener('mousemove', onMove, true)
      window.addEventListener('mouseup', cleanup, true)
      window.addEventListener('blur', cleanup, true)
    }
    el.addEventListener('mousedown', onDown, true)
    return () => {
      cleanup()
      el.removeEventListener('mousedown', onDown, true)
    }
  }, [])

  useEffect(() => {
    const s = scrollRef.current
    const prev = prevZoomRef.current
    if (!s || prev === zoom) { prevZoomRef.current = zoom; return }
    const newPxPerSec = pxPerSec
    const prevPxPerSec = (totalExpandedSec > 0 && viewportWidth > 0)
      ? Math.max(0.01, (viewportWidth - totalGapPx) / totalExpandedSec) * prev
      : BASE_PX_PER_SEC_FALLBACK * prev
    const a = zoomAnchorRef.current
    let worldSec: number, xInView: number
    if (a) { worldSec = a.worldSec; xInView = a.xInView; zoomAnchorRef.current = null }
    else {
      xInView = s.clientWidth / 2
      worldSec = pxToExpandedSec(s.scrollLeft + xInView, prevPxPerSec)
    }
    s.scrollLeft = Math.max(0, expandedSecToPx(worldSec, newPxPerSec) - xInView)
    prevZoomRef.current = zoom
  }, [zoom, pxPerSec, totalExpandedSec, totalGapPx, viewportWidth, expandedSecToPx, pxToExpandedSec])

  useEffect(() => {
    if (!onModeChange) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.ctrlKey || e.metaKey) return
      if (e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        onModeChange(mode === 'split' ? 'pointer' : 'split')
      } else if (e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        onModeChange(mode === 'create' ? 'pointer' : 'create')
      } else if (e.key === 'Escape') {
        if (mode !== 'pointer') onModeChange('pointer')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, onModeChange])

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return
      document.querySelectorAll<HTMLElement>('[data-trim-scope]').forEach(el => {
        el.style.cursor = ''
      })
    }
    window.addEventListener('keyup', onKeyUp)
    return () => window.removeEventListener('keyup', onKeyUp)
  }, [])

  // Jump-to-cover triggered from clicking Title / Watermark textarea
  // in the INPUT panel. detail.target chooses which moment to anchor:
  //   'title'     → scroll to timeline start (title-overlay = intro window)
  //   'watermark' → scroll to first body segment start (watermark takes over)
  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent).detail?.target ?? 'watermark'
      const s = scrollRef.current
      const anchorSec = target === 'title'
        ? overlayAnchorGlobalStarts.title
        : overlayAnchorGlobalStarts.watermark
      const anchorPx = expandedSecToPx(anchorSec)
      if (s) {
        const offset = Math.max(0, anchorPx - s.clientWidth / 2)
        s.scrollTo({ left: offset, behavior: 'smooth' })
      }
    }
    window.addEventListener('dive.scrollToCover', handler)
    return () => window.removeEventListener('dive.scrollToCover', handler)
  }, [overlayAnchorGlobalStarts, expandedSecToPx])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {}
      const pipelineWindowIndex = Number(detail.pipelineWindowIndex)
      if (Number.isFinite(pipelineWindowIndex)) {
        const hit = lanes
          .flatMap((lane) => lane.segments.map((item) => ({ lane, ...item })))
          .find((item) => item.globalIdx === pipelineWindowIndex)
        const s = scrollRef.current
        if (!hit || !s) return
        const anchorPx = expandedSecToPx(hit.lane.offsetSec + Math.max(0, Math.min(hit.lane.duration, hit.seg.start)))
        const maxLeft = Math.max(0, s.scrollWidth - s.clientWidth)
        const left = Math.max(0, Math.min(maxLeft, anchorPx - s.clientWidth * 0.25))
        s.scrollTo({ left, behavior: 'smooth' })
        if (hit.globalIdx === -1) onSelectIntro?.(false)
        else onSelectIdx(pipelineWindowIndex, false)
        return
      }
      const requestedFile = String(detail.file ?? '')
      const requestedName = String(detail.name ?? basename(requestedFile))
      const requestedBase = basename(requestedFile || requestedName).toLowerCase()
      const lane = lanes.find((item) =>
        item.file === requestedFile
        || item.sourceFile === requestedFile
        || item.name === requestedName
        || basename(item.file).toLowerCase() === requestedBase
        || basename(item.sourceFile).toLowerCase() === requestedBase
      )
      const s = scrollRef.current
      if (!lane || !s) return
      const rawStart = Number(detail.start ?? 0)
      const start = Number.isFinite(rawStart) ? rawStart : 0
      const anchorPx = expandedSecToPx(lane.offsetSec + Math.max(0, Math.min(lane.duration, start)))
      const maxLeft = Math.max(0, s.scrollWidth - s.clientWidth)
      const left = Math.max(0, Math.min(maxLeft, anchorPx - s.clientWidth * 0.25))
      s.scrollTo({ left, behavior: 'smooth' })
      const end = Number(detail.end ?? NaN)
      const match = lane.segments.find(({ seg }) =>
        Math.abs(seg.start - start) < 0.08
        && (!Number.isFinite(end) || Math.abs(seg.end - end) < 0.08)
      ) ?? lane.segments.find(({ seg }) => start >= seg.start - 0.08 && start <= seg.end + 0.08)
      if (match) {
        if (match.globalIdx === -1) onSelectIntro?.(false)
        else onSelectIdx(match.globalIdx, false)
      }
    }
    window.addEventListener('dive.scrollToSourceWindow', handler)
    return () => window.removeEventListener('dive.scrollToSourceWindow', handler)
  }, [lanes, expandedSecToPx, onSelectIdx, onSelectIntro])

  // Playhead — restored (2026-05-07b). Position is OWNED by user drag, not
  // driven by video.currentTime: PreviewBox no longer publishes
  // onPlayheadChange (see App.tsx), so the playhead stays put when video
  // plays or when a segment is clicked. Dragging the playhead still seeks
  // the video (one-way: playhead → video, never video → playhead).
  const playheadX = useMemo<number | null>(() => {
    // Lane is sourced from playheadLaneFile (= the PreviewBox's currently
    // playing/queued segment file), NOT from selectedIdx. Clicking a
    // window changes selectedIdx but leaves playheadLaneFile alone so the
    // playhead stays put.
    if (playheadSec === null) return 0
    if (playheadLaneFile === null) {
      return Math.max(0, playheadSec) * pxPerSec
    }
    const lane = laneByFile.get(playheadLaneFile)
    if (!lane) return Math.max(0, playheadSec) * pxPerSec
    const clamped = Math.max(0, Math.min(lane.duration, playheadSec))
    return (lane.offsetSec + clamped) * pxPerSec + lane.gapPxBefore
  }, [playheadSec, playheadLaneFile, laneByFile, pxPerSec])

  const displayPlayheadPx = dragPlayheadPx !== null
    ? dragPlayheadPx
    : playheadX

  useEffect(() => {
    if (playheadDragStartRef.current !== null) return
    setDragPlayheadPx(null)
  }, [playheadSec])

  const PLAYHEAD_HALF = 9
  const viewportRightPx = scrollLeftPx + viewportWidth
  const playheadOutLeft = displayPlayheadPx !== null && displayPlayheadPx < scrollLeftPx + PLAYHEAD_HALF
  const playheadOutRight = displayPlayheadPx !== null && displayPlayheadPx > viewportRightPx - PLAYHEAD_HALF
  const renderedPlayheadPx = displayPlayheadPx === null
    ? null
    : playheadOutLeft
      ? scrollLeftPx + PLAYHEAD_HALF
      : playheadOutRight
        ? viewportRightPx - PLAYHEAD_HALF
        : displayPlayheadPx
  const playheadIsClamped = playheadOutLeft || playheadOutRight
  const activeResizeIdx = useMemo(() => {
    const ids = new Set<number>()
    for (const idx of selectedIdxs) ids.add(idx)
    if (selectedIdx !== null) ids.add(selectedIdx)
    if (introSelected) ids.add(-1)
    return ids.size === 1 ? [...ids][0] : null
  }, [selectedIdx, selectedIdxs, introSelected])
  let playheadOnSelectedEdge = false
  if (activeResizeIdx !== null && renderedPlayheadPx !== null) {
    for (const lane of lanes) {
      const found = lane.segments.find((item) => item.globalIdx === activeResizeIdx)
      if (!found) continue
      const visualStart = Math.max(0, Math.min(found.seg.start, lane.duration))
      const visualEnd = Math.min(found.seg.end, lane.duration)
      const rawWidth = Math.max(0, (visualEnd - visualStart) * pxPerSec)
      const width = Math.max(MIN_WIN_PX, rawWidth)
      const leftPx = (lane.offsetSec + visualStart) * pxPerSec + lane.gapPxBefore
      const edgeInsidePx = Math.max(3, Math.min(20, width / 2))
      const edgeOutsidePx = Math.max(4, Math.min(12, width / 3))
      playheadOnSelectedEdge = (
        (renderedPlayheadPx >= leftPx - edgeOutsidePx && renderedPlayheadPx <= leftPx + edgeInsidePx)
        || (renderedPlayheadPx >= leftPx + width - edgeInsidePx && renderedPlayheadPx <= leftPx + width + edgeOutsidePx)
      )
      break
    }
  }
  const playheadDragBlocked = mode !== 'pointer' || playheadOnSelectedEdge
  const clientXToRailSec = useCallback((clientX: number): number => {
    const s = scrollRef.current
    if (!s) return 0
    const rect = s.getBoundingClientRect()
    const px = clientX - rect.left + s.scrollLeft
    return pxToExpandedSec(px)
  }, [pxToExpandedSec])

  const clientXToSplitRailSec = useCallback((clientX: number): number => {
    const s = scrollRef.current
    if (!s) return 0
    const rect = s.getBoundingClientRect()
    const px = clientX - rect.left + s.scrollLeft
    const splitPx = displayPlayheadPx !== null && Math.abs(px - displayPlayheadPx) <= PLAYHEAD_HALF
      ? displayPlayheadPx
      : px
    return pxToExpandedSec(splitPx)
  }, [displayPlayheadPx, pxToExpandedSec])

  const handlePlayheadMouseDown = useCallback((e: React.MouseEvent) => {
    if (mode !== 'pointer') return
    e.stopPropagation(); e.preventDefault()
    const startPx = renderedPlayheadPx ?? 0
    const startX = e.clientX
    playheadDragStartRef.current = { startX, startPx }
    setDragPlayheadPx(startPx)
    lockTextSelect()

    const EDGE = 48
    const SPEED = 14
    let lastClientX = e.clientX
    let animId: number | null = null

    const computePxFromCursor = (clientX: number): number => {
      const s = scrollRef.current
      if (!s) return startPx
      const rect = s.getBoundingClientRect()
      const px = clientX - rect.left + s.scrollLeft
      return Math.max(0, Math.min(totalWidth, px))
    }
    const tick = () => {
      const s = scrollRef.current
      if (!s) { animId = null; return }
      const rect = s.getBoundingClientRect()
      const maxScroll = s.scrollWidth - s.clientWidth
      let scrolled = false
      if (lastClientX < rect.left + EDGE && s.scrollLeft > 0) {
        s.scrollLeft = Math.max(0, s.scrollLeft - SPEED); scrolled = true
      } else if (lastClientX > rect.right - EDGE && s.scrollLeft < maxScroll) {
        s.scrollLeft = Math.min(maxScroll, s.scrollLeft + SPEED); scrolled = true
      }
      if (scrolled) {
        setDragPlayheadPx(computePxFromCursor(lastClientX))
      }
      animId = requestAnimationFrame(tick)
    }
    animId = requestAnimationFrame(tick)

    const onMove = (ev: MouseEvent) => {
      const r = playheadDragStartRef.current; if (!r) return
      lastClientX = ev.clientX
      setDragPlayheadPx(computePxFromCursor(ev.clientX))
    }
    const onUp = (ev: MouseEvent) => {
      const r = playheadDragStartRef.current; if (!r) return
      playheadDragStartRef.current = null
      if (animId !== null) cancelAnimationFrame(animId)
      unlockTextSelect()
      const newPx = computePxFromCursor(ev.clientX)
      setDragPlayheadPx(newPx)
      // Reverse-map newPx → (lane, local sec) using each lane's actual
      // pixel range (lane.offsetSec * pxPerSec + lane.gapPxBefore). Naive
      // px / pxPerSec ignored the cumulative LANE_GAP_PX so the wrong lane
      // was sometimes picked, which fed an off-by-gap seg.start back into
      // setPlayheadSec — visible as the playhead "snapping back".
      for (const lane of lanes) {
        const laneLeftPx = lane.offsetSec * pxPerSec + lane.gapPxBefore
        const laneRightPx = laneLeftPx + lane.duration * pxPerSec
        if (newPx < laneLeftPx || newPx > laneRightPx) continue
        const local = (newPx - laneLeftPx) / pxPerSec
        let best: { globalIdx: number; offsetInSeg: number; gap: number } | null = null
        const HIT_EPS = 0.08
        for (const { seg, globalIdx } of lane.segments) {
          if (Math.abs(local - seg.start) <= HIT_EPS) {
            best = { globalIdx, offsetInSeg: 0, gap: 0 }; break
          }
          if (local >= seg.start && local < seg.end - HIT_EPS) {
            best = { globalIdx, offsetInSeg: local - seg.start, gap: 0 }; break
          }
          const g = local < seg.start ? seg.start - local : local - seg.end
          if (!best || g < best.gap) {
            best = { globalIdx, offsetInSeg: local < seg.start ? 0 : seg.end - seg.start, gap: g }
          }
        }
        // No setSelectedIdx here — drag-playhead must NOT highlight the
        // landed window (user spec: "playhead 选窗跳转" disabled). It still
        // routes the seek to PreviewBox via onSeek so the preview follows.
        if (best) onSeek?.(best.globalIdx, best.offsetInSeg)
        break
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [renderedPlayheadPx, pxPerSec, lanes, onSeek, totalWidth, mode])

  const handleResize = useCallback((globalIdx: number, edge: 'start' | 'end', newVal: number) => {
    onChange(segments.map((s, i) => {
      if (i !== globalIdx) return s
      if (edge === 'start') return { ...s, start: Math.max(0, Math.min(newVal, s.end - MIN_SEG_DURATION)) }
      return { ...s, end: Math.max(s.start + MIN_SEG_DURATION, newVal) }
    }))
  }, [segments, onChange])

  const handleMove = useCallback((globalIdx: number, newStart: number, newEnd: number) => {
    onChange(segments.map((s, i) => i === globalIdx ? { ...s, start: newStart, end: newEnd } : s))
  }, [segments, onChange])

  const [creating, setCreating] = useState<{ startSec: number; currentSec: number } | null>(null)
  const handleTrackMouseDown = useCallback((e: React.MouseEvent) => {
    // Edge resize is triggered only by the selected window's Shift+edge
    // handle. Track-level fallback is removed so normal mousedowns on the
    // track stay reserved for selection / create mode.
    if (mode !== 'create' || !onAddSegment) return
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const startSec = clientXToRailSec(e.clientX)
    setCreating({ startSec, currentSec: startSec })
    lockTextSelect()
    const onMove = (ev: MouseEvent) =>
      setCreating((prev) => prev ? { ...prev, currentSec: clientXToRailSec(ev.clientX) } : null)
    const onUp = (ev: MouseEvent) => {
      const end = clientXToRailSec(ev.clientX)
      setCreating((prev) => {
        if (!prev) return null
        const lo = Math.min(prev.startSec, end), hi = Math.max(prev.startSec, end)
        if (hi - lo > 1) {
          // Cross-file split: find every lane the [lo,hi] range intersects
          // and emit one window per lane, clipped to that lane's bounds.
          // Single-lane drag → exactly one window (back-compat).
          for (const lane of lanes) {
            const laneStart = lane.offsetSec
            const laneEnd = lane.offsetSec + lane.duration
            const overlapLo = Math.max(lo, laneStart)
            const overlapHi = Math.min(hi, laneEnd)
            if (overlapHi - overlapLo > 0.1) {
              const localStart = overlapLo - laneStart
              const localEnd = overlapHi - laneStart
              const overlapsExisting = lane.segments.some(({ seg }) =>
                localStart < seg.end - 0.001 && localEnd > seg.start + 0.001,
              )
              if (overlapsExisting) continue
              onAddSegment(
                lane.file,
                localStart,
                localEnd,
              )
            }
          }
        }
        return null
      })
      onModeChange?.('pointer')
      unlockTextSelect()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [mode, onAddSegment, onModeChange, clientXToRailSec, lanes])

  const createRect = creating ? (() => {
    const lo = Math.min(creating.startSec, creating.currentSec)
    const hi = Math.max(creating.startSec, creating.currentSec)
    return { left: lo * pxPerSec, width: (hi - lo) * pxPerSec }
  })() : null

  const handleWindowSplitClick = useCallback((e: React.MouseEvent, segIdx: number) => {
    if (mode !== 'split' || !onSplitSegment) return
    e.stopPropagation()
    const seg = segments[segIdx]; if (!seg) return
    const lane = laneByFile.get(laneKeyOf(seg)); if (!lane) return
    const rs = clientXToSplitRailSec(e.clientX)
    const src = rs - lane.offsetSec
    if (src <= seg.start + 0.5 || src >= seg.end - 0.5) return
    onSplitSegment(segIdx, src)
    onModeChange?.('pointer')
  }, [mode, onSplitSegment, onModeChange, segments, laneByFile, clientXToSplitRailSec])

  // Adaptive ruler.
  const rawTick = RULER_MIN_TICK_PX / pxPerSec
  const tickSec = RULER_NICE_INTERVALS_SEC.find((n) => n >= rawTick) ?? 3600

  // Ruler range policy:
  //   zoom ≤ 1 (100% or shrunk) → ruler reaches the panel's right edge, so
  //                                 rEnd = viewportWidth / pxPerSec
  //   zoom > 1 (enlarged)       → rail has scroll; ruler stops one tick
  //                                 square past the last lane end.
  const rStart = 0
  const rEnd = zoom <= 1
    ? viewportWidth / pxPerSec
    : totalExpandedSec + tickSec
  const rulerMarks: number[] = []
  for (let t = rStart; t <= rEnd; t += tickSec) rulerMarks.push(t)

  const trackCursor = mode === 'split' ? 'crosshair' : mode === 'create' ? 'copy' : 'default'
  const handleTimelineBackgroundClick = useCallback((e: React.MouseEvent) => {
    if (mode !== 'pointer') return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('[data-seg-idx], [data-edge], [data-playhead-control]')) return
    onSelectIdx(null)
  }, [mode, onSelectIdx])

  if (lanes.length === 0) {
    // Placeholder also wires up attachScrollRef so the ResizeObserver
    // is live from first paint. When EDL eventually loads and the main
    // render mounts, the ref-callback re-attaches the observer to the
    // new scroll container without losing measurements.
    return (
      <div ref={containerRef} data-timeline-zoom-scope="true" className="relative h-full w-full flex flex-col overflow-hidden" style={{ background: 'var(--track-bg, #2a2a2a)' }}>
        <div ref={attachScrollRef} className="w-full h-full flex items-center justify-center overflow-hidden">
          <div className="text-sm py-8 text-center" style={{ color: 'rgba(255,255,255,0.3)' }}>
            No segments — run the pipeline to populate
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      data-timeline-zoom-scope="true"
      className="relative h-full w-full flex flex-col overflow-hidden"
      style={{ background: 'var(--track-bg, #2a2a2a)' }}
      onClick={handleTimelineBackgroundClick}
    >
      <div ref={attachScrollRef} className="w-full h-full overflow-x-auto overflow-y-hidden scrollbar-thin"
        style={{ background: `linear-gradient(to bottom, rgb(var(--bg-surface)) ${RULER_HEIGHT_PX}px, var(--track-bg, #2a2a2a) ${RULER_HEIGHT_PX}px)` }}
      >
        <div
          style={{
            width: totalWidth > viewportWidth ? totalWidth : '100%',
            minWidth: '100%',
            minHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            background: 'var(--track-bg, #2a2a2a)',
          }}
        >
          {/* Ruler — pinned to the top, NOT centred with the track */}
          <div
            style={{
              position: 'sticky',
              top: 0,
              height: RULER_HEIGHT_PX,
              borderBottom: '1px solid var(--track-border)',
              background: 'rgb(var(--bg-surface))',
              zIndex: 6,
              flexShrink: 0,
            }}
          >
            {rulerMarks.map((t) => (
              <div
                key={t}
                style={{
                  position: 'absolute',
                  left: t * pxPerSec,
                  top: 0,
                  bottom: 0,
                  borderLeft: '1px solid rgb(var(--border-subtle))',
                  paddingLeft: 4,
                  display: 'flex',
                  alignItems: 'center',
                  font: "500 10px/1 'JetBrains Mono', Consolas, monospace",
                  color: 'rgb(var(--text-muted))',
                  fontVariantNumeric: 'tabular-nums',
                  pointerEvents: 'none',
                }}
              >
                {formatDuration(t)}
              </div>
            ))}
          </div>

          {/* Track group — centred vertically between ruler and panel bottom */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>

          {/* File labels row — click a label to select the whole lane.
              Lane-select is the prerequisite for "delete entire file"
              (toolbar Delete / Del key remove all its windows + drop the
              file from laneFiles). */}
          <div className="relative select-none" style={{ height: FILE_LABEL_HEIGHT_PX, marginTop: 6, flexShrink: 0 }}>
            {lanes.map((lane) => {
              const laneSelected = selectedLaneFileSet.has(lane.file) || selectedLaneFile === lane.file
              const importHighlighted = laneMatchesImportSelection(lane)
              return (
              <div
                key={lane.file}
                onPointerDown={(e) => handleLaneHeaderPointerDown(e, lane)}
                onClick={(e) => {
                  e.stopPropagation()
                  if (laneHeaderDidDragRef.current) return
                  onSelectLaneFile?.(lane.file, e.shiftKey)
                }}
                style={{
                  position: 'absolute',
                  left: lane.offsetSec * pxPerSec + lane.gapPxBefore,
                  width: lane.duration * pxPerSec,
                  top: 0,
                  bottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '0 6px',
                  overflow: 'hidden',
                  cursor: onReorderLane ? 'grab' : onSelectLaneFile ? 'pointer' : 'default',
                  background: laneSelected
                    ? 'rgba(29,78,216,0.35)'
                    : importHighlighted
                      ? 'rgba(59,130,246,0.22)'
                      : 'transparent',
                  borderRadius: 3,
                  transition: 'background 100ms ease-out',
                  font: "600 10.5px/1 'JetBrains Mono', Consolas, monospace",
                  color: 'rgba(255,255,255,0.85)',
                  whiteSpace: 'nowrap',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: `hsl(${hueFor(lane.file)} 55% 55%)`,
                    flexShrink: 0,
                  }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.name}</span>
                <span style={{ color: 'rgba(255,255,255,0.35)', fontWeight: 500 }}>· {formatDuration(lane.duration)}</span>
              </div>
              )
            })}
          </div>

          {/* Playhead handle row — triangle size constant; red drop-shadow
              gives the visual emphasis when clamped to viewport edge. */}
          <div className="relative select-none" style={{ height: 10, flexShrink: 0 }}>
            {renderedPlayheadPx !== null && (
              <div
                className="absolute top-0 z-40"
                data-playhead-control=""
                style={{
                  left: renderedPlayheadPx,
                  transform: 'translateX(-50%)',
                  width: 28,
                  height: 18,
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'center',
                  cursor: 'ew-resize',
                  pointerEvents: playheadDragBlocked ? 'none' : 'auto',
                }}
                onMouseDown={handlePlayheadMouseDown}
              >
                <div
                  style={{
                    width: 0,
                    height: 0,
                    borderLeft: '8px solid transparent',
                    borderRight: '8px solid transparent',
                    borderTop: '12px solid var(--playhead-color, #dc2626)',
                    filter: playheadIsClamped
                      ? 'drop-shadow(0 0 6px rgba(220,38,38,0.85)) drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
                      : 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
                    transition: 'filter 120ms ease-out',
                  }}
                />
              </div>
            )}
          </div>

          {/* Video-lane pan scope. */}
          <div ref={panScopeRef} style={{ display: 'contents' }}>

          {/* Track area */}
          <div
            className="relative select-none"
            data-trim-scope=""
            style={{
              height: TRACK_HEIGHT_PX,
              marginBottom: 10,
              cursor: trackCursor,
              flexShrink: 0,
              // 上下对称 4px 实色分割线 (用户 2026-05-13 要求)。
              // 原本顶部只有 1px 半透明,底部 3px,视觉重心偏底。
              borderTop: '4px solid var(--track-border, #e8e6de)',
              borderBottom: '4px solid var(--track-border, #e8e6de)',
            }}
            onMouseDown={handleTrackMouseDown}
            onMouseMove={(e) => {
              // Trim cursor is shown only on the actual edge handle when
              // it is armed — see SegmentWindow's edge-handle render.
              ;(e.currentTarget as HTMLElement).style.cursor = trackCursor
            }}
            onClick={(e) => { if (e.target === e.currentTarget) onSelectIdx(null) }}
          >
            {/* Lane gap fills — solid black 5px strips between adjacent
                lanes (vertical seam aligned with the cover bar above). */}
            {lanes.slice(1).map((lane) => (
              <div
                key={`lane-gap-track-${lane.file}`}
                style={{
                  position: 'absolute',
                  left: lane.offsetSec * pxPerSec + lane.gapPxBefore - LANE_GAP_PX,
                  width: LANE_GAP_PX,
                  top: 0, bottom: 0,
                  backgroundImage: 'repeating-linear-gradient(to bottom, var(--track-border, #e8e6de) 0 8px, transparent 8px 14px)',
                  pointerEvents: 'none',
                  zIndex: 25,
                }}
              />
            ))}
            {/* Lane regions — pure-CSS filmstrip (fogged = discarded banner) */}
            {lanes.map((lane, li) => (
              <div
                key={`region-${lane.file}`}
                style={{
                  position: 'absolute',
                  left: lane.offsetSec * pxPerSec + lane.gapPxBefore,
                  width: lane.duration * pxPerSec,
                  top: 0,
                  bottom: 0,
                  overflow: 'hidden',
                  borderLeft: li > 0 ? 'none' : '1px solid rgb(var(--border-subtle))',
                  borderRight: li === lanes.length - 1 ? '1px solid rgb(var(--border-subtle))' : 'none',
                  boxShadow: laneMatchesImportSelection(lane)
                    ? 'inset 0 0 0 2px var(--file-row-active-border), 0 0 0 1px rgba(0,0,0,0.18)'
                    : 'none',
                  zIndex: laneMatchesImportSelection(lane) ? 4 : 1,
                }}
              >
                <FilmStrip hue={hueFor(lane.file)} fogged filePath={lane.sourceFile} durationSec={lane.duration} widthPx={Math.round(lane.duration * pxPerSec)} folder={folder} />
              </div>
            ))}


            {/* Kept segment windows — sit flush with the track (glass cutouts) */}
            {lanes.map((lane) => {
              const sorted = lane.segments
              return sorted.map(({ seg, globalIdx }, i) => {
                const prev = sorted[i - 1]?.seg
                const next = sorted[i + 1]?.seg
                const minStart = prev ? prev.end : 0
                const maxEnd = next ? next.start : lane.duration
                const visStart = Math.max(0, Math.min(seg.start, lane.duration))
                const left = (lane.offsetSec + visStart) * pxPerSec + lane.gapPxBefore
                const isIntro = globalIdx === -1
                return (
                  <SegmentWindow
                    key={isIntro ? 'intro-pseudo' : globalIdx}
                    seg={seg}
                    globalIdx={globalIdx}
                    left={left}
                    pxPerSec={pxPerSec}
                    laneFile={lane.file}
                    laneDuration={lane.duration}
                    laneOffsetSec={lane.offsetSec}
                    /* INTRO has its own selection state so Delete and
                       resize gates behave like a normal timeline window. */
                    selected={isIntro
                      ? introSelected
                      : selectedIdxSet.has(globalIdx) || selectedIdx === globalIdx}
                    canResize={activeResizeIdx === globalIdx}
                    minStart={minStart}
                    maxEnd={maxEnd}
                    mode={mode}
                    isIntro={isIntro}
                    onSelect={(additive) => {
                      if (isIntro) onSelectIntro?.(additive)
                      else onSelectIdx(globalIdx, additive)
                    }}
                    onSplitClick={handleWindowSplitClick}
                    onResize={(_idx, edge, val) => {
                      if (isIntro) onIntroResize?.(edge, val)
                      else handleResize(_idx, edge, val)
                    }}
                    onMove={(_idx, s, e) => {
                      if (isIntro) onIntroMove?.(s, e)
                      else handleMove(_idx, s, e)
                    }}
                    onLiveChange={handleLiveChange}
                    onLiveEnd={handleLiveEnd}
                    folder={folder}
                  />
                )
              })
            })}

            {/* Create preview */}
            {createRect && (
              <div
                style={{
                  position: 'absolute',
                  left: createRect.left,
                  width: createRect.width,
                  top: 0,
                  bottom: 0,
                  zIndex: 4,
                  border: '2px dashed #22c55e',
                  borderRadius: 2,
                  background: 'rgba(34,197,94,0.18)',
                  pointerEvents: 'none',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: '50%', left: '50%',
                    transform: 'translate(-50%,-50%)',
                    font: "600 11px/1 'JetBrains Mono', Consolas, monospace",
                    color: '#16a34a',
                    whiteSpace: 'nowrap',
                  }}
                >
                  + New window
                </div>
              </div>
            )}

            {/* Split cursor */}
            {mode === 'split' && (
              <SplitCursor
                containerRef={containerRef}
                scrollRef={scrollRef}
                snapPx={displayPlayheadPx}
                snapHalfPx={PLAYHEAD_HALF}
              />
            )}

            {/* Playhead red vertical line — width is constant so layout
                doesn't shift on clamp flicker. translateX(-50%) centres
                the inner 3 px stripe on renderedPlayheadPx. */}
            {renderedPlayheadPx !== null && (
              <div
                className="absolute z-40"
                data-playhead-control=""
                style={{
                  left: renderedPlayheadPx,
                  top: 0,
                  bottom: -12,
                  transform: 'translateX(-50%)',
                  width: 26,
                  cursor: 'ew-resize',
                  pointerEvents: playheadDragBlocked ? 'none' : 'auto',
                }}
                onMouseDown={handlePlayheadMouseDown}
              >
                <div
                  style={{
                    position: 'absolute', left: '50%', transform: 'translateX(-50%)',
                    top: 0, bottom: 12, width: 3,
                    background: 'var(--playhead-color, #dc2626)',
                    boxShadow: playheadIsClamped
                      ? '0 0 0 1px rgba(0,0,0,0.55), 0 0 8px 2px rgba(220,38,38,0.7)'
                      : '0 0 0 1px rgba(0,0,0,0.55), 0 0 4px rgba(0,0,0,0.4)',
                    transition: 'box-shadow 120ms ease-out',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    bottom: 0,
                    transform: 'translateX(-50%)',
                    width: 16,
                    height: 12,
                    background: 'var(--playhead-color, #dc2626)',
                    clipPath: 'polygon(50% 0, 0 100%, 100% 100%)',
                    filter: playheadIsClamped
                      ? 'drop-shadow(0 0 6px rgba(220,38,38,0.85)) drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
                      : 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
                  }}
                />
              </div>
            )}

          </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SplitCursor({
  containerRef, scrollRef, snapPx, snapHalfPx,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  scrollRef: React.RefObject<HTMLDivElement | null>
  snapPx: number | null
  snapHalfPx: number
}) {
  const [xPx, setXPx] = useState<number | null>(null)
  useEffect(() => {
    const el = containerRef.current; if (!el) return
    const onMove = (e: MouseEvent) => {
      const s = scrollRef.current; if (!s) return
      const rect = s.getBoundingClientRect()
      const px = e.clientX - rect.left + s.scrollLeft
      setXPx(snapPx !== null && Math.abs(px - snapPx) <= snapHalfPx ? snapPx : px)
    }
    const onLeave = () => setXPx(null)
    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
    }
  }, [containerRef, scrollRef, snapPx, snapHalfPx])
  if (xPx === null) return null
  return (
    <div
      style={{
        position: 'absolute',
        left: xPx,
        top: -4,
        bottom: -4,
        width: 1,
        background: '#dc2626',
        pointerEvents: 'none',
        zIndex: 6,
        opacity: 0.75,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: -2, left: -4,
          width: 0, height: 0,
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderTop: '6px solid #dc2626',
        }}
      />
    </div>
  )
}

interface WindowProps {
  seg: Segment
  globalIdx: number
  // INTRO renders through the same SegmentWindow but in purple. Drag,
  // resize, edge handles, hit zones, time-label bar — all identical to
  // a body window; only the outline / badge colour swap.
  isIntro?: boolean
  left: number
  pxPerSec: number
  laneFile: string
  laneDuration: number
  laneOffsetSec: number
  selected: boolean
  canResize: boolean
  minStart: number
  maxEnd: number
  mode: TimelineMode
  onSelect: (additive?: boolean) => void
  onSplitClick: (e: React.MouseEvent, segIdx: number) => void
  onResize: (globalIdx: number, edge: 'start' | 'end', newVal: number) => void
  onMove: (globalIdx: number, newStart: number, newEnd: number) => void
  // Realtime drag feedback (uncommitted) so the cover bar can stay in sync.
  onLiveChange?: (globalIdx: number, start: number, end: number) => void
  onLiveEnd?: (globalIdx: number) => void
  folder?: string | null
  // True while user holds Shift — trim handle hit-area becomes active
  // (pointerEvents=auto). Without Shift the handle is transparent so
  // mousedown 边界附近 passes through to playhead drag below.
}

function SegmentWindow({
  seg, globalIdx, isIntro = false, left, pxPerSec, laneFile, laneDuration, selected,
  canResize, minStart, maxEnd, mode, onSelect, onSplitClick, onResize, onMove,
  onLiveChange, onLiveEnd, folder,
}: WindowProps) {
  // Colour palette swap — purple for INTRO, blue for body. Used by the
  // selected outline + tint + boxShadow + (in INTRO) the always-on badge.
  const ACCENT = isIntro ? '#a855f7' : '#1d4ed8'
  const ACCENT_TINT = isIntro ? 'rgba(168,85,247,0.12)' : 'rgba(37,99,235,0.12)'
  const ACCENT_SHADOW = isIntro ? 'rgba(168,85,247,0.35)' : 'rgba(37,99,235,0.3)'
  const COMPACT_BG = isIntro
    ? 'linear-gradient(180deg, #6d3aa8 0%, #4c2378 100%)'
    : 'linear-gradient(180deg, #34788a 0%, #215568 100%)'
  const segmentEdgeColor = isIntro ? 'rgba(225,190,255,0.86)' : 'rgba(151,229,238,0.82)'
  const [liveStart, setLiveStart] = useState(seg.start)
  const [liveEnd, setLiveEnd] = useState(seg.end)
  const [livePxLeft, setLivePxLeft] = useState<number | null>(null)
  const [dragMode, setDragMode] = useState<'start' | 'end' | 'move' | null>(null)
  const [hoverEdge, setHoverEdge] = useState<'start' | 'end' | null>(null)
  const [resizeTip, setResizeTip] = useState<{ x: number; y: number; delta: number } | null>(null)

  useEffect(() => {
    if (!dragMode) {
      const id = window.setTimeout(() => {
        setLiveStart(seg.start); setLiveEnd(seg.end); setLivePxLeft(null)
      }, 0)
      return () => window.clearTimeout(id)
    }
  }, [seg.start, seg.end, dragMode])

  const visualEnd = Math.min(liveEnd, laneDuration)
  const visualStart = Math.max(0, Math.min(liveStart, visualEnd))
  const rawLiveWidth = Math.max(0, (visualEnd - visualStart) * pxPerSec)
  const liveWidth = Math.max(MIN_WIN_PX, rawLiveWidth)
  const timeLeft = livePxLeft !== null ? livePxLeft : left
  const timeRight = timeLeft + rawLiveWidth
  const displayLeft = dragMode === 'start' && rawLiveWidth < liveWidth
    ? timeRight - liveWidth
    : timeLeft
  const duration = liveEnd - liveStart
  const laneWidthPx = laneDuration * pxPerSec
  const compact = liveWidth < COMPACT_WIN_PX
  const edgeInsidePx = Math.max(3, Math.min(20, liveWidth / 2))
  const edgeOutsidePx = Math.max(4, Math.min(12, liveWidth / 3))
  const trimHoverActive = mode === 'pointer' && canResize && hoverEdge !== null
  const themeEdgeColor = 'var(--track-border, #e8e6de)'
  const outlineColor = isIntro ? ACCENT : themeEdgeColor
  const selectedEdgeColor = isIntro ? 'rgb(216 180 254)' : 'rgb(103 232 249)'
  const windowOutline = selected
    ? `1px solid ${selectedEdgeColor}`
    : (!selected && isIntro)
      ? `1px solid ${outlineColor}`
      : 'none'
  const windowShadow = selected
    ? (isIntro
      ? '0 0 0 1px rgba(216,180,254,0.65), 0 0 12px rgba(168,85,247,0.28)'
      : '0 0 0 1px rgba(103,232,249,0.72), 0 0 12px rgba(34,211,238,0.30)')
    : isIntro
      ? `0 0 0 1px ${ACCENT_SHADOW}`
      : 'none'
  const selectionTint = selected
    ? (isIntro ? 'rgba(168,85,247,0.16)' : 'rgba(56,189,248,0.16)')
    : isIntro
      ? ACCENT_TINT
      : 'transparent'
  const selectedEdgeWidth = 3
  const selectedEdgeHalf = selectedEdgeWidth / 2

  useEffect(() => {
    if (dragMode) return
    if (!trimHoverActive) {
      document.body.style.cursor = ''
      return
    }
    const isDarkNow = document.documentElement.getAttribute('data-theme') === 'dark'
    document.body.style.cursor = trimCursorNeutral(isDarkNow ? '%2360a5fa' : '%23f7f5ef')
  }, [dragMode, trimHoverActive])

  useEffect(() => () => {
    document.body.style.cursor = ''
  }, [])

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent, edge: 'start' | 'end') => {
      // Resize gate: only when this window is already selected AND user
      // holds Shift. Without Shift the event bubbles → playhead / window
      // body get the click, so边界附近的高频 playhead 操作不会误触 trim
      // (用户 2026-05-12 选 A 方案)。Trim 破坏 EDL,加 Shift 修饰符合
      // "破坏性需仪式" 原则。
      if (mode !== 'pointer') return
      if (!canResize) return
      e.stopPropagation(); e.preventDefault()
      const startX = e.clientX, origStart = seg.start, origEnd = seg.end
      setDragMode(edge)
      const isDarkNow = document.documentElement.getAttribute('data-theme') === 'dark'
      const curColor = isDarkNow ? '%2360a5fa' : '%23f7f5ef'
      const compute = (ev: MouseEvent): number => {
        const dx = ev.clientX - startX
        const d = dx / pxPerSec
        if (edge === 'start') return Math.max(minStart, Math.min(origStart + d, origEnd - MIN_SEG_DURATION))
        return Math.min(maxEnd, Math.max(origEnd + d, origStart + MIN_SEG_DURATION))
      }
      const apply = (v: number) => {
        if (edge === 'start') {
          setLiveStart(v); setLivePxLeft(left + (v - origStart) * pxPerSec)
          onLiveChange?.(globalIdx, v, origEnd)
        } else {
          setLiveEnd(v)
          onLiveChange?.(globalIdx, origStart, v)
        }
      }
      document.body.style.cursor = trimCursorNeutral(curColor)
      lockTextSelect()
      const onMove = (ev: MouseEvent) => {
        const v = compute(ev)
        apply(v)
        setResizeTip({
          x: ev.clientX,
          y: ev.clientY,
          delta: edge === 'start' ? origStart - v : v - origEnd,
        })
      }
      const onUp = (ev: MouseEvent) => {
        const f = compute(ev)
        apply(f); onResize(globalIdx, edge, f)
        onLiveEnd?.(globalIdx)
        setResizeTip(null)
        document.body.style.cursor = ''
        unlockTextSelect()
        requestAnimationFrame(() => setDragMode(null))
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [pxPerSec, seg.start, seg.end, globalIdx, onResize, minStart, maxEnd, left, mode, onLiveChange, onLiveEnd, canResize],
  )

  const handleBodyMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 1 || !e.shiftKey) return
      if (!selected) onSelect(false)
      e.stopPropagation(); e.preventDefault()
      const startX = e.clientX, origStart = seg.start, origEnd = seg.end
      const dur = origEnd - origStart
      const lo = minStart, hi = maxEnd - dur
      setDragMode('move')
      const compute = (ev: MouseEvent) => {
        const dx = ev.clientX - startX
        const s = Math.max(lo, Math.min(hi, origStart + dx / pxPerSec))
        return { s, e: s + dur }
      }
      const apply = ({ s, e }: { s: number; e: number }) => {
        setLiveStart(s); setLiveEnd(e); setLivePxLeft(left + (s - origStart) * pxPerSec)
        onLiveChange?.(globalIdx, s, e)
      }
      lockTextSelect()
      const handleMove = (ev: MouseEvent) => apply(compute(ev))
      const handleUp = (ev: MouseEvent) => {
        if (ev.button !== 1) return
        const f = compute(ev); apply(f); onMove(globalIdx, f.s, f.e)
        onLiveEnd?.(globalIdx)
        unlockTextSelect()
        requestAnimationFrame(() => setDragMode(null))
        window.removeEventListener('mousemove', handleMove)
        window.removeEventListener('mouseup', handleUp)
      }
      window.addEventListener('mousemove', handleMove)
      window.addEventListener('mouseup', handleUp)
    },
    [pxPerSec, seg.start, seg.end, globalIdx, onMove, minStart, maxEnd, left, onLiveChange, onLiveEnd, onSelect, selected],
  )

  return (
    <div
      className={cn('absolute group', (dragMode || selected) ? 'z-20' : 'z-10')}
      data-seg-idx={globalIdx}
      data-trim-scope=""
      style={{
        left: displayLeft,
        top: 0,          // flush with track
        bottom: 0,       // flush with track
        width: liveWidth,
        cursor: mode === 'split' ? 'crosshair' : dragMode === 'move' ? 'grabbing' : 'default',
        transform: selected && !dragMode ? 'translateY(-1px)' : 'none',
        transformOrigin: 'center center',
        transition: dragMode ? 'none' : 'transform 80ms ease, filter 80ms ease',
      }}
      onMouseDown={handleBodyMouseDown}
      onMouseMove={(e) => {
        const el = e.currentTarget as HTMLElement
        if (mode === 'pointer' && canResize) {
          const rect = el.getBoundingClientRect()
          const x = e.clientX - rect.left
          const hit = Math.max(3, Math.min(20, rect.width / 2))
          const nextEdge = x <= hit ? 'start' : rect.width - x <= hit ? 'end' : null
          setHoverEdge((cur) => (cur === nextEdge ? cur : nextEdge))
          el.style.cursor = nextEdge ? 'ew-resize' : 'default'
          return
        }
        setHoverEdge((cur) => (cur === null ? cur : null))
        el.style.cursor = mode === 'split' ? 'crosshair' : 'default'
      }}
      onMouseLeave={(e) => {
        setHoverEdge(null)
        ;(e.currentTarget as HTMLElement).style.cursor = 'default'
      }}
      onClick={(e) => {
        if (mode === 'split') { onSplitClick(e, globalIdx); return }
        e.stopPropagation(); onSelect(e.shiftKey)
      }}
      onContextMenu={(e) => {
        if (mode !== 'split') onSelect(e.shiftKey)
      }}
    >
      <div
        style={{
          position: 'absolute', inset: 0,
          borderRadius: 2,
          overflow: 'hidden',
          // Border thickness is fixed (2px transparent → 2px blue when
          // selected) so the inner content area never resizes on select.
          // Resizing the inner box would force FilmStrip's ResizeObserver
          // to recompute frame width and re-fetch all thumbnails — that's
          // the "frames flicker on select" bug.
          border: '2px solid transparent',
          // INTRO stays visually distinct even when it is not selected.
          outline: windowOutline,
          outlineOffset: -2,
          boxShadow: windowShadow,
          background: compact ? COMPACT_BG : 'transparent',
          filter: compact ? 'saturate(1.05)' : 'none',
        }}
      >
        {compact && (
          <>
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -1px 0 rgba(0,0,0,0.45)',
              }}
            />
            <div
              className="absolute left-0 right-0 top-0 pointer-events-none"
              style={{
                height: 2,
                background: isIntro ? 'rgba(225,190,255,0.86)' : 'rgba(151,229,238,0.82)',
              }}
            />
            <span
              className="absolute inset-0 pointer-events-none"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                font: "800 8px/1 'JetBrains Mono', Consolas, monospace",
                color: 'rgba(255,255,255,0.92)',
                letterSpacing: 0,
              }}
            >
              {isIntro ? 'I' : ''}
            </span>
          </>
        )}
        {!compact && (
          <>
            {/* Glass layer — un-fogged filmstrip aligned to lane origin */}
            <div
              style={{
                position: 'absolute',
                top: 0, bottom: 0,
                left: -visualStart * pxPerSec,
                width: laneWidthPx,
                pointerEvents: 'none',
              }}
            >
              <FilmStrip hue={hueFor(laneFile)} fogged={false} filePath={seg.file} durationSec={laneDuration} widthPx={Math.round(laneWidthPx)} folder={folder} />
            </div>
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: selectionTint }}
            />
            {isIntro && (
              <span
                className="absolute z-10 pointer-events-none"
                style={{
                  top: 4, left: 6,
                  font: "700 9px/1 'JetBrains Mono', Consolas, monospace",
                  color: '#fff',
                  background: ACCENT,
                  padding: '2px 5px',
                  borderRadius: 2,
                  letterSpacing: '0.06em',
                }}
              >
                INTRO
              </span>
            )}
            <div
              className="absolute bottom-0 left-0 right-0 px-1 py-0.5 flex items-center justify-between pointer-events-none z-10"
              style={{ background: 'rgba(0,0,0,0.55)' }}
            >
              <span className="tabular-nums truncate" style={{ font: "600 9px/1.2 'JetBrains Mono', Consolas, monospace", color: 'rgba(255,255,255,0.92)' }}>
                {formatDuration(liveStart)} - {formatDuration(liveEnd)}
              </span>
              <span className="tabular-nums" style={{ font: "500 9px/1.2 'JetBrains Mono', Consolas, monospace", color: 'rgba(255,255,255,0.7)', marginLeft: 4 }}>
                {formatDuration(duration)}
              </span>
            </div>
          </>
        )}

      </div>

      {selected && (
        <>
          <div
            className="absolute pointer-events-none z-30"
            aria-hidden
            style={{
              top: 0,
              bottom: 0,
              left: -selectedEdgeHalf,
              width: selectedEdgeWidth,
              background: selectedEdgeColor,
              borderRadius: 3,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.24)',
            }}
          />
          <div
            className="absolute pointer-events-none z-30"
            aria-hidden
            style={{
              top: 0,
              bottom: 0,
              right: -selectedEdgeHalf,
              width: selectedEdgeWidth,
              background: selectedEdgeColor,
              borderRadius: 3,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.24)',
            }}
          />
        </>
      )}

      {mode === 'pointer' && (
        <>
          {/* Black edge — start.
              Visual: 2px hairline straddling the time boundary (1px outside
              / 1px inside) — adjacent windows' visuals overlap pixel-perfect
              for a single 2px line at the boundary, matching the lane's
              normal seam thickness.
              Hit zone: 5px INSIDE this window (separate transparent layer
              over the visual), live only when the window is selected.
              Unselected → mousedown falls through to SegmentWindow body
              (= select). 5px+5px = 10px hit per window total. */}
          <div
            className="absolute top-0 bottom-0 pointer-events-none z-30"
            aria-hidden
            style={{
              left: -1,
              width: 2,
              background: selected ? 'transparent' : segmentEdgeColor,
            }}
          />
          <div
            className="absolute top-0 bottom-0 z-30"
            data-edge="start"
            data-trim-scope=""
            style={{
              left: -edgeOutsidePx,
              width: edgeOutsidePx + edgeInsidePx,
              cursor: canResize ? 'ew-resize' : 'default',
              // 无 Shift 时 pointerEvents=none,让 mousedown 穿透到下层的
              // playhead drag 区域,边界附近的高频 playhead 操作不再被
              // trim handle 误抢(用户 2026-05-12 选 A 方案)。
              pointerEvents: canResize ? 'auto' : 'none',
              background: 'transparent',
            }}
            onMouseDown={(e) => handleResizeMouseDown(e, 'start')}
          />

          {/* Black edge — end. Mirror of the start edge. */}
          <div
            className="absolute top-0 bottom-0 pointer-events-none z-30"
            aria-hidden
            style={{
              right: -1,
              width: 2,
              background: selected ? 'transparent' : segmentEdgeColor,
            }}
          />
          <div
            className="absolute top-0 bottom-0 z-30"
            data-edge="end"
            data-trim-scope=""
            style={{
              right: -edgeOutsidePx,
              width: edgeOutsidePx + edgeInsidePx,
              cursor: canResize ? 'ew-resize' : 'default',
              pointerEvents: canResize ? 'auto' : 'none',
              background: 'transparent',
            }}
            onMouseDown={(e) => handleResizeMouseDown(e, 'end')}
          />
        </>
      )}
      {resizeTip && createPortal(
        <div
          style={{
            position: 'fixed',
            left: resizeTip.x + 12,
            top: resizeTip.y - 34,
            zIndex: 1000,
            pointerEvents: 'none',
            padding: '5px 8px',
            borderRadius: 6,
            background: 'rgb(var(--bg-surface) / 0.96)',
            border: '1px solid rgb(var(--border-strong) / 0.78)',
            boxShadow: '0 10px 28px rgba(0,0,0,0.26)',
            color: resizeTip.delta >= 0 ? '#16a34a' : '#dc2626',
            font: "700 11px/1 'JetBrains Mono', Consolas, monospace",
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {formatSignedMinutes(resizeTip.delta)}
        </div>,
        document.body,
      )}
    </div>
  )
}
