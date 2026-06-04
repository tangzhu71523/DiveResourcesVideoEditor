import { useEffect, useMemo, useRef, useState } from 'react'
import { getThumbnailStatus, thumbnailUrl } from '@/lib/api'

interface Props {
  hue?: number
  fogged?: boolean
  filePath?: string
  durationSec?: number
  widthPx?: number
  folder?: string | null
}

// 单帧 16:9 — 视觉宽 = 容器高 × 16/9。zoom 改变 lane 总宽 widthPx,
// 但每帧仍维持 16:9,因此当前 zoom 下"刚好铺满"所需帧数 =
// ceil(widthPx / frameW)。这就是要渲染的张数 K。
// 后端预抽 N 张缓存(_TARGET_FRAMES_PER_FILE = 150),前端从 0..N-1 中
// 均匀挑 K 个 idx 显示;K ≤ N 时不糊,K > N 时全用 N 张靠 CSS 拉伸。

// 基于"后台抽帧 + 本地缓存"的 FilmStrip:
//   - mount 时拉一次 status,得到该文件已抽缩略图总数
//   - 缩略图未就绪时按 1 秒/秒间隔轮询,直到 ready
//   - 渲染固定 N 张图(N = status.count),容器宽度由 widthPx 决定
//   - zoom 变 → widthPx 变 → 浏览器原生拉伸,不再触发后端调用
const POLL_INTERVAL_MS = 2000
const FRAME_ASPECT = 16 / 9

export default function FilmStrip({ hue = 200, fogged = true, filePath, durationSec, widthPx, folder }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [thumbState, setThumbState] = useState({ key: '', count: 0, ready: false })
  const [height, setHeight] = useState(128)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!folder || !filePath) return
    const key = `${folder}|${filePath}`
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      const s = await getThumbnailStatus(folder, filePath)
      if (cancelled) return
      if (s.ready) {
        setThumbState({ key, ready: true, count: s.count })
      }
      if (!s.ready) {
        timer = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [folder, filePath])

  // 按 zoom + 16:9 算出当前应渲染张数 K,从已抽 count 张里均匀挑 idx,
  // 复用同一份磁盘缓存,任何 zoom 都不打后端。
  const frames = useMemo(() => {
    const key = folder && filePath ? `${folder}|${filePath}` : ''
    const ready = thumbState.ready && thumbState.key === key
    const count = ready ? thumbState.count : 0
    if (!ready || !folder || !filePath || count <= 0) return [] as { idx: number; url: string }[]
    const frameW = Math.max(1, Math.round(height * FRAME_ASPECT))
    const w = Math.max(0, widthPx ?? 0)
    const desired = Math.max(1, Math.ceil(w / frameW))
    const renderCount = Math.min(desired, count)
    return Array.from({ length: renderCount }, (_, i) => {
      const idx = renderCount === 1
        ? 0
        : Math.min(count - 1, Math.round((i * (count - 1)) / (renderCount - 1)))
      return { idx, url: thumbnailUrl(folder, filePath, idx) }
    })
  }, [thumbState, folder, filePath, height, widthPx])

  void durationSec
  const baseFrameW = Math.max(1, Math.round(height * FRAME_ASPECT))
  const renderFrameW = frames.length > 0
    ? Math.max(baseFrameW, Math.ceil(Math.max(0, widthPx ?? 0) / frames.length))
    : baseFrameW

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      {frames.length > 0 ? (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex',
          overflow: 'hidden',
          filter: fogged ? 'saturate(0.3) brightness(0.6)' : 'saturate(0.85)',
        }}>
          {frames.map((f) => (
            <img
              key={f.idx}
              src={f.url}
              alt=""
              loading="lazy"
              style={{
                flex: '0 0 auto',
                width: renderFrameW,
                height: '100%',
                objectFit: 'contain',
                display: 'block',
                background: '#050608',
              }}
              onError={(e) => { (e.target as HTMLImageElement).style.background = `hsl(${hue} 18% 30%)` }}
            />
          ))}
        </div>
      ) : (
        // 占位条:抽帧未就绪时铺一层带渐变,可点可拖,只是看不到画面。
        <div style={{
          position: 'absolute', inset: 0,
          background: `linear-gradient(90deg, hsl(${hue} 14% 28%) 0%, hsl(${hue} 18% 36%) 50%, hsl(${hue} 14% 28%) 100%)`,
          filter: fogged ? 'saturate(0.3)' : 'saturate(0.75)',
        }} />
      )}

      {/* Sprocket holes — top & bottom */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 0, height: 5,
        background: 'repeating-linear-gradient(90deg, #0b0d10 0 4px, transparent 4px 14px)',
      }} />
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, height: 5,
        background: 'repeating-linear-gradient(90deg, #0b0d10 0 4px, transparent 4px 14px)',
      }} />

      {fogged && (
        <>
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(20,20,24,0.75)',
          }} />
          <div style={{
            position: 'absolute', inset: 0,
            background: 'repeating-linear-gradient(45deg, transparent 0 5px, rgba(0,0,0,0.22) 5px 6px)',
          }} />
        </>
      )}
    </div>
  )
}
