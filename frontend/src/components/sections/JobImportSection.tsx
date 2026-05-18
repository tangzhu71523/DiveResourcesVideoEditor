import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, LayoutGrid, LayoutList, Trash2, Award, ListChecks } from 'lucide-react'
import type { JobMeta, VideoFile } from '@/types/edl'
import { pickFolder } from '@/lib/api'
import { formatDuration, formatBytes } from '@/lib/format'
import { lockTextSelect, unlockTextSelect } from '@/lib/dragLock'
import Tooltip from '../ui/Tooltip'

const DRAG_THRESHOLD_PX = 5
const LANE_DROP_SELECTOR = '[data-lane-drop-zone="true"]'

type ViewMode = 'list' | 'grid'

const LS_VIEW_KEY = 'dive_edit:import_view_mode'
const BODY_NONE_SENTINEL = '__DIVE_BODY_NONE__'

function loadViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(LS_VIEW_KEY)
    return v === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

interface Props {
  folder: string | null
  files: VideoFile[]
  jobMeta: JobMeta
  onJobMetaChange: (meta: JobMeta) => void
  onPickFolderByPath?: (path: string) => void
  previewSourcePath?: string | null
  // "Add files to lane" mode (toggled from the timeline toolbar). When
  // true, clicking a file row pushes it into laneFiles via onAddFileToLane.
  // Shift+click extends a range from the last single-click.
  addingFiles?: boolean
  onAddFileToLane?: (fileName: string) => void
}

export default function JobImportSection({
  folder, files, jobMeta, onJobMetaChange,
  onPickFolderByPath, previewSourcePath,
  addingFiles, onAddFileToLane,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode)
  // Right-click context menu — Delete / Intro. Position is the
  // pointer's clientX/Y so the menu pops where the user clicked.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: VideoFile } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  // Files the user has explicitly removed via right-click → Delete.
  // Hidden from the rendered list AND excluded from body_files when
  // present. Resets when the folder changes (different job).
  const [deletedState, setDeletedState] = useState<{ folder: string | null; files: Set<string> }>(() => ({
    folder,
    files: new Set(),
  }))
  const [selectedFileNames, setSelectedFileNames] = useState<Set<string>>(() => new Set())
  const deletedFiles = deletedState.folder === folder ? deletedState.files : new Set<string>()
  const visibleFiles = files.filter((f) => !deletedFiles.has(f.name))

  // Anchor for shift-click range add in addingFiles mode.
  const lastAddedIdxRef = useRef<number | null>(null)
  const lastSelectedIdxRef = useRef<number | null>(null)

  // Pointer-based drag from a file row into the timeline lane area.
  // HTML5 drag is forbidden (memory: project_ui_drag_removed.md — caused
  // white-screen crash in 2026-04). We mimic drag with mouse events:
  //   mousedown → arm   mousemove > 5px → ghost + body data attribute
  //   mouseup   → hit-test elementFromPoint against [data-lane-drop-zone]
  // Same callback as click-add (onAddFileToLane) so behaviour is identical.
  const dragArmRef = useRef<{ x: number; y: number; file: VideoFile } | null>(null)
  const didDragRef = useRef(false)
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; name: string } | null>(null)
  const dragGhostNextRef = useRef<{ x: number; y: number; name: string } | null>(null)
  const dragGhostRafRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (dragGhostRafRef.current !== null) cancelAnimationFrame(dragGhostRafRef.current)
    }
  }, [])

  const handleRowMouseDown = (e: React.MouseEvent, f: VideoFile) => {
    if (e.button !== 0) return
    dragArmRef.current = { x: e.clientX, y: e.clientY, file: f }
    didDragRef.current = false

    const onMove = (ev: MouseEvent) => {
      const arm = dragArmRef.current
      if (!arm) return
      const dx = ev.clientX - arm.x
      const dy = ev.clientY - arm.y
      if (!didDragRef.current && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
      if (!didDragRef.current) {
        didDragRef.current = true
        lockTextSelect()
        document.body.dataset.draggingFile = '1'
        document.body.style.cursor = 'grabbing'
      }
      dragGhostNextRef.current = { x: ev.clientX, y: ev.clientY, name: arm.file.name }
      if (dragGhostRafRef.current === null) {
        dragGhostRafRef.current = requestAnimationFrame(() => {
          dragGhostRafRef.current = null
          setDragGhost(dragGhostNextRef.current)
        })
      }
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const arm = dragArmRef.current
      dragArmRef.current = null
      if (didDragRef.current) {
        unlockTextSelect()
        delete document.body.dataset.draggingFile
        document.body.style.cursor = ''
        if (dragGhostRafRef.current !== null) {
          cancelAnimationFrame(dragGhostRafRef.current)
          dragGhostRafRef.current = null
        }
        dragGhostNextRef.current = null
        setDragGhost(null)
        if (arm) {
          const target = document.elementFromPoint(ev.clientX, ev.clientY)
          const dropZone = target?.closest(LANE_DROP_SELECTOR)
          if (dropZone && onAddFileToLane) onAddFileToLane(arm.file.name)
        }
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const handleAddRowClick = (e: React.MouseEvent, idx: number) => {
    if (didDragRef.current) return
    if (!addingFiles || !onAddFileToLane) return
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey && lastAddedIdxRef.current !== null) {
      const lo = Math.min(lastAddedIdxRef.current, idx)
      const hi = Math.max(lastAddedIdxRef.current, idx)
      for (let i = lo; i <= hi; i++) {
        const f = visibleFiles[i]
        if (f) onAddFileToLane(f.name)
      }
    } else {
      const f = visibleFiles[idx]
      if (f) onAddFileToLane(f.name)
      lastAddedIdxRef.current = idx
    }
  }

  // Generic row click → toggle the file's body_files membership. Whole
  // row is the hit-area now (not just the small checkbox).
  const handleRowClick = (e: React.MouseEvent, f: VideoFile, idx: number) => {
    if (didDragRef.current) return
    if (addingFiles) return
    if (e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      setSelectedFileNames((prev) => {
        const next = new Set(prev)
        if (lastSelectedIdxRef.current !== null) {
          const lo = Math.min(lastSelectedIdxRef.current, idx)
          const hi = Math.max(lastSelectedIdxRef.current, idx)
          for (let i = lo; i <= hi; i++) {
            const item = visibleFiles[i]
            if (item) next.add(item.name)
          }
        } else if (next.has(f.name)) {
          next.delete(f.name)
        } else {
          next.add(f.name)
        }
        return next
      })
      lastSelectedIdxRef.current = idx
      return
    }
    setSelectedFileNames(new Set([f.name]))
    lastSelectedIdxRef.current = idx
    toggleBody(f.name)
  }
  useEffect(() => {
    if (!ctxMenu) return
    const onDown = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const toggleViewMode = () => {
    const next: ViewMode = viewMode === 'list' ? 'grid' : 'list'
    setViewMode(next)
    try { localStorage.setItem(LS_VIEW_KEY, next) } catch { /* noop */ }
  }

  const handlePickFolder = async () => {
    const chosen = await pickFolder()
    if (chosen && onPickFolderByPath) onPickFolderByPath(chosen)
  }

  const setIntro = (filename: string) => {
    const next = jobMeta.intro_file === filename ? '' : filename
    onJobMetaChange({ ...jobMeta, intro_file: next })
  }

  const toggleBody = (filename: string) => {
    // Intro and body are independent: marking a file as intro does NOT
    // remove it from body, and toggling body does NOT affect intro.
    const bodyNone = jobMeta.body_files.includes(BODY_NONE_SENTINEL)
    const inAllow = !bodyNone && (jobMeta.body_files.length === 0 ? true : jobMeta.body_files.includes(filename))
    let nextBody: string[]
    if (bodyNone) {
      nextBody = [filename]
    } else if (jobMeta.body_files.length === 0) {
      nextBody = files
        .filter((f) => f.name !== filename)
        .map((f) => f.name)
    } else if (inAllow) {
      nextBody = jobMeta.body_files.filter((n) => n !== filename)
    } else {
      nextBody = [...jobMeta.body_files, filename]
    }
    onJobMetaChange({ ...jobMeta, body_files: nextBody })
  }

  const isBodyChecked = (filename: string): boolean => {
    if (jobMeta.body_files.includes(BODY_NONE_SENTINEL)) return false
    return jobMeta.body_files.length === 0 ? true : jobMeta.body_files.includes(filename)
  }

  const visibleNames = visibleFiles.map((f) => f.name)
  const selectedVisibleCount = jobMeta.body_files.includes(BODY_NONE_SENTINEL)
    ? 0
    : jobMeta.body_files.length === 0
      ? visibleNames.length
      : visibleNames.filter((name) => jobMeta.body_files.includes(name)).length
  const selectAllVisible = () => {
    onJobMetaChange({ ...jobMeta, body_files: visibleNames })
  }
  const selectNoVisible = () => {
    onJobMetaChange({ ...jobMeta, body_files: [BODY_NONE_SENTINEL] })
  }
  const allVisibleSelected = selectedVisibleCount === visibleFiles.length
  const toggleAllVisible = () => {
    if (allVisibleSelected) selectNoVisible()
    else selectAllVisible()
  }

  return (
    <div className="card-panel h-full">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          borderBottom: '1px solid var(--glass-border)',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          className="btn primary sm"
          onClick={handlePickFolder}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <FolderOpen size={12} /> Import
        </button>
        <div style={{ flex: 1 }} />
        {visibleFiles.length > 0 && (
          <>
            <span className="mono tabular-nums" style={{ fontSize: 10.5, color: 'rgb(var(--text-muted))' }}>
              {selectedVisibleCount}/{visibleFiles.length}
            </span>
            <Tooltip content={allVisibleSelected ? 'Select no files' : 'Select all files'}>
            <button
              type="button"
              className="btn ghost icon sm"
              onClick={toggleAllVisible}
            >
              <ListChecks size={14} />
            </button>
            </Tooltip>
            <Tooltip content={viewMode === 'list' ? 'Grid view' : 'List view'}>
            <button
              type="button"
              className="btn ghost icon sm"
              onClick={toggleViewMode}
            >
              {viewMode === 'list' ? <LayoutGrid size={13} /> : <LayoutList size={13} />}
            </button>
            </Tooltip>
          </>
        )}
      </div>

      <div className="panel-body">
        {visibleFiles.length === 0 ? (
          <div style={{ padding: '24px 12px', fontSize: 11, color: 'rgb(var(--text-muted))', textAlign: 'center' }}>
            {folder ? '⚠ No videos found' : 'Click Import to choose a job folder'}
          </div>
        ) : viewMode === 'list' ? (
          visibleFiles.map((f, idx) => {
            const isIntro = f.name === jobMeta.intro_file
            const bodyChecked = isBodyChecked(f.name)
            const isActive = previewSourcePath === f.path
            return (
              <Tooltip
                key={f.path}
                content={addingFiles
                  ? 'Click to add to lane · Shift+click for range'
                  : 'Click anywhere on the row to toggle · Right-click for menu'}
                side="right"
              >
              <div
                className={`file-row ${isActive ? 'active' : ''}`}
                onMouseDown={(e) => handleRowMouseDown(e, f)}
                onClick={(e) => {
                  if (addingFiles) handleAddRowClick(e, idx)
                  else handleRowClick(e, f, idx)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setCtxMenu({ x: e.clientX, y: e.clientY, file: f })
                }}
                style={{
                  cursor: 'pointer',
                  boxShadow: selectedFileNames.has(f.name) ? 'inset 0 0 0 2px rgb(var(--accent-500))' : undefined,
                  ...(isIntro ? { background: '#1e3a5f', borderColor: '#1e3a5f' } : {}),
                }}
              >
                <input type="checkbox" checked={bodyChecked}
                  onChange={() => toggleBody(f.name)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ accentColor: '#1e3a5f', flexShrink: 0 }}
                  aria-label={`include ${f.name}`}
                />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div className="mono" style={{ fontSize: 11, color: isIntro ? '#fff' : 'rgb(var(--text-primary))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name}
                  </div>
                  <div style={{ display: 'flex', gap: 10, fontSize: 10.5 }}>
                    <span className="mono tabular-nums" style={{ color: isIntro ? 'rgba(255,255,255,0.85)' : 'rgb(var(--text-secondary))' }}>{formatDuration(f.duration_sec)}</span>
                    <span className="mono tabular-nums" style={{ color: isIntro ? 'rgba(255,255,255,0.65)' : 'rgb(var(--text-muted))' }}>{formatBytes(f.size_bytes)}</span>
                  </div>
                </div>
              </div>
              </Tooltip>
            )
          })
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, padding: 6 }}>
            {visibleFiles.map((f, idx) => {
              const isIntro = f.name === jobMeta.intro_file
              const bodyChecked = isBodyChecked(f.name)
              const isActive = previewSourcePath === f.path
              const thumbUrl = `/api/preview_frame?file=${encodeURIComponent(f.path)}&offset_sec=1.0`
              return (
                <Tooltip
                  key={f.path}
                  content={addingFiles
                    ? 'Click to add to lane · Shift+click for range'
                    : 'Click anywhere on the card to toggle · Right-click for menu'}
                  side="right"
                >
                <div
                  onMouseDown={(e) => handleRowMouseDown(e, f)}
                  onClick={(e) => {
                    if (addingFiles) handleAddRowClick(e, idx)
                    else handleRowClick(e, f, idx)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setCtxMenu({ x: e.clientX, y: e.clientY, file: f })
                  }}
                  style={{
                    border: `1px solid ${isActive ? '#3b82f6' : isIntro ? '#1e3a5f' : 'var(--glass-border)'}`,
                    borderRadius: 5, overflow: 'hidden', cursor: 'pointer',
                    background: isIntro ? '#1e3a5f' : 'var(--glass-bg)',
                    boxShadow: selectedFileNames.has(f.name)
                      ? '0 0 0 2px rgb(var(--accent-500))'
                      : isActive ? '0 0 0 1px rgba(59,130,246,0.3)' : undefined,
                    transition: 'border-color 100ms, box-shadow 100ms, background 100ms',
                  }}
                >
                  <div style={{ position: 'relative', aspectRatio: '16/9', background: '#1a1a1a' }}>
                    <img src={thumbUrl} alt="" loading="lazy"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                    <span className="mono tabular-nums" style={{ position: 'absolute', bottom: 3, right: 3, fontSize: 9, background: 'rgba(0,0,0,0.7)', color: '#fff', padding: '1px 4px', borderRadius: 3 }}>
                      {formatDuration(f.duration_sec)}
                    </span>
                    <input type="checkbox" checked={bodyChecked}
                      onChange={() => toggleBody(f.name)} onClick={(e) => e.stopPropagation()}
                      style={{ position: 'absolute', top: 4, left: 4, accentColor: '#1e3a5f', width: 13, height: 13 }}
                      aria-label={`include ${f.name}`}
                    />
                  </div>
                  <div style={{ padding: '4px 5px 5px', display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                    <span className="mono" style={{ flex: 1, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isIntro ? '#fff' : 'rgb(var(--text-primary))' }}>
                      {f.name}
                    </span>
                  </div>
                </div>
                </Tooltip>
              )
            })}
          </div>
        )}
      </div>

      {dragGhost && createPortal(
        <div
          style={{
            position: 'fixed',
            left: dragGhost.x + 12,
            top: dragGhost.y + 12,
            zIndex: 10000,
            pointerEvents: 'none',
            padding: '4px 10px',
            background: 'rgb(var(--bg-surface))',
            border: '1px solid rgb(var(--accent-500))',
            borderRadius: 5,
            fontSize: 11,
            fontFamily: "'JetBrains Mono', Consolas, monospace",
            color: 'rgb(var(--text-primary))',
            boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
            maxWidth: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          + {dragGhost.name}
        </div>,
        document.body,
      )}

      {ctxMenu && createPortal(
        <div
          ref={ctxMenuRef}
          role="menu"
          style={{
            position: 'fixed',
            left: ctxMenu.x,
            top: ctxMenu.y,
            zIndex: 9999,
            minWidth: 160,
            background: 'rgb(var(--bg-surface))',
            border: '1px solid rgb(var(--border-strong))',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)',
            overflow: 'hidden',
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const f = ctxMenu.file
              setCtxMenu(null)
              const namesToRemove = selectedFileNames.has(f.name)
                ? new Set(selectedFileNames)
                : new Set([f.name])
              // Hide the row entirely + drop it from body_files so the
              // pipeline doesn't pick it back up. Also clear intro if
              // this file happens to be the marked intro.
              setDeletedState((prev) => {
                const next = new Set(prev.folder === folder ? prev.files : [])
                for (const name of namesToRemove) next.add(name)
                return { folder, files: next }
              })
              const nextBody = (jobMeta.body_files.length === 0
                ? files.filter((x) => !namesToRemove.has(x.name)).map((x) => x.name)
                : jobMeta.body_files.filter((n) => !namesToRemove.has(n)))
              const nextIntro = namesToRemove.has(jobMeta.intro_file) ? '' : jobMeta.intro_file
              setSelectedFileNames(new Set())
              onJobMetaChange({ ...jobMeta, body_files: nextBody, intro_file: nextIntro })
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', padding: '8px 12px',
              background: 'transparent', border: 'none',
              fontSize: 13, color: 'rgb(var(--danger))',
              cursor: 'pointer', textAlign: 'left',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(220,38,38,0.10)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <Trash2 size={14} /> Remove
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const f = ctxMenu.file
              setCtxMenu(null)
              setIntro(f.name)
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', padding: '8px 12px',
              background: 'transparent', border: 'none',
              fontSize: 13, color: 'rgb(var(--text-primary))',
              cursor: 'pointer', textAlign: 'left',
              borderTop: '1px solid rgb(var(--border-subtle))',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgb(var(--bg-raised))' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <Award size={14} /> {ctxMenu.file.name === jobMeta.intro_file ? 'Unmark Intro' : 'Set as Intro'}
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
