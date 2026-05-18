// 对齐 dive_edit/analyze/edl.py::EDL.to_json
// 后端单向持久化到 _edl.json；前端 Timeline 双向绑定此结构

export type SegmentLabel = 'HULL' | 'INTRO'

export interface Segment {
  file: string        // absolute path on backend
  start: number       // seconds within source file
  end: number
  label: SegmentLabel | string
  score: number       // 0..1, higher = more inspection-like
  protected: boolean  // speech-locked (won't be dropped by target-duration trim)
}

export interface EDL {
  // Unified segment list. INTRO-labeled segments come first and drive the
  // cover/title display period; everything else is body content. Replaces
  // the previous split (intro_file + intro_speech_start/end + body_segments).
  segments: Segment[]
  target_duration_sec: number
  actual_body_duration_sec: number
  raw_body_duration_sec: number
  adaptive_padding_sec: number
}

// ── Overlay element (per-text-block live tweak) ──
// All values authored against a 1920×1080 canvas. Frontend scales by
// preview size; backend uses values verbatim in ASS \pos + ScaleX/ScaleY.
//   - position is relative to the element's natural anchor:
//       cover anchor = canvas center  → (0,0) means dead-center
//       small anchor = top-left 2%/2% → (0,0) means standard watermark
//   - scale_x / scale_y multiply the rendered size (1.0 = 100%). Drag a
//     corner = both axes equally. Drag an edge = one axis only.
export interface OverlayElement {
  font_size: number       // px in 1080 baseline
  line_spacing: number    // extra px added per line
  letter_spacing: number  // ASS Spacing field, px
  position_x: number      // offset from anchor, px in 1080 baseline
  position_y: number
  scale_x: number         // legacy anisotropic scale, no longer driven by UI
  scale_y: number         // legacy anisotropic scale
  whole_scale: number     // master multiplier — multiplies font + line + letter spacings (default 1.0)
  box_width: number       // text box max-width as percent of preview (20..100)
}

export const DEFAULT_COVER_OVERLAY: OverlayElement = {
  font_size: 44,
  line_spacing: 16,
  letter_spacing: 2,
  position_x: 0,
  position_y: 0,
  scale_x: 1.0,
  scale_y: 1.0,
  whole_scale: 1.0,
  box_width: 100,
}

export const DEFAULT_SMALL_OVERLAY: OverlayElement = {
  font_size: 18,
  line_spacing: 10,
  letter_spacing: 0,
  position_x: 0,
  position_y: 0,
  scale_x: 1.0,
  scale_y: 1.0,
  whole_scale: 1.0,
  box_width: 50,
}

// Logo overlay — top-right company watermark. Position is anchor-offset
// (px in 1080 baseline, +x = farther LEFT from right edge, +y = farther
// DOWN from top edge); scale is a uniform multiplier applied to the
// baseline 110px height. Backend ffmpeg overlay filter reads these to
// shift `overlay.logo_xy` and resize before compositing.
export interface LogoOverlay {
  position_x: number
  position_y: number
  scale: number
}

export const DEFAULT_LOGO_OVERLAY: LogoOverlay = {
  position_x: 0,
  position_y: 0,
  scale: 1.0,
}

// ── JobMeta (对齐 dive_edit/metadata.py::JobMeta) ──
export interface JobMeta {
  job_no: string
  vessel: string
  intro_file: string
  body_files: string[]
  cover_lines: string[]
  small_lines: string[]
  target_duration_min: number
  intro_speech_override?: [number, number] | null
  cover_overlay?: OverlayElement
  small_overlay?: OverlayElement
  logo_overlay?: LogoOverlay
  // 总开关:false 时 export 渲染跳过 title / watermark / logo,得到一份
  // "干净视频"(用户 2026-05-13 要求 hide overlay icon 导出无水印无 logo)。
  overlay_enabled?: boolean
}

// ── Pipeline 阶段进度 ──
export type PipelineStage = 'whisper' | 'intro' | 'ocr' | 'edl' | 'render'

// Append-only record of every [N/M] event the backend fired during
// a stage. The renderer uses the time gaps between events to estimate
// step duration on the fly — no hard-coded GPU/CPU multipliers.
export interface StageEvent {
  t: number       // Date.now()
  current: number
  total: number
}

export interface StageProgress {
  stage: PipelineStage
  status: 'pending' | 'running' | 'done' | 'error'
  current?: number
  total?: number
  message?: string
  // Set when status flips to 'running'.
  startedAt?: number
  // Every [N/M] event seen during this stage (oldest first). Cleared
  // when the stage flips back to 'pending'.
  events?: StageEvent[]
}

// ── 智能建议（Top 3 候选） ──
export type SuggestionKind = 'intro_candidate' | 'padding_flex'

export interface Suggestion {
  id: string
  kind: SuggestionKind
  human_time_sec?: number   // 哪个 timeline 位置触发
  title: string             // "file2 [350s-870s] (+40s 缓冲)"
  description: string
  preview: {                // 应用后的 segment 状态
    file: string
    start: number
    end: number
  }
  score: number             // 对比当前选择的接近度 0..1
}

// ── 3 运行模式 ──
export type RunMode = 'auto' | 'semi' | 'tweak'

// ── 字体参数（libass 方案） ──
export interface FontStyle {
  font_size: number
  font_color: string         // hex, e.g., "#FFFFFF"
  border_color: string       // hex
  border_width: number
  line_spacing: number
}

export interface OverlayConfig {
  cover: FontStyle
  small: FontStyle & { x: number; y: number }
  logo: { height: number; x: number; y: number }
}

// ── 文件列表项 ──
export interface VideoFile {
  name: string               // filename, e.g., "1.mp4"
  path: string               // absolute path
  duration_sec: number
  size_bytes: number
}
