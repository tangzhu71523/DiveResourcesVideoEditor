import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SkipBack, SkipForward, Play, Pause, Volume2, VolumeX, Film, Maximize2, Minimize2 } from 'lucide-react'
import JASSUB from 'jassub'
import jassubWorkerUrl from 'jassub/dist/wasm/jassub-worker.js?url'
import jassubWasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url'
import jassubModernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url'
import { useLang } from '@/i18n/useLang'
import type { LogoOverlay, OverlayElement, Segment } from '@/types/edl'
import { DEFAULT_COVER_OVERLAY, DEFAULT_SMALL_OVERLAY } from '@/types/edl'
import Tooltip from '../ui/Tooltip'
import { makeAssAlwaysOn } from '@/lib/overlayAss'
import { getPreviewCacheStatus, loadSettings, previewCacheMp4Url, saveSettings, startPreviewCache } from '@/lib/api'
import type { PreviewCacheStatus } from '@/lib/api'
import { lockTextSelect, unlockTextSelect } from '@/lib/dragLock'

// 1:1 port of v5-app.jsx Preview component.
//   panel
//     ├─ black 16:9 video area (flex-1, centered)
//     └─ controls row (padding 8 12, gap 6):
//          skipBack · play(blue) · skipFwd · "mm:ss / mm:ss" · progress · sep · 1× · mute
// jassub overlay and API wiring added on top of the v5 visual.

interface Props {
  segment: Segment | null
  currentIdx: number | null
  total: number
  isSourcePreview?: boolean
  initialPaused?: boolean
  pendingSeek?: { offset: number; nonce: number } | null
  overlayAss?: string | null
  // HTML overlay (independent of jassub/ASS) — always renders so the user
  // sees the title + watermark even when the WASM/canvas path falls flat
  // on segment_stream playback.
  coverLines?: string[]
  smallLines?: string[]
  coverOverlay?: OverlayElement
  smallOverlay?: OverlayElement
  logoOverlay?: LogoOverlay
  // Called when the user drags a handle on cover/small text. Patch is
  // a partial OverlayElement with only the changed fields.
  onOverlayChange?: (target: 'cover' | 'small', patch: Partial<OverlayElement>) => void
  // Double-click overlay text → inline edit. Lets users tweak the title
  // / watermark text directly on the preview, useful when the INPUT
  // panel is hidden (fullscreen / expand mode).
  onLinesChange?: (kind: 'cover' | 'small', lines: string[]) => void
  onLogoOverlayChange?: (patch: Partial<LogoOverlay>) => void
  // Highlights which overlay the toolbar steppers act on.
  selectedOverlay?: 'cover' | 'small' | null
  onSelectOverlay?: (which: 'cover' | 'small') => void
  onNext: () => void
  onPlayheadChange?: (absoluteSec: number | null) => void
  // Notify parent (App.tsx) when video play state flips. Used to lock
  // the timeline playhead drag while playing.
  onPlayingChange?: (playing: boolean) => void
}

// Drag axes:
//   pos          — body drag → position
//   box-w-w/e    — left/right edge → box_width (asymmetric)
//   box-h-n/s    — top/bottom edge → line_spacing (asymmetric)
//   corner-*     — 4 bevels → x→box_width + y→line_spacing (independent;
//                  ratio follows pointer direction, opposite corner anchored)
type DragAxis =
  | 'pos'
  | 'box-w-w' | 'box-w-e'
  | 'box-h-n' | 'box-h-s'
  | 'corner-nw' | 'corner-ne' | 'corner-sw' | 'corner-se'

interface DragState {
  target: 'cover' | 'small'
  axis: DragAxis
  initial: OverlayElement
  startX: number
  startY: number
  pxToBaselineX: number  // baseline-px = screen-px / pxToBaselineX
  pxToBaselineY: number
  // Visual box at drag start (screen px). Drives the scale ratio so
  // mouse_drag/box_size = scale_increment, matching Canva/PPT feel.
  boxW: number
  boxH: number
  // Initial bbox of the text element + preview area (screen / viewport
  // coords). Used by position drag to clamp so text never escapes
  // preview edges.
  txtL: number; txtR: number; txtT: number; txtB: number
  prvL: number; prvR: number; prvT: number; prvB: number
  // Geometry of the underlying text content — used by edge / corner
  // drag to anchor the opposite edge/corner so the dragged side moves
  // alone (no mirror).
  maxChars: number
  nLines: number
}

const PLAYBACK_RATES = [1, 2, 3, 4, 5] as const

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00'
  const s = Math.floor(sec)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export default function PreviewBox({
  segment, pendingSeek, overlayAss, onNext, onPlayheadChange, onPlayingChange, isSourcePreview, initialPaused,
  coverLines = [], smallLines = [],
  coverOverlay = DEFAULT_COVER_OVERLAY,
  smallOverlay = DEFAULT_SMALL_OVERLAY,
  logoOverlay,
  onOverlayChange,
  onLinesChange,
  onLogoOverlayChange,
  selectedOverlay,
  onSelectOverlay,
}: Props) {
  const { t } = useLang()
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const fullscreenHostRef = useRef<HTMLDivElement>(null)
  // Live-measure the 16:9 preview area so we can convert screen-px deltas
  // back into 1080-baseline overlay values during drag.
  const previewAreaRef = useRef<HTMLDivElement>(null)
  const [, setPreviewSize] = useState<{ w: number; h: number }>({ w: 1920, h: 1080 })

  useLayoutEffect(() => {
    const el = previewAreaRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        setPreviewSize({ w: r.width, h: r.height })
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Armed = double-clicked overlay element, ready to drag/resize.
  // null = nothing armed (drag handles hidden, pointer-events on text are
  // none so video click-through still works).
  const [armed, setArmed] = useState<'cover' | 'small' | 'logo' | null>(null)
  // While dragging, show magenta center guide lines + snap when within 8 baseline-px.
  const [snapGuide, setSnapGuide] = useState<{ vCenter: boolean; hMiddle: boolean }>({ vCenter: false, hMiddle: false })
  const dragStateRef = useRef<DragState | null>(null)
  // Last accepted patch during current resize drag — if a subsequent
  // mousemove pushes text out of the preview area, we revert to this.
  const lastGoodPatchRef = useRef<Partial<OverlayElement> | null>(null)
  // True while a position drag is in progress — drives the faint canvas
  // center guide line (Canva-style alignment helper).
  const [posDragActive, setPosDragActive] = useState(false)

  // Disarm on Esc / segment change so the user is back to plain video click.
  useEffect(() => {
    const id = window.setTimeout(() => setArmed(null), 0)
    return () => window.clearTimeout(id)
  }, [segment])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArmed(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const startOverlayDrag = useCallback((
    e: React.MouseEvent,
    target: 'cover' | 'small',
    axis: DragAxis,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    const previewRect = previewAreaRef.current?.getBoundingClientRect()
    if (!previewRect) return
    // Find the text wrapper for this kind so we can measure its current
    // visual box — drives the scale ratio (mouseDelta / boxSize).
    const textEl = previewAreaRef.current?.querySelector(
      `[data-overlay-kind="${target}"]`,
    ) as HTMLElement | null
    const textRect = textEl?.getBoundingClientRect()
    const initial = target === 'cover' ? coverOverlay : smallOverlay
    const lines = (target === 'cover' ? coverLines : smallLines)
      .filter((l) => l != null && l.trim() !== '')
    const maxChars = Math.max(1, ...lines.map((l) => l.length))
    const nLines = Math.max(1, lines.length)
    dragStateRef.current = {
      target, axis, initial,
      startX: e.clientX,
      startY: e.clientY,
      pxToBaselineX: previewRect.width / 1920,
      pxToBaselineY: previewRect.height / 1080,
      boxW: textRect?.width ?? previewRect.width * 0.5,
      boxH: textRect?.height ?? previewRect.height * 0.5,
      txtL: textRect?.left ?? previewRect.left,
      txtR: textRect?.right ?? previewRect.right,
      txtT: textRect?.top ?? previewRect.top,
      txtB: textRect?.bottom ?? previewRect.bottom,
      prvL: previewRect.left,
      prvR: previewRect.right,
      prvT: previewRect.top,
      prvB: previewRect.bottom,
      maxChars,
      nLines,
    }
    // Seed the bound-check fallback with the starting state so the very
    // first overflow has somewhere to revert to.
    lastGoodPatchRef.current = {
      font_size: initial.font_size,
      line_spacing: initial.line_spacing,
      letter_spacing: initial.letter_spacing,
      position_x: initial.position_x,
      position_y: initial.position_y,
    }
    if (axis === 'pos') setPosDragActive(true)
    lockTextSelect()

    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

    const onMove = (ev: MouseEvent) => {
      const st = dragStateRef.current
      if (!st || !onOverlayChange) return
      const mouseDx = ev.clientX - st.startX
      const mouseDy = ev.clientY - st.startY

      // Left/right edge drag → letter_spacing. Mirror growth from the
      // text's own anchor (centre for cover, left for small) — textbox
      // tightly hugs content so anchor compensation isn't needed.
      if (st.axis === 'box-w-w' || st.axis === 'box-w-e') {
        const sx = st.axis === 'box-w-w' ? -1 : 1
        const dxBaseline = mouseDx / st.pxToBaselineX
        // 减速 25%:0.4 × 0.75 = 0.3,提高细微调节可控性
        const lsDelta = dxBaseline * sx * 0.3
        const newLs = clamp(st.initial.letter_spacing + lsDelta, 0, 22)
        onOverlayChange(st.target, {
          letter_spacing: Math.round(newLs * 10) / 10,
        })
        return
      }

      // Corner drag — uniform whole-textbox scale (the SOLE proportional
      // resize gesture now). font_size scales with diagonal outward
      // motion. Pointer direction biases letter_spacing vs line_spacing:
      // dx-dominant → letter spacing grows more; dy-dominant → line
      // spacing grows more. Opposite corner stays anchored.
      if (st.axis.startsWith('corner-')) {
        const corner = st.axis.slice('corner-'.length) as 'nw' | 'ne' | 'sw' | 'se'
        const sx = corner.includes('w') ? -1 : 1
        const sy = corner.includes('n') ? -1 : 1
        // 仅按对角外推/内收的合成幅度统一缩放字号,不再按鼠标方向
        // 偏置 letter_spacing / line_spacing。
        // 减速 25%:除以 1066(=800/0.75)等价乘 0.75
        const outAvg = (mouseDx * sx + mouseDy * sy) / 2
        const visualBase = Math.max(80, (st.boxW + st.boxH) / 2)
        const oldFs = st.initial.font_size > 0 ? st.initial.font_size : 12
        const fontScaleFactor = 1 + outAvg / visualBase
        const newFs = clamp(oldFs * fontScaleFactor, 12, 240)
        onOverlayChange(st.target, {
          font_size: Math.round(newFs),
        })
        return
      }

      // Top/bottom edge drag → line_spacing (extra px between lines).
      // Mirror growth — textbox auto-fits content, no anchor compensation.
      if (st.axis === 'box-h-n' || st.axis === 'box-h-s') {
        const sy = st.axis === 'box-h-n' ? -1 : 1
        const dyBaseline = mouseDy / st.pxToBaselineY
        const N_LINES = Math.max(1, st.nLines)
        // Each px drag → one line gets one px more line_spacing. Divide by
        // N to keep total height delta close to drag distance.
        // 减速 25%:乘 0.75
        const lineSpacingDeltaReq = (dyBaseline * sy * 0.75) / N_LINES
        const newLs = clamp(st.initial.line_spacing + lineSpacingDeltaReq, 0, 44)
        onOverlayChange(st.target, {
          line_spacing: Math.round(newLs),
        })
        return
      }

      // Position drag with true preview-edge clamp (text bbox can't cross
      // preview rect). Resize gestures are gone — font/line/letter/scale
      // now live on the toolbar -/+ controls.
      const lowDx = st.prvL - st.txtL
      const hiDx = st.prvR - st.txtR
      const lowDy = st.prvT - st.txtT
      const hiDy = st.prvB - st.txtB
      const dxScreen = lowDx <= hiDx
        ? clamp(mouseDx, lowDx, hiDx)
        : (mouseDx > 0 ? hiDx : lowDx)
      const dyScreen = lowDy <= hiDy
        ? clamp(mouseDy, lowDy, hiDy)
        : (mouseDy > 0 ? hiDy : lowDy)
      const dxClamped = dxScreen / st.pxToBaselineX
      const dyClamped = dyScreen / st.pxToBaselineY

      let nx = st.initial.position_x + dxClamped
      let ny = st.initial.position_y + dyClamped
      // 缩小吸附阈值,只有非常接近正中(±5 像素)时才贴中线;同时
      // 保留 0.1 像素的小数精度,避免 Math.round 引入的整像素跳动。
      let snapV = false
      let snapH = false
      if (Math.abs(nx) < 5) { nx = 0; snapV = true }
      if (Math.abs(ny) < 5) { ny = 0; snapH = true }
      setSnapGuide((prev) => (prev.vCenter === snapV && prev.hMiddle === snapH)
        ? prev
        : { vCenter: snapV, hMiddle: snapH })
      onOverlayChange(st.target, {
        position_x: Math.round(nx * 10) / 10,
        position_y: Math.round(ny * 10) / 10,
      })
    }
    const onUp = () => {
      dragStateRef.current = null
      lastGoodPatchRef.current = null
      setSnapGuide({ vCenter: false, hMiddle: false })
      setPosDragActive(false)
      unlockTextSelect()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [coverOverlay, smallOverlay, coverLines, smallLines, onOverlayChange])

  const [virtualOffset, setVirtualOffset] = useState(0)
  const [playbackRate, setPlaybackRate] = useState<number>(1)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlayingRaw] = useState(false)
  const isPlayingRef = useRef(false)
  const setIsPlaying = useCallback((v: boolean) => {
    isPlayingRef.current = v
    setIsPlayingRaw(v)
    onPlayingChange?.(v)
  }, [onPlayingChange])
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(() => {
    try {
      const raw = localStorage.getItem('dive_edit:volume')
      const v = raw ? parseFloat(raw) : NaN
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8
    } catch {
      return 0.8
    }
  })
  // Last non-zero volume — restored on unmute when current volume is 0,
  // and shown in the slider when the bar opens fresh.
  const [volumeCache, setVolumeCache] = useState(() => {
    try {
      const raw = localStorage.getItem('dive_edit:volume_cache')
      const v = raw ? parseFloat(raw) : NaN
      return Number.isFinite(v) && v > 0 ? Math.max(0, Math.min(1, v)) : 0.8
    } catch {
      return 0.8
    }
  })
  const settingsLoadedRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    loadSettings().then((settings) => {
      if (cancelled) return
      if (Number.isFinite(settings.volume)) {
        setVolume(Math.max(0, Math.min(1, Number(settings.volume))))
      }
      if (Number.isFinite(settings.volume_cache) && Number(settings.volume_cache) > 0) {
        setVolumeCache(Math.max(0, Math.min(1, Number(settings.volume_cache))))
      }
      settingsLoadedRef.current = true
    }).catch(() => {
      settingsLoadedRef.current = true
    })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    try { localStorage.setItem('dive_edit:volume', String(volume)) } catch { /* ignore */ }
    if (settingsLoadedRef.current) {
      void saveSettings({ volume }).catch(() => { /* keep localStorage fallback */ })
    }
  }, [volume])
  useEffect(() => {
    try { localStorage.setItem('dive_edit:volume_cache', String(volumeCache)) } catch { /* ignore */ }
    if (settingsLoadedRef.current) {
      void saveSettings({ volume_cache: volumeCache }).catch(() => { /* keep localStorage fallback */ })
    }
  }, [volumeCache])
  const [volOpen, setVolOpen] = useState(false)
  const [volPopup] = useState<{ x: number; y: number } | null>(null)
  const volRef = useRef<HTMLDivElement>(null)
  const volBtnRef = useRef<HTMLButtonElement>(null)
  const volDragging = useRef(false)
  const progressDraggingRef = useRef(false)
  const volHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const volLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [videoAspect, setVideoAspect] = useState<number>(16 / 9)
  const [videoSrc, setVideoSrc] = useState<string | null>(null)

  // Fullscreen state — drives Expand button icon. Listens to native
  // fullscreenchange so Esc-exit also flips the icon back.
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  // 全屏期间的浮层控件可见性:鼠标移动 → 显示三秒;静止则隐藏。
  const [fsControlsVisible, setFsControlsVisible] = useState(false)
  const fsHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fsPanelRef = useRef<HTMLDivElement>(null)
  const isInFsPanelHitArea = useCallback((clientX: number, clientY: number) => {
    const rect = fsPanelRef.current?.getBoundingClientRect()
    if (!rect) return false
    const pad = 5
    return clientX >= rect.left - pad
      && clientX <= rect.right + pad
      && clientY >= rect.top - pad
      && clientY <= rect.bottom + pad
  }, [])
  const hideFsControls = useCallback((delayMs = 0) => {
    if (fsHideTimerRef.current) clearTimeout(fsHideTimerRef.current)
    fsHideTimerRef.current = setTimeout(() => setFsControlsVisible(false), delayMs)
  }, [])
  const showFsControls = useCallback((hideDelayMs: number | null = 1600) => {
    setFsControlsVisible(true)
    if (fsHideTimerRef.current) clearTimeout(fsHideTimerRef.current)
    if (hideDelayMs !== null && isPlayingRef.current) {
      fsHideTimerRef.current = setTimeout(() => setFsControlsVisible(false), hideDelayMs)
    }
  }, [])
  const handleFullscreenMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isFullscreen) return
    if (!isPlayingRef.current) {
      showFsControls(null)
      return
    }
    if (volDragging.current || progressDraggingRef.current) {
      showFsControls(null)
      return
    }
    if (isInFsPanelHitArea(e.clientX, e.clientY)) {
      showFsControls(null)
    } else {
      hideFsControls(0)
    }
  }, [hideFsControls, isFullscreen, isInFsPanelHitArea, showFsControls])
  useEffect(() => {
    if (!isFullscreen) {
      hideFsControls(0)
      return
    }
    const id = window.setTimeout(() => {
      if (isPlaying) {
        hideFsControls(0)
      } else {
        showFsControls(null)
      }
    }, 0)
    return () => window.clearTimeout(id)
  }, [hideFsControls, isFullscreen, isPlaying, showFsControls])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { /* noop */ })
      return
    }
    // Fullscreen the WRAPPER (previewAreaRef) so the HTML overlay layers
    // (cover/small text + logo) come along — fullscreening the bare
    // <video> hides them. Synchronous call only — any async/await/.then()
    // between user gesture and requestFullscreen (or any blocking modal)
    // consumes the user activation token. Fallback to <video> if wrapper
    // unavailable, then to webkitEnterFullscreen for old Safari.
    const wrapper = fullscreenHostRef.current ?? previewAreaRef.current
    if (wrapper && typeof wrapper.requestFullscreen === 'function') {
      wrapper.requestFullscreen().catch(() => { /* noop */ })
      return
    }
    const vid = videoRef.current as
      (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    if (!vid) return
    if (typeof vid.requestFullscreen === 'function') {
      vid.requestFullscreen().catch(() => { /* noop */ })
    } else if (typeof vid.webkitEnterFullscreen === 'function') {
      vid.webkitEnterFullscreen()
    }
  }
  const isFirstLoad = useRef(true)
  const shouldAutoPlayNext = useRef(false)

  const segDuration = segment ? segment.end - segment.start : 0
  const pendingSeekRef = useRef(pendingSeek)
  const lastSeekNonceRef = useRef<number | null>(null)
  useEffect(() => {
    pendingSeekRef.current = pendingSeek
  }, [pendingSeek])

  const buildSrc = useCallback((seg: Segment, offset: number): string => {
    const clamped = Math.max(0, Math.min(offset, seg.end - seg.start))
    return `/api/segment_stream?file=${encodeURIComponent(seg.file)}&start=${seg.start + clamped}&end=${seg.end}`
  }, [])

  // Native seek mode: when the source video has a cached H.264 MP4, play it
  // directly so <video>.currentTime seeks instantly. While that full-file
  // proxy builds, first preview uses the short segment stream so clicking a
  // window does not start an expensive whole-video transcode immediately.
  const [useNative, setUseNative] = useState(false)
  const [previewCacheStatus, setPreviewCacheStatus] = useState<PreviewCacheStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const pending = pendingSeekRef.current
    const initialOffset = segment && pending && lastSeekNonceRef.current !== pending.nonce
      ? Math.max(0, Math.min(pending.offset, segment.end - segment.start))
      : 0
    const resetTimer = window.setTimeout(() => {
      if (!cancelled) {
        setVirtualOffset(initialOffset)
        setCurrentTime(0)
      }
    }, 0)
    if (!segment) {
      const clearTimer = window.setTimeout(() => {
        if (!cancelled) {
          setVideoSrc(null); setUseNative(false); setPreviewCacheStatus(null); setIsPlaying(false)
        }
      }, 0)
      return () => {
        cancelled = true
        window.clearTimeout(resetTimer)
        window.clearTimeout(clearTimer)
      }
    }
    if (segment.file.trim() === '') {
      // Invalid segment guard.
      const clearTimer = window.setTimeout(() => {
        if (!cancelled) {
          setUseNative(false)
          setVideoSrc(null)
          setPreviewCacheStatus(null)
        }
      }, 0)
      return () => {
        cancelled = true
        window.clearTimeout(resetTimer)
        window.clearTimeout(clearTimer)
      }
    }
    const prepareTimer = window.setTimeout(() => {
      if (!cancelled) {
        setUseNative(false)
        setVideoSrc(buildSrc(segment, initialOffset))
        setPreviewCacheStatus(null)
      }
    }, 0)
    let warmTimer: number | null = null
    // Try cache first. If missing, use the short segment stream immediately.
    // Only build a proxy after the user stays on this window for a while.
    ;(async () => {
      const status = await getPreviewCacheStatus(segment.file)
      if (cancelled) return
      setPreviewCacheStatus(status)
      if (status.ready) {
        setUseNative(true)
        setVideoSrc(previewCacheMp4Url(segment.file))
      } else {
        setUseNative(false)
        setVideoSrc(buildSrc(segment, initialOffset))
        warmTimer = window.setTimeout(() => {
          startPreviewCache(segment.file, 95).then((next) => {
            if (!cancelled) setPreviewCacheStatus(next)
          }).catch(() => { /* noop */ })
        }, 5000)
        setPreviewCacheStatus(status)
      }
    })()
    return () => {
      cancelled = true
      window.clearTimeout(resetTimer)
      window.clearTimeout(prepareTimer)
      if (warmTimer !== null) window.clearTimeout(warmTimer)
    }
  }, [segment, buildSrc, isSourcePreview, setIsPlaying])

  useEffect(() => {
    if (!segment || useNative || segment.file.trim() === '') return
    let cancelled = false
    const timer = window.setInterval(() => {
      getPreviewCacheStatus(segment.file).then((status) => {
        if (cancelled) return
        setPreviewCacheStatus(status)
        if (!status.ready) return
        setUseNative(true)
        setVideoSrc(previewCacheMp4Url(segment.file))
      }).catch(() => { /* keep segment stream */ })
    }, 1200)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [segment, useNative])
  useEffect(() => {
    const v = videoRef.current
    if (v) v.playbackRate = playbackRate
  }, [playbackRate, videoSrc])

  useEffect(() => {
    const v = videoRef.current
    if (v) { v.muted = muted; v.volume = volume }
  }, [muted, volume, videoSrc])

  const cancelLeave = useCallback(() => {}, [])
  const cancelHover = useCallback(() => {}, [])
  const scheduleLeave = useCallback(() => {}, [])
  const armVolPopupHover = useCallback(() => {}, [])

  const scheduleVolumeOpen = useCallback(() => {
    if (volLeaveTimerRef.current) {
      clearTimeout(volLeaveTimerRef.current)
      volLeaveTimerRef.current = null
    }
    if (volOpen || volHoverTimerRef.current) return
    volHoverTimerRef.current = setTimeout(() => {
      volHoverTimerRef.current = null
      setVolOpen(true)
    }, 600)
  }, [volOpen])

  const scheduleVolumeClose = useCallback(() => {
    if (volHoverTimerRef.current) {
      clearTimeout(volHoverTimerRef.current)
      volHoverTimerRef.current = null
    }
    if (volDragging.current) return
    if (volLeaveTimerRef.current) clearTimeout(volLeaveTimerRef.current)
    volLeaveTimerRef.current = setTimeout(() => {
      volLeaveTimerRef.current = null
      setVolOpen(false)
    }, 180)
  }, [])

  useEffect(() => {
    return () => {
      if (volHoverTimerRef.current) clearTimeout(volHoverTimerRef.current)
      if (volLeaveTimerRef.current) clearTimeout(volLeaveTimerRef.current)
    }
  }, [])

  const setClampedVolume = useCallback((nextRaw: number) => {
    const next = Math.max(0, Math.min(1, nextRaw))
    setVolume(next)
    if (next > 0) setVolumeCache(next)
  }, [])

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      if (m && volume === 0) setVolume(volumeCache > 0 ? volumeCache : 0.8)
      return !m
    })
  }, [volume, volumeCache])

  const changeVolumeByWheel = useCallback((deltaY: number) => {
    setClampedVolume(volume + (deltaY > 0 ? -0.05 : 0.05))
  }, [setClampedVolume, volume])

  const applyVolumeAt = useCallback((trackEl: HTMLElement, clientX: number, clientY: number) => {
    const rect = trackEl.getBoundingClientRect()
    const axis = trackEl.dataset.volAxis
    const pct = axis === 'x'
      ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      : 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    setClampedVolume(pct)
  }, [setClampedVolume])

  const startVolumeDrag = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const trackEl = e.currentTarget.querySelector('[data-vol-track]') as HTMLElement | null
    if (!trackEl) return
    e.preventDefault()
    e.stopPropagation()
    volDragging.current = true
    lockTextSelect()
    const update = (ev: MouseEvent) => {
      applyVolumeAt(trackEl, ev.clientX, ev.clientY)
    }
    update(e.nativeEvent)
    const onMove = (ev: MouseEvent) => { ev.preventDefault(); update(ev) }
    const onUp = () => {
      volDragging.current = false
      unlockTextSelect()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [applyVolumeAt])

  const startVolumePointerDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    const trackEl = e.currentTarget.querySelector('[data-vol-track]') as HTMLElement | null
    if (!trackEl) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    volDragging.current = true
    lockTextSelect()
    applyVolumeAt(trackEl, e.clientX, e.clientY)
    const pointerId = e.pointerId
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      ev.preventDefault()
      applyVolumeAt(trackEl, ev.clientX, ev.clientY)
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      volDragging.current = false
      unlockTextSelect()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [applyVolumeAt])

  useEffect(() => {
    if (!volOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVolOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [volOpen])

  useEffect(() => {
    // Segment cleared → publish null. We no longer auto-publish segment.start
    // on every segment change, because the playhead is now USER-OWNED while
    // paused: an onSeek callback (drag-playhead) sets the desired position
    // explicitly via setPlayheadSec(seg.start + offset). Auto-publishing here
    // would clobber that with seg.start.
    if (!segment) onPlayheadChange?.(null)
  }, [segment, onPlayheadChange])


  useEffect(() => {
    if (initialPaused) isFirstLoad.current = true
  }, [initialPaused])

  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoSrc) return
    const auto = shouldAutoPlayNext.current
    shouldAutoPlayNext.current = false
    if (isFirstLoad.current && initialPaused) {
      isFirstLoad.current = false
      v.pause(); setIsPlaying(false)
      return
    }
    isFirstLoad.current = false
    if (auto || isPlaying) {
      const t = setTimeout(() => {
        void v.play().then(() => setIsPlaying(true)).catch(() => {})
      }, 50)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSrc])

  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seekTo = useCallback((offsetSec: number) => {
    if (!segment) return
    const clamped = Math.max(0, Math.min(offsetSec, segment.end - segment.start))
    // Always publish the new playhead immediately. Stream mode rebuilds
    // the video src on a short debounce; without this push the toolbar
    // would stay frozen until the new stream starts producing
    // timeupdate events (which only fire while playing).
    onPlayheadChange?.(segment.start + clamped)
    if (useNative) {
      // Native mode: cache mp4 is the whole file, currentTime is absolute.
      const v = videoRef.current
      if (v) v.currentTime = segment.start + clamped
      setVirtualOffset(clamped)
      setCurrentTime(0)
      return
    }
    setVirtualOffset(clamped)
    setCurrentTime(0)
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current)
    seekTimerRef.current = setTimeout(() => setVideoSrc(buildSrc(segment, clamped)), 80)
  }, [segment, buildSrc, useNative, onPlayheadChange])

  useEffect(() => {
    if (!pendingSeek) return
    if (lastSeekNonceRef.current === pendingSeek.nonce) return
    lastSeekNonceRef.current = pendingSeek.nonce
    seekTo(pendingSeek.offset)
  }, [pendingSeek, seekTo])

  // jassub overlay
  useEffect(() => {
    if (!overlayAss) return
    const canvas = overlayCanvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    let instance: JASSUB | null = null
    try {
      instance = new JASSUB({
        video, canvas,
        subContent: makeAssAlwaysOn(overlayAss),
        workerUrl: jassubWorkerUrl,
        wasmUrl: jassubWasmUrl,
        modernWasmUrl: jassubModernWasmUrl,
      })
    } catch { instance = null }
    return () => { try { instance?.destroy() } catch { /* noop */ } }
  }, [overlayAss, videoSrc])

  const displayElapsed = virtualOffset + currentTime
  const progress = segDuration > 0 ? (displayElapsed / segDuration) * 100 : 0
  const finishNativeSegment = useCallback(() => {
    if (!segment) return
    const shouldContinue = !isSourcePreview && isPlayingRef.current
    const v = videoRef.current
    if (v) {
      v.pause()
      v.currentTime = segment.end
    }
    setCurrentTime(Math.max(0, segDuration - virtualOffset))
    setIsPlaying(false)
    onPlayheadChange?.(segment.end)
    if (shouldContinue) {
      shouldAutoPlayNext.current = true
      onNext()
    }
  }, [segment, segDuration, virtualOffset, isSourcePreview, onNext, onPlayheadChange, setIsPlaying])
  const startProgressPointerDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!segment) return
    e.preventDefault()
    e.stopPropagation()
    const bar = e.currentTarget as HTMLElement
    bar.setPointerCapture(e.pointerId)
    progressDraggingRef.current = true
    lockTextSelect()
    const applyAt = (clientX: number) => {
      const rect = bar.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      seekTo(pct * segDuration)
    }
    applyAt(e.clientX)
    const pointerId = e.pointerId
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      ev.preventDefault()
      applyAt(ev.clientX)
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      progressDraggingRef.current = false
      unlockTextSelect()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [segment, segDuration, seekTo])

  const handlePlayPause = () => {
    const v = videoRef.current
    if (!v) {
      if (segment && !useNative) {
        setVideoSrc(buildSrc(segment, virtualOffset))
        shouldAutoPlayNext.current = true
      }
      return
    }
    if (v.paused) {
      // 播放前 flush 任何挂起的 seek。Stream 模式 seekTo 有 200ms debounce
      // 才重建 videoSrc;用户暂停时拖完 playhead 立刻点 Play(200ms 内)会
      // 还在旧 src 上,v.play() 从旧暂停位置继续 → 看起来 playhead 无效。
      // 同步立即重建到最新 virtualOffset 的 src,再让浏览器加载后 play。
      if (seekTimerRef.current) {
        clearTimeout(seekTimerRef.current)
        seekTimerRef.current = null
      }
      if (!useNative && segment) {
        const wantSrc = buildSrc(segment, virtualOffset)
        if (videoSrc !== wantSrc) {
          setVideoSrc(wantSrc)
          // 新 src 会让 <video key={videoSrc}> 重挂载,挂载后由
          // shouldAutoPlayNext 触发自动播放(见 onLoadedMetadata 路径)。
          shouldAutoPlayNext.current = true
          return
        }
      } else if (useNative) {
        // Native 模式 currentTime 直接寻址;若浏览器本身已对齐,正常 play
        // 即可。否则强制再对齐一次,再 play。
        const wantedAbs = (segment ? segment.start : 0) + virtualOffset
        if (Math.abs(v.currentTime - wantedAbs) > 0.05) {
          v.currentTime = wantedAbs
        }
      }
      void v.play()
    } else {
      v.pause()
    }
  }

  const cycleSpeed = () => {
    const idx = PLAYBACK_RATES.indexOf(playbackRate as (typeof PLAYBACK_RATES)[number])
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length]
    setPlaybackRate(next)
  }

  const renderVolumeControl = (variant: 'compact' | 'fullscreen' = 'compact') => {
    const size = variant === 'fullscreen' ? 36 : 28
    const trackHeight = variant === 'fullscreen' ? 118 : 92
    const width = variant === 'fullscreen' ? 36 : 28
    const height = volOpen ? size + trackHeight + 14 : size
    const panelBg = variant === 'fullscreen' ? 'rgb(var(--bg-surface) / 0.92)' : 'rgb(var(--bg-surface))'
    const panelBorder = variant === 'fullscreen' ? 'rgb(var(--border-strong) / 0.86)' : 'rgb(var(--border-strong))'
    const iconColor = 'rgb(var(--text-primary))'
    return (
      <div
        onMouseEnter={scheduleVolumeOpen}
        onMouseLeave={scheduleVolumeClose}
        style={{
          position: 'relative',
          width,
          height: size,
          flexShrink: 0,
          overflow: 'visible',
        }}
      >
        <div
          onWheel={(e) => {
            e.preventDefault()
            e.stopPropagation()
            changeVolumeByWheel(e.deltaY)
          }}
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            width,
            height,
            borderRadius: volOpen ? 8 : 6,
            background: panelBg,
            border: `1px solid ${panelBorder}`,
            boxShadow: volOpen ? '0 10px 28px rgba(0,0,0,0.28)' : 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'flex-end',
            overflow: 'hidden',
            transition: 'height 150ms ease, border-radius 150ms ease, box-shadow 150ms ease',
            zIndex: 120,
          }}
        >
          {volOpen && (
            <div
              onMouseDown={startVolumeDrag}
              style={{
                flex: 1,
                width: '100%',
                padding: '10px 0 8px',
                display: 'flex',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <div
                data-vol-track
                style={{
                  width: 7,
                  height: '100%',
                  borderRadius: 4,
                  background: 'var(--progress-bg)',
                  position: 'relative',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: `${volume * 100}%`,
                    borderRadius: 4,
                    background: variant === 'fullscreen' ? 'var(--progress-fill)' : 'rgb(var(--accent-500))',
                    transition: 'height 90ms linear',
                  }}
                />
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleMute() }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
            className={variant === 'fullscreen' ? undefined : 'btn icon sm'}
            style={variant === 'fullscreen'
              ? {
                  width: size,
                  height: size,
                  border: 'none',
                  background: 'transparent',
                  color: iconColor,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  flexShrink: 0,
                }
              : {
                  width: size,
                  height: size,
                  border: 'none',
                  background: 'transparent',
                  color: iconColor,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
            aria-label="volume"
            title="Hover to show volume"
          >
            {muted ? <VolumeX size={variant === 'fullscreen' ? 17 : 12} /> : <Volume2 size={variant === 'fullscreen' ? 17 : 12} />}
          </button>
        </div>
      </div>
    )
  }

  const cacheProgress = Math.max(0, Math.min(1, Number(previewCacheStatus?.progress ?? 0)))
  const cachePercent = Math.round(cacheProgress * 100)
  const cacheStage = previewCacheStatus?.ready
    ? 'Ready'
    : previewCacheStatus?.transcoding
      ? `Transcoding ${cachePercent}%`
      : previewCacheStatus?.queued
        ? 'Queued'
        : 'Preparing preview'
  const cacheProfile = previewCacheStatus?.profile
    ? `${previewCacheStatus.profile.name ?? 'proxy'}${previewCacheStatus.profile.height ? ` ${previewCacheStatus.profile.height}p` : ''}`
    : 'proxy video'

  return (
    <div className="panel h-full" style={{ flex: 1, minWidth: 0 }}>
      {/* 16:9 video area — black background with content centered */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--track-bg, #2a2a2a)',
          overflow: 'hidden',
        }}
      >
        {videoSrc || segment ? (
          <div
            ref={fullscreenHostRef}
            data-preview-host
            onDoubleClick={(e) => {
              e.stopPropagation()
              toggleFullscreen()
            }}
            style={{
              width: '100%',
              height: '100%',
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--track-bg, #2a2a2a)',
              overflow: 'hidden',
              containerType: 'size',
            }}
          >
          <div
            ref={previewAreaRef}
            data-preview-area
            onMouseDown={(e) => {
              // Click outside overlay text disarms.
              if (armed && !(e.target as HTMLElement).closest('[data-overlay-handle], [data-overlay-text]')) {
                setArmed(null)
              }
            }}
            onMouseMove={isFullscreen ? handleFullscreenMouseMove : undefined}
            onDoubleClick={(e) => {
              // Wrapper-level dblclick = expand to fullscreen. Routes
              // through toggleFullscreen so the wrapper→video→
              // webkitEnterFullscreen fallback chain is consistent with
              // the Expand button.
              e.stopPropagation()
              toggleFullscreen()
            }}
            style={{
              width: `min(100cqw, ${videoAspect * 100}cqh)`,
              height: `min(100cqh, ${(100 / videoAspect)}cqw)`,
              position: 'relative',
              background: 'var(--track-bg, #2a2a2a)',
              overflow: 'hidden',
              cursor: 'pointer',
              // Enables container query height units (cqh) for the HTML
              // overlay below — fontSize then scales with the actual
              // 16:9 preview area, not the viewport.
              containerType: 'size',
            } as React.CSSProperties}
          >
            {videoSrc && (
            <video
              key={videoSrc}
              ref={videoRef}
              src={videoSrc}
              preload="auto"
              className="absolute inset-0 w-full h-full object-contain"
              style={{ pointerEvents: 'auto', cursor: 'pointer', background: 'var(--track-bg, #2a2a2a)' }}
              onClick={(e) => {
                e.stopPropagation()
                handlePlayPause()
              }}
              onDoubleClick={(e) => {
                // Defer to wrapper-level dblclick (toggleFullscreen).
                // Don't stopPropagation here — let it bubble to the wrapper
                // so the wrapper→video→webkit fallback chain runs once.
                e.preventDefault()
              }}
              onTimeUpdate={() => {
                const v = videoRef.current
                if (!v || !segment) return
                if (useNative) {
                  if (v.currentTime >= segment.end) {
                    finishNativeSegment()
                    return
                  }
                  const elapsed = Math.max(0, v.currentTime - segment.start - virtualOffset)
                  setCurrentTime(elapsed)
                } else {
                  setCurrentTime(v.currentTime)
                }
                // Only publish to the global playhead while the video is
                // actively playing — paused state lets the user own the
                // playhead position via drag (one-way: playhead → video,
                // never video → playhead while paused).
                if (!isPlaying) return
                if (useNative) {
                  onPlayheadChange?.(v.currentTime)
                } else {
                  onPlayheadChange?.(segment.start + virtualOffset + v.currentTime)
                }
              }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => {
                const shouldContinue = !isSourcePreview && isPlayingRef.current
                setIsPlaying(false)
                if (shouldContinue) {
                  shouldAutoPlayNext.current = true
                  onNext()
                }
              }}
              onLoadedMetadata={() => {
                const v = videoRef.current
                if (!v) return
                v.playbackRate = playbackRate
                if (v.videoWidth > 0 && v.videoHeight > 0) setVideoAspect(v.videoWidth / v.videoHeight)
                if (useNative && segment) {
                  // Native mp4 = whole file, jump to segment.start + current offset
                  v.currentTime = segment.start + virtualOffset
                }
              }}
            />
            )}
            <canvas
              ref={overlayCanvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none z-10"
            />
            {!videoSrc && segment && (
              <div
                className="absolute inset-0 z-20 flex items-center justify-center"
                style={{
                  background: 'linear-gradient(180deg, rgba(0,0,0,0.18), rgba(0,0,0,0.34))',
                  color: 'rgb(var(--text-primary))',
                  pointerEvents: 'auto',
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  startPreviewCache(segment.file, 0).then(setPreviewCacheStatus).catch(() => { /* noop */ })
                }}
              >
                <div
                  style={{
                    minWidth: 240,
                    maxWidth: 360,
                    padding: '14px 16px',
                    borderRadius: 10,
                    background: 'rgb(var(--bg-surface) / 0.92)',
                    border: '1px solid rgb(var(--border-strong) / 0.74)',
                    boxShadow: '0 16px 42px rgba(0,0,0,0.28)',
                    backdropFilter: 'blur(12px)',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 5 }}>Preparing preview</div>
                  <div style={{ fontSize: 11, color: 'rgb(var(--text-secondary))', marginBottom: 10 }}>
                    {cacheStage} | {cacheProfile}
                  </div>
                  <div style={{ height: 7, borderRadius: 999, background: 'var(--progress-bg)', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${cachePercent}%`,
                        height: '100%',
                        borderRadius: 999,
                        background: 'var(--progress-fill)',
                        transition: 'width 180ms linear',
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Company logo top-right. Mirrors what ffmpeg bakes via
                config.yaml::overlay.logo_xy = ["W-w-40", 27] @ height 110.
                Coordinates derived 2026-05-13 from HALO 6 OneOCR sample:
                burned-in timestamp center y = 82px (@ 1080 baseline) so
                logo top y = 82 - 110/2 = 27. Right margin = 40px. Both
                values are 1920×1080 baseline; preview uses cqh / cqw so
                the same ratio holds across any video aspect ratio.
                Served by /api/asset/logo. Always on (用户 2026-05-13)。*/}
            {logoOverlay && (() => {
              const lo = logoOverlay
              const isArmed = armed === 'logo'
              const baseHeightPct = (110 / 1080) * 100 * lo.scale
              const baseTopPct = (27 / 1080) * 100
              const baseRightPct = (40 / 1080) * 100
              // position_x/y are 1080-baseline px; convert to cqh via /1080*100.
              const offTopPct = (lo.position_y / 1080) * 100
              const offRightPct = (lo.position_x / 1080) * 100
              const startLogoBodyDrag = (e: React.MouseEvent) => {
                if (!onLogoOverlayChange) return
                e.stopPropagation(); e.preventDefault()
                const startX = e.clientX, startY = e.clientY
                const ox = lo.position_x, oy = lo.position_y
                const area = (e.currentTarget as HTMLElement).closest('[data-preview-area]') as HTMLElement | null
                const rect = area?.getBoundingClientRect()
                const scale = rect ? 1080 / rect.height : 1
                const onMove = (ev: MouseEvent) => {
                  const dx = (ev.clientX - startX) * scale
                  const dy = (ev.clientY - startY) * scale
                  onLogoOverlayChange({
                    position_x: Math.round(ox - dx),  // dragging right ↑ should move logo right (= less right offset)
                    position_y: Math.round(oy + dy),
                  })
                }
                lockTextSelect()
                const onUp = () => {
                  unlockTextSelect()
                  window.removeEventListener('mousemove', onMove)
                  window.removeEventListener('mouseup', onUp)
                }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }
              const startLogoScaleDrag = (
                e: React.MouseEvent,
                handle: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e',
              ) => {
                if (!onLogoOverlayChange) return
                e.stopPropagation(); e.preventDefault()
                const startX = e.clientX, startY = e.clientY
                const oScale = lo.scale
                const logoEl = (e.currentTarget as HTMLElement).closest('[data-logo-overlay-box="true"]') as HTMLElement | null
                const logoRect = logoEl?.getBoundingClientRect()
                const visualBase = Math.max(40, ((logoRect?.width ?? 110) + (logoRect?.height ?? 110)) / 2)
                const onMove = (ev: MouseEvent) => {
                  // 1px cursor x ≈ 0.005 scale; positive dx = grow.
                  const dx = ev.clientX - startX
                  const dy = ev.clientY - startY
                  const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0
                  const sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0
                  const out = sx !== 0 && sy !== 0
                    ? (dx * sx + dy * sy) / 2
                    : sx !== 0
                      ? dx * sx
                      : dy * sy
                  const next = Math.max(0.3, Math.min(3, oScale * (1 + out / visualBase)))
                  onLogoOverlayChange({ scale: parseFloat(next.toFixed(3)) })
                }
                lockTextSelect()
                const onUp = () => {
                  unlockTextSelect()
                  window.removeEventListener('mousemove', onMove)
                  window.removeEventListener('mouseup', onUp)
                }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }
              return (
                <div
                  data-overlay-text
                  data-logo-overlay-box="true"
                  className="absolute z-15"
                  style={{
                    top: `calc(${baseTopPct}cqh + ${offTopPct}cqh)`,
                    right: `calc(${baseRightPct}cqh + ${offRightPct}cqh)`,
                    height: `${baseHeightPct}cqh`,
                    cursor: isArmed ? 'move' : 'pointer',
                    pointerEvents: 'auto',
                    outline: isArmed ? '1px solid rgba(0,0,0,0.55)' : 'none',
                    outlineOffset: 2,
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (!onLogoOverlayChange) return
                    setArmed(isArmed ? null : 'logo')
                  }}
                  onMouseDown={(e) => {
                    if ((e.target as HTMLElement).closest('[data-overlay-handle]')) return
                    if (isArmed) startLogoBodyDrag(e)
                  }}
                  title={isArmed ? 'Drag to move · drag corners to resize · Esc to lock' : 'Double-click to adjust'}
                >
                  <img
                    src="/api/asset/logo"
                    alt=""
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                    draggable={false}
                    style={{
                      height: '100%',
                      width: 'auto',
                      objectFit: 'contain',
                      pointerEvents: 'none',
                      display: 'block',
                    }}
                  />
                  {isArmed && (
                    <>
                      {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                        <BoxCornerHandle
                          key={c}
                          corner={c}
                          onDragStart={(e) => startLogoScaleDrag(e, c)}
                        />
                      ))}
                      <BoxEdgeHandle edge="n" onDragStart={(e) => startLogoScaleDrag(e, 'n')} />
                      <BoxEdgeHandle edge="s" onDragStart={(e) => startLogoScaleDrag(e, 's')} />
                      <BoxEdgeHandle edge="w" onDragStart={(e) => startLogoScaleDrag(e, 'w')} />
                      <BoxEdgeHandle edge="e" onDragStart={(e) => startLogoScaleDrag(e, 'e')} />
                    </>
                  )}
                </div>
              )
            })()}

            {/* HTML overlay — direct render of cover_lines + small_lines.
                Independent of jassub/ASS so the user always sees the
                overlay, even when WASM init or segment_stream timing
                misalign would hide the canvas-based one.

                Double-click a text block to arm it — handles appear and
                drag becomes active:
                  body         → position
                  4 corners    → font size (diagonal scale)
                  top/bottom   → line spacing
                  left/right   → letter spacing
                Esc / click outside disarms.  */}
            {coverLines.filter((l) => l && l.trim() !== '').length > 0 && (
              <OverlayTextBlock
                kind="cover"
                lines={coverLines}
                overlay={coverOverlay}
                armed={armed === 'cover'}
                selected={selectedOverlay === 'cover'}
                canDrag={!!onOverlayChange}
                onArm={() => setArmed('cover')}
                onSelect={() => onSelectOverlay?.('cover')}
                onDragStart={(axis, e) => startOverlayDrag(e, 'cover', axis)}
                onLinesChange={onLinesChange ? (next) => onLinesChange('cover', next) : undefined}
                videoAspect={videoAspect}
              />
            )}

            {smallLines.filter((l) => l && l.trim() !== '').length > 0 && (
              <OverlayTextBlock
                kind="small"
                lines={smallLines}
                overlay={smallOverlay}
                armed={armed === 'small'}
                selected={selectedOverlay === 'small'}
                canDrag={!!onOverlayChange}
                onArm={() => setArmed('small')}
                onSelect={() => onSelectOverlay?.('small')}
                onDragStart={(axis, e) => startOverlayDrag(e, 'small', axis)}
                onLinesChange={onLinesChange ? (next) => onLinesChange('small', next) : undefined}
                videoAspect={videoAspect}
              />
            )}

            {/* Center-alignment guides (Canva-style).
                Visible while a position drag is in progress: faint
                magenta crosshair as a target hint, brightens to solid
                when the dragged textbox snaps to canvas center. */}
            {posDragActive && (
              <>
                <div className="absolute pointer-events-none z-30" style={{
                  left: '50%', top: 0, bottom: 0, width: 1,
                  background: snapGuide.vCenter ? '#ff00ff' : 'rgba(255,0,255,0.22)',
                  boxShadow: snapGuide.vCenter ? '0 0 6px rgba(255,0,255,0.9)' : 'none',
                  transition: 'background 80ms linear',
                }} />
                <div className="absolute pointer-events-none z-30" style={{
                  top: '50%', left: 0, right: 0, height: 1,
                  background: snapGuide.hMiddle ? '#ff00ff' : 'rgba(255,0,255,0.22)',
                  boxShadow: snapGuide.hMiddle ? '0 0 6px rgba(255,0,255,0.9)' : 'none',
                  transition: 'background 80ms linear',
                }} />
              </>
            )}

            {/* 全屏期间的浮层控件,仅在 isFullscreen 且鼠标活动时显示。
                左右各一颗五秒回退/前进按钮,中央播放/暂停,底部细进度条。 */}
            {isFullscreen && (
              <div
                onMouseMove={(e) => {
                  e.stopPropagation()
                  if (!isPlayingRef.current
                    || volDragging.current
                    || progressDraggingRef.current
                    || isInFsPanelHitArea(e.clientX, e.clientY)) {
                    showFsControls(null)
                  } else {
                    hideFsControls(0)
                  }
                }}
                onMouseEnter={(e) => {
                  if (!isPlayingRef.current || isInFsPanelHitArea(e.clientX, e.clientY)) {
                    showFsControls(null)
                  } else {
                    hideFsControls(0)
                  }
                }}
                onMouseLeave={() => {
                  if (isPlayingRef.current && !volDragging.current && !progressDraggingRef.current) hideFsControls(0)
                }}
                onDoubleClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                style={{
                  position: 'absolute',
                  left: 0, right: 0, bottom: 0,
                  padding: '0 18px 12px',
                  background: 'linear-gradient(to top, rgba(0,0,0,0.52) 0%, rgba(0,0,0,0.18) 58%, rgba(0,0,0,0) 100%)',
                  opacity: fsControlsVisible ? 1 : 0,
                  pointerEvents: fsControlsVisible ? 'auto' : 'none',
                  transition: fsControlsVisible ? 'opacity 120ms ease-out' : 'none',
                  zIndex: 80,
                }}
              >
                <div
                  ref={fsPanelRef}
                  style={{
                    width: 'min(1060px, 100%)',
                    margin: '0 auto',
                    padding: '6px 8px',
                    borderRadius: 999,
                    background: 'rgb(var(--bg-surface) / 0.92)',
                    border: '1px solid rgb(var(--border-strong) / 0.82)',
                    boxShadow: '0 18px 44px rgba(0,0,0,0.32), var(--glass-shadow)',
                    backdropFilter: 'blur(12px)',
                  }}
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto',
                      alignItems: 'center',
                      gap: 10,
                      color: 'rgb(var(--text-primary))',
                      font: "500 11px/1 'JetBrains Mono', monospace",
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    <span style={{ minWidth: 52, textAlign: 'center' }}>{fmt(displayElapsed)}</span>
                    <div
                      onPointerDown={startProgressPointerDrag}
                      style={{
                        height: 30,
                        padding: '11px 0',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        touchAction: 'none',
                      }}
                    >
                      <div style={{ width: '100%', height: 6, borderRadius: 999, background: 'var(--progress-bg)', overflow: 'hidden', pointerEvents: 'none' }}>
                        <div style={{ width: `${progress}%`, height: '100%', background: 'var(--progress-fill)' }} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ minWidth: 52, textAlign: 'center' }}>{fmt(segDuration)}</span>
                      <button type="button" onClick={(e) => { e.stopPropagation(); seekTo(Math.max(0, displayElapsed - 5)) }} onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation() }} style={{ width: 30, height: 30, borderRadius: 999, background: 'rgb(var(--bg-raised) / 0.88)', color: 'rgb(var(--text-primary))', border: '1px solid rgb(var(--border-strong) / 0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} aria-label="back 5 seconds">
                        <SkipBack size={15} />
                      </button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); handlePlayPause() }} onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation() }} style={{ width: 34, height: 30, borderRadius: 999, background: 'var(--btn-primary-bg)', color: '#fff', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: 'var(--btn-primary-shadow), 0 8px 20px rgba(0,0,0,0.22)' }} aria-label={isPlaying ? 'pause' : 'play'}>
                        {isPlaying ? <Pause size={17} /> : <Play size={17} />}
                      </button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); seekTo(Math.min(segDuration, displayElapsed + 5)) }} onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation() }} style={{ width: 30, height: 30, borderRadius: 999, background: 'rgb(var(--bg-raised) / 0.88)', color: 'rgb(var(--text-primary))', border: '1px solid rgb(var(--border-strong) / 0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} aria-label="forward 5 seconds">
                        <SkipForward size={15} />
                      </button>
                      <div
                        onPointerDown={startVolumePointerDrag}
                        onWheel={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          changeVolumeByWheel(e.deltaY)
                        }}
                        style={{
                          width: 96,
                          height: 30,
                          padding: '0 8px',
                          borderRadius: 999,
                          background: 'rgb(var(--bg-raised) / 0.88)',
                          border: '1px solid rgb(var(--border-strong) / 0.78)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          cursor: 'pointer',
                          touchAction: 'none',
                        }}
                      >
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleMute() }}
                          onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation() }}
                          style={{ width: 18, height: 18, border: 'none', background: 'transparent', color: 'rgb(var(--text-primary))', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}
                          aria-label="volume"
                        >
                          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                        </button>
                        <div data-vol-track data-vol-axis="x" style={{ flex: 1, height: 5, borderRadius: 999, background: 'var(--progress-bg)', overflow: 'hidden', pointerEvents: 'none' }}>
                          <div style={{ width: `${volume * 100}%`, height: '100%', background: 'var(--progress-fill)' }} />
                        </div>
                      </div>
                      <button type="button" onClick={(e) => { e.stopPropagation(); cycleSpeed() }} onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation() }} style={{ height: 30, minWidth: 42, borderRadius: 999, background: 'rgb(var(--bg-raised) / 0.88)', color: 'rgb(var(--text-primary))', border: '1px solid rgb(var(--border-strong) / 0.78)', cursor: 'pointer', fontSize: 11, fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {playbackRate}x
                      </button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); toggleFullscreen() }} onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation() }} style={{ width: 30, height: 30, borderRadius: 999, background: 'rgb(var(--bg-raised) / 0.88)', color: 'rgb(var(--text-primary))', border: '1px solid rgb(var(--border-strong) / 0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} aria-label="exit fullscreen">
                        <Minimize2 size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          </div>
        ) : (
          <div className="text-center" style={{ color: '#9aa1ab' }}>
            <Film size={32} className="mx-auto mb-2" style={{ opacity: 0.4 }} />
            <div style={{ fontSize: 11 }}>{t('preview_hint')}</div>
          </div>
        )}
      </div>

      {/* Controls row — exact v5 layout */}
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid rgb(var(--border-subtle))',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        <Tooltip content="Back 5s">
        <button type="button" className="btn icon sm" onClick={() => seekTo(Math.max(0, displayElapsed - 5))}>
          <SkipBack size={12} />
        </button>
        </Tooltip>
        <Tooltip content={isPlaying ? 'Pause' : 'Play'}>
        <button
          type="button"
          className="btn icon sm primary"
          onClick={handlePlayPause}
        >
          {isPlaying ? <Pause size={12} /> : <Play size={12} />}
        </button>
        </Tooltip>
        <Tooltip content="Forward 5s">
        <button type="button" className="btn icon sm" onClick={() => seekTo(Math.min(segDuration, displayElapsed + 5))}>
          <SkipForward size={12} />
        </button>
        </Tooltip>
        <span
          className="mono tabular-nums"
          style={{
            fontSize: 11,
            color: 'rgb(var(--text-secondary))',
            margin: '0 6px',
            minWidth: 96,
          }}
        >
          {fmt(displayElapsed)} / {fmt(segDuration)}
        </span>
        <div
          onMouseDown={(e) => {
            if (!segment) return
            // rect taken from outer hit-area; inner visual bar spans the
            // full width, so clientX → pct math is identical.
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            const applyAt = (clientX: number) => {
              const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
              seekTo(pct * segDuration)
            }
            lockTextSelect()
            const onMove = (ev: MouseEvent) => applyAt(ev.clientX)
            const onUp = () => {
              unlockTextSelect()
              window.removeEventListener('mousemove', onMove)
              window.removeEventListener('mouseup', onUp)
            }
            window.addEventListener('mousemove', onMove)
            window.addEventListener('mouseup', onUp)
          }}
          style={{
            // Outer hit-area: expand vertical clickable zone from 8px to 24px
            // so users don't have to precisely aim for the thin visual bar.
            flex: 1,
            padding: '12px 0',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              flex: 1,
              height: 8,
              background: 'rgba(18,28,46,0.12)',
              borderRadius: 4,
              overflow: 'hidden',
              position: 'relative',
              pointerEvents: 'none',  // clicks pass through to the outer hit-area
            }}
          >
            <div style={{ width: `${progress}%`, height: '100%', borderRadius: 4, background: '#3b82f6', transition: 'width 0.1s linear' }} />
          </div>
        </div>
        <div style={{ width: 1, height: 20, background: 'rgb(var(--border-subtle))', margin: '0 4px' }} />
        <Tooltip content={`Current: ${playbackRate}×`}>
        <button type="button" className="btn sm" onClick={cycleSpeed}>
          {playbackRate}×
        </button>
        </Tooltip>
        {renderVolumeControl('compact')}
        <button type="button" className="btn icon sm"
          ref={volBtnRef}
          style={{ display: 'none' }}
          onMouseEnter={armVolPopupHover}
          onMouseMove={armVolPopupHover}
          onMouseLeave={() => { cancelHover(); scheduleLeave() }}
          onClick={() => {
            // Click only toggles mute. Bar shows/hides via hover, never click.
            // Volume value is preserved across mute toggles so the slider
            // remains pegged at "last adjusted" regardless of mute state.
            setMuted((m) => {
              const next = !m
              // Going from mute → unmute with a 0 volume: restore from cache.
              if (m && volume === 0) {
                setVolume(volumeCache > 0 ? volumeCache : 0.8)
              }
              return next
            })
          }}
          onWheel={(e) => {
            e.preventDefault()
            const delta = e.deltaY > 0 ? -0.05 : 0.05
            setVolume((v) => {
              const next = Math.max(0, Math.min(1, v + delta))
              if (next > 0) setVolumeCache(next)
              return next
            })
          }}
        >
          {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
        </button>
        <Tooltip content={isFullscreen ? 'Exit fullscreen' : 'Expand to fullscreen'}>
        <button
          type="button"
          className="btn icon sm"
          onClick={toggleFullscreen}
        >
          {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        </Tooltip>
        {volPopup && createPortal(
          <div
            ref={volRef}
            onMouseEnter={cancelLeave}
            onMouseLeave={scheduleLeave}
            style={{
              position: 'fixed',
              left: volPopup.x,
              top: volPopup.y,
              zIndex: 999,
              width: 40,
              height: 160,
              background: 'var(--menu-bg)',
              border: '1px solid var(--menu-border)',
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '8px 0',
              cursor: 'pointer',
            }}
            onWheel={(e) => {
              e.preventDefault()
              const delta = e.deltaY > 0 ? -0.05 : 0.05
              setVolume((v) => {
                const next = Math.max(0, Math.min(1, v + delta))
                if (next > 0) setVolumeCache(next)
                return next
              })
            }}
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).tagName === 'BUTTON') return
              e.preventDefault()
              volDragging.current = true
              const trackEl = volRef.current?.querySelector('[data-vol-track]') as HTMLElement | null
              if (!trackEl) return
              lockTextSelect()
              const update = (ev: MouseEvent) => {
                const rect = trackEl.getBoundingClientRect()
                const pct = 1 - Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height))
                setVolume(pct)
                if (pct > 0) setVolumeCache(pct)
                // Slider drag never auto-mutes; mute is purely a click action
                // on the icon now.
              }
              update(e.nativeEvent)
              const onMove = (ev: MouseEvent) => { ev.preventDefault(); update(ev) }
              const onUp = () => {
                volDragging.current = false
                unlockTextSelect()
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
              }
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            }}
          >
            <div
              data-vol-track
              style={{ flex: 1, width: 8, borderRadius: 4, background: 'var(--progress-bg)', position: 'relative' }}
            >
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                // Always reflects the actual volume value; mute state is
                // shown only via the speaker icon, not the slider fill.
                height: `${volume * 100}%`,
                borderRadius: 3,
                background: 'rgb(var(--accent-500))',
                transition: 'height 0.1s linear',
              }} />
            </div>
          </div>,
          document.body,
        )}
      </div>
    </div>
  )
}

// ── OverlayTextBlock ─────────────────────────────────────────────
// Renders one cover/small text block with double-click-to-arm + drag handles.
// Position is interpreted in 1080-baseline px relative to the block's natural
// anchor; we map to cqw/cqh so the on-screen position scales with preview size.

interface OverlayTextBlockProps {
  kind: 'cover' | 'small'
  lines: string[]
  overlay: OverlayElement
  armed: boolean
  selected: boolean
  canDrag: boolean
  onArm: () => void
  onSelect: () => void
  onDragStart: (axis: DragAxis, e: React.MouseEvent) => void
  // Optional — when set, double-click on the overlay flips into inline
  // edit mode. Caller persists the new lines (saves to jobMeta).
  onLinesChange?: (next: string[]) => void
  // Actual video display aspect ratio (W/H). Default 16/9. Used to cap
  // overlay maxWidth relative to video display width even in fullscreen
  // where the wrapper container grows to viewport size and cqw alone
  // stops matching the video's true display width.
  videoAspect?: number
}

function OverlayTextBlock({
  kind, lines, overlay, armed, selected, canDrag, onArm: _onArm, onSelect, onDragStart, onLinesChange,
  videoAspect = 16 / 9,
}: OverlayTextBlockProps) {
  void _onArm
  // 文本始终可编辑,view 与 edit 共用同一容器、同一外观,无任何切换。
  // 焦点离开时把内容写回 lines。鼠标事件不阻止冒泡,以便父级 wrapper
  // 仍能接收按住拖动的位置移动。
  const editRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const linesAsHtml = lines.map((l) => escapeHtml(l) || '&nbsp;').join('<br>')
  // 仅在容器未获得焦点(未在编辑)时把外部 lines 同步进 DOM,避免与
  // 用户正在键入的内容冲突。
  useEffect(() => {
    const el = editRef.current
    if (!el) return
    if (document.activeElement === el) return
    if (el.innerHTML !== linesAsHtml) el.innerHTML = linesAsHtml
  }, [linesAsHtml])
  const commitText = () => {
    const el = editRef.current
    if (!el || !onLinesChange) return
    const text = el.innerText
    onLinesChange(text.split('\n'))
  }
  const isCover = kind === 'cover'

  // Position mapping. Cover anchor = canvas center, Small anchor = top-left 2%/2%.
  // We use cqw/cqh so the offset scales with the actual preview area size.
  // CRITICAL: outer wrapper needs an explicit width — without it, the
  // absolute wrapper auto-sizes to content (longest non-wrapped line),
  // making the visible text box much narrower than box_width suggests.
  const offX = `${(overlay.position_x / 1920) * 100}cqw`
  const offY = `${(overlay.position_y / 1080) * 100}cqh`
  // Box width = "shrink to longest line" (max-content) so the default
  // text box never reaches the PreviewBox edges; this leaves room on
  // both sides for left/right edge handles to drag OUT (= grow word
  // spacing) and IN (= shrink). box_width is no longer pinned by drag.
  // 标题默认居于预览正中(全屏与窗口模式相同),水印默认贴预览左上
  // 角各偏移五像素;position_x/y 在此基础上叠加。
  const wrapperPos: React.CSSProperties = isCover
    ? {
        position: 'absolute',
        left: '50%', top: '50%',
        width: 'max-content',
        maxWidth: `min(96cqw, ${96 * videoAspect}cqh)`,
        transform: `translate(calc(-50% + ${offX}), calc(-50% + ${offY}))`,
      }
    : {
        position: 'absolute',
        left: `calc(5px + ${offX})`,
        top: `calc(5px + ${offY})`,
        width: 'max-content',
        maxWidth: `min(96cqw, ${96 * videoAspect}cqh)`,
      }

  // Toolbar -/+ controls drive: font_size, line_spacing, letter_spacing,
  // whole_scale. whole_scale multiplies the other three.
  const ws = overlay.whole_scale > 0 ? overlay.whole_scale : 1
  const fontSize = (overlay.font_size > 0 ? overlay.font_size : 12) * ws
  const linSp = (Number.isFinite(overlay.line_spacing) ? Math.max(0, overlay.line_spacing) : 0) * ws
  const letSp = Math.max(0, overlay.letter_spacing) * ws

  // No lower clamp floor — was 14px (cover) / 10px (small), which pegged
  // small font_size values to the floor in mid-sized preview windows so
  // further `−` clicks had no visible effect. Render-side ASS has no
  // floor either, so removing it keeps preview faithful to the bake.
  // Upper clamp kept to stop the user from ballooning text outside the
  // 16:9 frame at huge values.
  const fontSizeCss = isCover
    ? `min(${(fontSize / 1080) * 100}cqh, 240px)`
    : `min(${(fontSize / 1080) * 100}cqh, 80px)`
  // line-height anchored to the BACKEND DEFAULT font size (72 cover,
  // 32 small) instead of the user's current font_size. Anchoring to
  // current font_size made tiny fonts produce huge multipliers (Font
  // 24 + Line 22 → multiplier 1.92), so users perceived "shrinking
  // font expands line spacing". Anchor stays fixed → line spacing
  // tracks line_spacing changes only.
  // line_spacing 是 1080 基准下两行之间的额外像素。
  // Arial Bold em-square 大约带 15% 内置 leading,所以
  // lineHeight = font-size × 0.85 让上行字底贴下行字顶,
  // line_spacing 在此基础上叠加。
  const lineHeightCss = `${((fontSize * 0.85 + linSp) / 1080) * 100}cqh`
  // 字距:CSS letter-spacing 控制字符之间的额外间距。
  // 词距:让词间增长比例约为字间增长比例的 1.5 倍。
  // CSS 默认 letter-spacing 也会应用到空格前后(共 2 倍),所以词额外
  // 已经是 2 × letter-spacing。设 word-spacing = -0.5 × letter-spacing
  // 把词额外回拉到 1.5 × letter-spacing,字额外仍是 letter-spacing,
  // 比例正好 1.5:1。letter_spacing=0 时 word-spacing=0,空格保留自然宽。
  const letterSpacingCss = `${(letSp / 1920) * 100}cqw`
  const wordSpacingCss = `${(-0.5 * letSp / 1920) * 100}cqw`

  // Real glyph outline via -webkit-text-stroke — text-shadow only paints
  // 4 corner offsets so 45° gaps between corners showed through. Stroke
  // paints the actual glyph perimeter; paint-order: stroke fill draws the
  // stroke first so it sits BEHIND the white fill (no fill clipping).
  const strokeWidth = isCover ? 2 : 1   // px in cqh-scaled space; visually ≈ ASS Outline 6/3
  const strokeColor = '#000'

  return (
    // Outer wrapper auto-sizes to inner content, so removing
    // pointer-events:none here doesn't break video click-through (no
    // gap between outer bbox and inner text bbox to leak clicks).
    // Some browsers have quirks where pointer-events:none on a parent
    // suppresses descendants even with pointer-events:auto — by making
    // outer auto we sidestep that entirely.
    <div ref={wrapperRef} className="absolute z-20" style={wrapperPos}>
      <div
        data-overlay-text
        data-overlay-kind={kind}
        onMouseDown={(e) => {
          if (canDrag) onSelect()
          if ((e.target as HTMLElement).closest('[data-overlay-handle]')) return
          if (!canDrag) return
          // 延迟启动位置拖拽:鼠标移动超过 4 像素阈值才转入 drag,
          // 否则放过给文字编辑(光标定位)使用。这样编辑模式下也能拖。
          const startX = e.clientX
          const startY = e.clientY
          const onMove = (ev: MouseEvent) => {
            if (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4) {
              window.removeEventListener('mousemove', onMove)
              window.removeEventListener('mouseup', onUp)
              const fake = {
                clientX: ev.clientX,
                clientY: ev.clientY,
                button: ev.button,
                target: ev.target,
                currentTarget: ev.currentTarget,
                preventDefault: () => ev.preventDefault(),
                stopPropagation: () => ev.stopPropagation(),
                nativeEvent: ev,
              } as unknown as React.MouseEvent
              onDragStart('pos', fake)
            }
          }
          const onUp = () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
          }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }}
        onClick={(e) => {
          e.stopPropagation()
        }}
        style={{
          position: 'relative',
          color: 'white',
          fontFamily: 'Arial, sans-serif',
          fontWeight: 700,
          fontSize: fontSizeCss,
          lineHeight: lineHeightCss,
          letterSpacing: letterSpacingCss,
          wordSpacing: wordSpacingCss,
          textAlign: isCover ? 'center' : 'left',
          // Real glyph outline (no 45° gaps).
          WebkitTextStroke: `${strokeWidth}px ${strokeColor}`,
          paintOrder: 'stroke fill',
          padding: 0,
          // Width is set on the OUTER wrapper now (so the absolute
          // wrapper doesn't auto-size to content). Inner just fills
          // the parent.
          width: '100%',
          pointerEvents: canDrag ? 'auto' : 'none',
          cursor: armed ? 'move' : (canDrag ? 'pointer' : 'default'),
          outline: (canDrag && selected) ? '1px solid rgba(0,0,0,0.55)' : 'none',
          outlineOffset: 2,
          userSelect: 'none',
        }}
      >
        {/* 文本框始终可编辑,view 与 edit 完全无切换,外观一致。
            鼠标事件不阻止冒泡,父级 wrapper 仍能接管按住拖动改位置。 */}
        <div
          ref={editRef}
          contentEditable={canDrag}
          suppressContentEditableWarning
          spellCheck={false}
          onKeyDown={(e) => {
            e.stopPropagation()
          }}
          onBlur={commitText}
          style={{
            display: 'block',
            outline: 'none',
            caretColor: '#fff',
            cursor: 'text',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            userSelect: 'text',
          }}
        />

        {/* Canva-style frame: 4 corner circles + 4 edge pills.
            Only render handles for the currently-SELECTED overlay so the
            inactive textbox stays visually quiet. Selection is driven by
            clicking the matching textarea in the INPUT panel. */}
        {canDrag && selected && (
          <>
            {/* 4 corners — small white circles, wired to font_size scale */}
            {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
              <BoxCornerHandle
                key={`c-${corner}`}
                corner={corner}
                onDragStart={(e) => onDragStart(`corner-${corner}` as DragAxis, e)}
              />
            ))}
            {/* Top + bottom edge pills — wired to line_spacing drag */}
            <BoxEdgeHandle edge="n" onDragStart={(e) => onDragStart('box-h-n', e)} />
            <BoxEdgeHandle edge="s" onDragStart={(e) => onDragStart('box-h-s', e)} />
            {/* Left + right edge pills — wired to box_width drag */}
            <BoxEdgeHandle edge="w" onDragStart={(e) => onDragStart('box-w-w', e)} />
            <BoxEdgeHandle edge="e" onDragStart={(e) => onDragStart('box-w-e', e)} />
          </>
        )}
      </div>
    </div>
  )
}

// ── BoxEdgeHandle ─────────────────────────────────────────────────
// Standalone resize handle. Attaches native mousedown via useEffect+ref
// so it can't be intercepted by parent React handlers, and auto-applies
// pointer-events:auto + high z-index. Drag is delegated to PreviewBox
// via the onDragStart prop.

interface BoxEdgeHandleProps {
  edge: 'w' | 'e' | 'n' | 's'
  onDragStart: (e: React.MouseEvent) => void
}

function BoxEdgeHandle({ edge, onDragStart }: BoxEdgeHandleProps) {
  const isHorizontal = edge === 'w' || edge === 'e'
  const ref = useRef<HTMLDivElement>(null)
  const onDragStartRef = useRef(onDragStart)
  useEffect(() => {
    onDragStartRef.current = onDragStart
  }, [onDragStart])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onDown = (e: MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      const fakeReactEvent = {
        clientX: e.clientX,
        clientY: e.clientY,
        button: e.button,
        target: e.target,
        currentTarget: e.currentTarget,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
        nativeEvent: e,
      } as unknown as React.MouseEvent
      onDragStartRef.current(fakeReactEvent)
    }
    // Capture phase to be the very first listener — beats parent
    // delegation that might call stopPropagation.
    el.addEventListener('mousedown', onDown, { capture: true })
    return () => el.removeEventListener('mousedown', onDown, { capture: true } as EventListenerOptions)
  }, [])

  // Hit area 回退:沿整条边的全长可拖,中央椭圆只是视觉提示。
  const hitArea: React.CSSProperties = isHorizontal
    ? {
        position: 'absolute',
        top: 0, bottom: 0,
        ...(edge === 'w' ? { left: -12 } : { right: -12 }),
        width: 24,
        cursor: 'ew-resize',
        zIndex: 50,
        pointerEvents: 'auto',
      }
    : {
        position: 'absolute',
        left: 0, right: 0,
        ...(edge === 'n' ? { top: -12 } : { bottom: -12 }),
        height: 24,
        cursor: 'ns-resize',
        zIndex: 50,
        pointerEvents: 'auto',
      }
  const pillBase: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'white',
    border: '1px solid rgba(0,0,0,0.45)',
    borderRadius: 4,
    pointerEvents: 'none',
  }
  const pillSize: React.CSSProperties = isHorizontal
    ? { width: 8, height: 22 }
    : { width: 22, height: 8 }
  return (
    <div
      ref={ref}
      data-overlay-handle
      title={isHorizontal
        ? 'Drag to resize text box width — text auto-reflows'
        : 'Drag to change line spacing'}
      style={hitArea}
    >
      <div style={{ ...pillBase, ...pillSize }} />
    </div>
  )
}

// ── BoxCornerHandle ──────────────────────────────────────────────
// 8×8 circle at each corner of the textbox. Drag scales font_size
// uniformly (3D scale per user) with the opposite corner anchored.

interface BoxCornerHandleProps {
  corner: 'nw' | 'ne' | 'sw' | 'se'
  onDragStart: (e: React.MouseEvent) => void
}

function BoxCornerHandle({ corner, onDragStart }: BoxCornerHandleProps) {
  const ref = useRef<HTMLDivElement>(null)
  const onDragStartRef = useRef(onDragStart)
  useEffect(() => {
    onDragStartRef.current = onDragStart
  }, [onDragStart])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onDown = (e: MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      const fakeReactEvent = {
        clientX: e.clientX, clientY: e.clientY, button: e.button,
        target: e.target, currentTarget: e.currentTarget,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
        nativeEvent: e,
      } as unknown as React.MouseEvent
      onDragStartRef.current(fakeReactEvent)
    }
    el.addEventListener('mousedown', onDown, { capture: true })
    return () => el.removeEventListener('mousedown', onDown, { capture: true } as EventListenerOptions)
  }, [])

  const cursor = (corner === 'nw' || corner === 'se') ? 'nwse-resize' : 'nesw-resize'
  // 命中圆:直径 19 像素,圆心精确锚定在 wrapper 顶点,圆外辐射约 5
  // 像素半径,圆形真命中(clip-path:circle(50%))。视觉小圆点 9×9 居中
  // 在容器内,与圆心重合。
  const anchor: React.CSSProperties = {
    ...(corner === 'nw' ? { top: 0, left: 0 } : {}),
    ...(corner === 'ne' ? { top: 0, left: '100%' } : {}),
    ...(corner === 'sw' ? { top: '100%', left: 0 } : {}),
    ...(corner === 'se' ? { top: '100%', left: '100%' } : {}),
  }
  return (
    <div
      ref={ref}
      data-overlay-handle
      title="Drag corner to scale text uniformly (3D)"
      style={{
        position: 'absolute',
        width: 19, height: 19,
        transform: 'translate(-50%, -50%)',
        cursor,
        zIndex: 60,
        pointerEvents: 'auto',
        clipPath: 'circle(50%)',
        ...anchor,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 9, height: 9,
          background: 'white',
          border: '1px solid rgba(0,0,0,0.45)',
          borderRadius: '50%',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
