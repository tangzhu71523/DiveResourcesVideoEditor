// Thin API layer over the FastAPI backend. Endpoints mirror dive_edit/webui/server.py.

import type { EDL, JobMeta, VideoFile } from '@/types/edl'

// pywebview exposes a JS API bridge at window.pywebview.api when the page
// is loaded inside a packaged DiveEdit window. We prefer it for the folder
// picker because it routes to IFileOpenDialog (modern Explorer view).
// In a regular browser dev session window.pywebview is undefined → fall
// back to the HTTP endpoint, which uses PowerShell + FolderBrowserDialog
// (a tree control — not ideal but acceptable for dev).
declare global {
  interface Window {
    pywebview?: {
      api?: {
        pick_folder?: () => Promise<string | null>
      }
    }
  }
}

export async function pickFolder(): Promise<string | null> {
  // Frozen / desktop build: native IFileOpenDialog via pywebview.
  const native = window.pywebview?.api?.pick_folder
  if (native) {
    try {
      const folder = await native()
      return folder || null
    } catch {
      return null
    }
  }
  // Dev / browser: HTTP fallback.
  const res = await fetch('/api/pick-folder', { method: 'POST' })
  if (!res.ok) return null
  const data = (await res.json()) as { folder: string | null }
  return data.folder
}

export async function listFiles(folder: string): Promise<VideoFile[]> {
  const res = await fetch('/api/list-files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder }),
  })
  if (!res.ok) return []
  return (await res.json()) as VideoFile[]
}

export async function startThumbnails(folder: string, files: string[]): Promise<number> {
  try {
    const res = await fetch('/api/thumbnails/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, files }),
    })
    if (!res.ok) return 0
    const data = await res.json()
    return Number(data?.queued ?? 0)
  } catch {
    return 0
  }
}

export interface ThumbnailStatus { count: number; ready: boolean }

export async function getThumbnailStatus(folder: string, file: string): Promise<ThumbnailStatus> {
  try {
    const url = `/api/thumbnails/status?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}`
    const res = await fetch(url)
    if (!res.ok) return { count: 0, ready: false }
    return (await res.json()) as ThumbnailStatus
  } catch {
    return { count: 0, ready: false }
  }
}

export function thumbnailUrl(folder: string, file: string, idx: number): string {
  return `/api/thumbnail?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}&idx=${idx}`
}

export async function loadJob(folder: string): Promise<JobMeta | null> {
  const res = await fetch(`/api/job?folder=${encodeURIComponent(folder)}`)
  if (!res.ok) return null
  const data = await res.json()
  return data as JobMeta | null
}

export async function saveJob(folder: string, meta: JobMeta): Promise<void> {
  await fetch('/api/job', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, meta }),
  })
}

export interface AppSettings {
  volume?: number
  volume_cache?: number
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) return {}
    return (await res.json()) as AppSettings
  } catch {
    return {}
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
}

export async function loadEDL(folder: string): Promise<EDL | null> {
  const res = await fetch(`/api/edl?folder=${encodeURIComponent(folder)}`)
  if (!res.ok) return null
  const data = await res.json()
  return normalizeEDL(data)
}

export async function saveEDL(folder: string, edl: EDL): Promise<void> {
  // Backend writes to _edl.draft.json (not the official _edl.json).
  // Draft is promoted to official by /api/export, and dropped by
  // deleteEdlDraft() when the user switches job folder.
  await fetch('/api/edl', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, edl }),
  })
}

export async function deleteEdlDraft(folder: string): Promise<void> {
  await fetch(`/api/edl/draft?folder=${encodeURIComponent(folder)}`, { method: 'DELETE' })
}

// EDL baseline + history (super-undo persistence).
// Baseline = pipeline output frozen (deepest undo target).
// History = { entries: Snapshot[], cursor: number }. Each entry = full UI
// state (EDL + laneFiles + laneFileCache) at a commit point. Cursor =
// active entry index. Edit while cursor < last truncates entries
// past cursor (standard Photoshop/VSCode branch discard).
export interface HistorySnapshot {
  edl: EDL
  laneFiles: string[]
  laneFileCache: Array<[string, EDL['segments']]>
}

export interface EDLHistoryDoc {
  entries: HistorySnapshot[]
  cursor: number
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeSegment(raw: unknown, fallbackLabel = 'HULL'): EDL['segments'][number] | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const file = typeof obj.file === 'string' ? obj.file : ''
  const start = asNumber(obj.start)
  const end = asNumber(obj.end)
  if (!file || end <= start) return null
  return {
    file,
    start,
    end,
    label: typeof obj.label === 'string' && obj.label ? obj.label : fallbackLabel,
    score: asNumber(obj.score),
    protected: Boolean(obj.protected),
  }
}

function normalizeEDL(raw: unknown): EDL | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  let segments: EDL['segments'] = []
  if (Array.isArray(obj.segments)) {
    segments = obj.segments
      .map((s) => normalizeSegment(s))
      .filter((s): s is EDL['segments'][number] => s !== null)
  } else {
    const introFile = typeof obj.intro_file === 'string' ? obj.intro_file : ''
    const introStart = asNumber(obj.intro_speech_start)
    const introEnd = asNumber(obj.intro_speech_end)
    if (introFile && introEnd > introStart) {
      segments.push({
        file: introFile,
        start: introStart,
        end: introEnd,
        label: 'INTRO',
        score: 0,
        protected: true,
      })
    }
    if (Array.isArray(obj.body_segments)) {
      segments = [
        ...segments,
        ...obj.body_segments
          .map((s) => normalizeSegment(s))
          .filter((s): s is EDL['segments'][number] => s !== null),
      ]
    }
  }
  const bodyDuration = segments
    .filter((s) => s.label !== 'INTRO')
    .reduce((acc, s) => acc + (s.end - s.start), 0)
  return {
    segments,
    target_duration_sec: asNumber(obj.target_duration_sec),
    actual_body_duration_sec: asNumber(obj.actual_body_duration_sec, bodyDuration),
    raw_body_duration_sec: asNumber(obj.raw_body_duration_sec),
    adaptive_padding_sec: asNumber(obj.adaptive_padding_sec),
  }
}

export async function loadEDLBaseline(folder: string): Promise<EDL | null> {
  const res = await fetch(`/api/edl/baseline?folder=${encodeURIComponent(folder)}`)
  if (!res.ok) return null
  const data = await res.json()
  // Accept both current and legacy EDL schemas; normalize before React state.
  return normalizeEDL(data)
}

export async function loadEDLHistory(folder: string): Promise<EDLHistoryDoc | null> {
  const res = await fetch(`/api/edl/history?folder=${encodeURIComponent(folder)}`)
  if (!res.ok) return null
  const data = await res.json()
  if (!data || typeof data !== 'object') return null
  const doc = data as Partial<EDLHistoryDoc>
  if (!Array.isArray(doc.entries) || typeof doc.cursor !== 'number') return null
  // Older history entries are normalized too; unusable entries invalidate
  // the doc so folder load can fall through to baseline / edl.json.
  const entries: HistorySnapshot[] = []
  for (const entry of doc.entries) {
    if (!entry || typeof entry !== 'object') return null
    const rawEntry = entry as Partial<HistorySnapshot>
    const edl = normalizeEDL(rawEntry.edl)
    if (!edl) return null
    const laneFiles = Array.isArray(rawEntry.laneFiles)
      ? rawEntry.laneFiles.filter((v): v is string => typeof v === 'string')
      : []
    const laneFileCache = Array.isArray(rawEntry.laneFileCache)
      ? rawEntry.laneFileCache
          .map((pair) => {
            if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !Array.isArray(pair[1])) return null
            const segs = pair[1]
              .map((s) => normalizeSegment(s))
              .filter((s): s is EDL['segments'][number] => s !== null)
            return [pair[0], segs] as [string, EDL['segments']]
          })
          .filter((pair): pair is [string, EDL['segments']] => pair !== null)
      : []
    entries.push({ edl, laneFiles, laneFileCache })
  }
  return { entries, cursor: doc.cursor }
}

export async function saveEDLHistory(folder: string, doc: EDLHistoryDoc): Promise<void> {
  await fetch('/api/edl/history', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, entries: doc.entries, cursor: doc.cursor }),
  })
}

export async function deleteEDLHistory(folder: string): Promise<void> {
  await fetch(`/api/edl/history?folder=${encodeURIComponent(folder)}`, { method: 'DELETE' })
}

// Wipe analysis caches for a folder (transcripts / EDL / overlay.ass / logs).
// Called when the UI switches away from a job folder so the next time it's
// reopened the pipeline starts cold. Source videos, job.yaml, and output/
// are preserved. Returns the list of removed entries (for logging).
export async function cleanJobCache(folder: string): Promise<string[]> {
  const res = await fetch(`/api/job/cache?folder=${encodeURIComponent(folder)}`, { method: 'DELETE' })
  if (!res.ok) return []
  const data = (await res.json()) as { ok: boolean; removed?: string[] }
  return data.removed ?? []
}

// ── Overlay .ass (libass subtitle file for WYSIWYG text editor) ──
// Backend writes this next to _edl.json after a pipeline run.

export async function loadOverlayAss(folder: string): Promise<string | null> {
  const res = await fetch(`/api/overlay_ass?folder=${encodeURIComponent(folder)}`)
  if (!res.ok) return null
  const data = (await res.json()) as { content: string | null }
  return data.content ?? null
}

export async function openInExplorer(path: string): Promise<void> {
  await fetch('/api/open-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

// ── Pipeline run + live log stream ────────────────────────────────

export interface RunEvent {
  type: 'log' | 'stage' | 'done' | 'error'
  msg?: string
  stage?: 'whisper' | 'intro' | 'ocr' | 'edl' | 'render'
  status?: 'running' | 'done'
  current?: number
  total?: number
  exit_code?: number
}

export async function startRun(folder: string, workers?: number): Promise<string> {
  const body: Record<string, unknown> = { folder }
  if (workers !== undefined && workers !== null) body.workers = workers
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`start run failed (${res.status}): ${errBody}`)
  }
  const data = (await res.json()) as { job_id: string }
  return data.job_id
}

export interface SystemInfo {
  gpu_available: boolean
  cuda_runtime_ok: boolean    // GPU hardware AND CUDA DLLs loadable
  cuda_status: string         // "system_path" | "bundled" | "none" | "unset"
  cudnn_status: string        // "ok" | "missing:..." | "unset"
  force_cpu: boolean
  auto_workers: number
  workers_cap: number
  gpu_msg: string
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(`health check failed (${res.status})`)
  const data = (await res.json()) as SystemInfo & { status: string }
  return {
    gpu_available: Boolean(data.gpu_available),
    cuda_runtime_ok: Boolean(data.cuda_runtime_ok ?? data.gpu_available),
    cuda_status: String(data.cuda_status ?? 'unset'),
    cudnn_status: String((data as SystemInfo).cudnn_status ?? 'unset'),
    force_cpu: Boolean((data as SystemInfo).force_cpu ?? false),
    auto_workers: Number(data.auto_workers ?? 1),
    workers_cap: Number(data.workers_cap ?? 5),
    gpu_msg: String(data.gpu_msg ?? ''),
  }
}

export async function cancelRun(job_id: string): Promise<boolean> {
  const res = await fetch('/api/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id }),
  })
  if (!res.ok) return false
  const data = (await res.json()) as { ok: boolean }
  return data.ok
}

export function connectLogs(
  job_id: string,
  onEvent: (e: RunEvent) => void,
  onClose?: () => void,
): () => void {
  // Vite dev-server proxies ws:// paths per vite.config.ts.
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${window.location.host}/ws/logs?job_id=${encodeURIComponent(job_id)}`
  const ws = new WebSocket(url)
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as RunEvent
      onEvent(data)
    } catch {
      onEvent({ type: 'log', msg: String(ev.data) })
    }
  }
  ws.onclose = () => {
    if (onClose) onClose()
  }
  ws.onerror = () => {
    onEvent({ type: 'error', msg: 'WebSocket error' })
  }
  return () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }
}

// ── Export (render-only) ──────────────────────────────────────────

export async function startExport(folder: string, output_dir: string): Promise<string> {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, output_dir }),
  })
  if (!res.ok) {
    let detail = `export failed (${res.status})`
    try {
      const body = (await res.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      // ignore json parse error; keep status-based message
    }
    throw new Error(detail)
  }
  const data = (await res.json()) as { job_id: string }
  return data.job_id
}

// ── Folder validation (manual path input) ─────────────────────────

export interface ValidateFolderResult {
  ok: boolean
  message?: string
  file_count?: number
}

export async function validateFolder(folder: string): Promise<ValidateFolderResult> {
  try {
    const res = await fetch('/api/validate-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    })
    if (!res.ok) return { ok: false, message: `Server error (${res.status})` }
    return (await res.json()) as ValidateFolderResult
  } catch {
    return { ok: false, message: 'Cannot connect to server' }
  }
}

// ── Preview cache (on-demand transcode to H.264 MP4 for native seek) ──

export interface PreviewCacheStatus {
  ready: boolean
  transcoding: boolean
  queued?: boolean
  priority?: number | null
  size_bytes: number
  progress?: number
  progress_percent?: number
  stage?: string
  error?: string | null
  profile?: {
    name?: string
    height?: number
    video_bitrate?: string
    audio_bitrate?: string
    codec?: string
    memory_total_gb?: number
    memory_available_gb?: number
    memory_load_pct?: number
    nvenc?: boolean
  }
}

export async function getPreviewCacheStatus(file: string): Promise<PreviewCacheStatus> {
  const r = await fetch(`/api/preview_cache/status?file=${encodeURIComponent(file)}`)
  if (!r.ok) return { ready: false, transcoding: false, size_bytes: 0 }
  return (await r.json()) as PreviewCacheStatus
}

export async function startPreviewCache(file: string, priority = 50): Promise<PreviewCacheStatus> {
  const url = `/api/preview_cache/start?file=${encodeURIComponent(file)}&priority=${encodeURIComponent(priority)}`
  const r = await fetch(url, { method: 'POST' })
  if (!r.ok) return { ready: false, transcoding: false, size_bytes: 0 }
  return (await r.json()) as PreviewCacheStatus
}

export function previewCacheMp4Url(file: string): string {
  return `/api/preview_cache/mp4?file=${encodeURIComponent(file)}`
}
