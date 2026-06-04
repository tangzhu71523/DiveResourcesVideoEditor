import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, Eye, FolderOpen, GripVertical, Trash2 } from 'lucide-react'
import type { JobMeta, SourceEDLSegment, VideoFile } from '@/types/edl'
import { pickFolder } from '@/lib/api'
import { formatDuration, formatBytes } from '@/lib/format'
import { lockTextSelect, unlockTextSelect } from '@/lib/dragLock'
import Tooltip from '../ui/Tooltip'

const DRAG_THRESHOLD_PX = 5
const LANE_DROP_SELECTOR = '[data-lane-drop-zone="true"]'

const fileSelectionKey = (f: VideoFile): string => f.path || f.name

type DragArm =
  { x: number; y: number; name: string; file: VideoFile }
type ReorderArm =
  { x: number; y: number; name: string; rect: DOMRect; pointerId: number; target: HTMLElement }

interface PipelineOutputWindow extends SourceEDLSegment {
  exportedStart?: number
  exportedEnd?: number
}

interface CacheOutput {
  token: string
  name: string
  durationSec: number
  windows: PipelineOutputWindow[]
}

interface Props {
  folder: string | null
  files: VideoFile[]
  jobMeta: JobMeta
  onJobMetaChange: (meta: JobMeta) => void
  onPickFolderByPath?: (path: string) => void
  onPreviewFile?: (file: VideoFile) => void
  onPreviewFileFullscreen?: (file: VideoFile) => void
  // "Add files to lane" mode (toggled from the timeline toolbar). When
  // true, clicking a file row pushes it into laneFiles via onAddFileToLane.
  // Shift+click extends a range from the last single-click.
  addingFiles?: boolean
  onAddFileToLane?: (fileName: string) => void
  manualOutput?: CacheOutput | null
  pipelineOutputs?: CacheOutput[]
  activeRawFile?: string | null
  activeCacheToken?: string | null
  onSelectedFilesChange?: (files: string[]) => void
  onReorderFiles?: (fromName: string, toName: string, placement?: 'before' | 'after') => void
  onOpenRawFile?: (fileName: string) => void
  onOpenCache?: (token: string) => void
}

export default function JobImportSection({
  folder, files, jobMeta, onJobMetaChange,
  onPickFolderByPath, onPreviewFile, onPreviewFileFullscreen,
  addingFiles, onAddFileToLane,
  manualOutput = null,
  pipelineOutputs = [],
  activeRawFile = null,
  activeCacheToken = null,
  onSelectedFilesChange,
  onReorderFiles,
  onOpenRawFile,
  onOpenCache,
}: Props) {
  // Right-click context menu - Delete / Intro. Position is the
  // pointer's clientX/Y so the menu pops where the user clicked.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: VideoFile } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  // Files the user has explicitly removed via right-click -> Delete.
  // Hidden from the rendered list AND excluded from body_files when
  // present. Resets when the folder changes (different job).
  const [deletedState, setDeletedState] = useState<{ folder: string | null; files: Set<string> }>(() => ({
    folder,
    files: new Set(),
  }))
  const [selectedFileKeysRaw, setSelectedFileKeysRaw] = useState<Set<string>>(() => new Set())
  const [listMode, setListMode] = useState<'raw' | 'cache'>('raw')
  const [collapsedWindowState, setCollapsedWindowState] = useState<{ folder: string | null; files: Set<string> }>(() => ({
    folder,
    files: new Set(),
  }))
  const deletedFiles = deletedState.folder === folder ? deletedState.files : new Set<string>()
  const collapsedWindowFiles = collapsedWindowState.folder === folder ? collapsedWindowState.files : new Set<string>()
  const filteredVisibleFiles = files.filter((f) => !deletedFiles.has(f.name))
  const hiddenAllRawFiles = files.length > 0 && filteredVisibleFiles.length === 0
  const visibleFiles = hiddenAllRawFiles ? files : filteredVisibleFiles
  const visibleSelectionKeys = useMemo(() => new Set(visibleFiles.map(fileSelectionKey)), [visibleFiles])
  const cacheOutputs = useMemo(() => [
    ...(manualOutput ? [manualOutput] : []),
    ...pipelineOutputs,
  ], [manualOutput, pipelineOutputs])
  const selectedFileKeys = useMemo(() => {
    const next = new Set<string>()
    for (const key of selectedFileKeysRaw) {
      if (visibleSelectionKeys.has(key) || cacheOutputs.some((output) => output.token === key)) next.add(key)
    }
    return next
  }, [selectedFileKeysRaw, visibleSelectionKeys, cacheOutputs])

  useEffect(() => {
    onSelectedFilesChange?.(
      visibleFiles
        .filter((file) => selectedFileKeys.has(fileSelectionKey(file)))
        .map((file) => file.path || file.name),
    )
  }, [onSelectedFilesChange, selectedFileKeys, visibleFiles])

  // Anchor for shift-click range add in addingFiles mode.
  const lastAddedIdxRef = useRef<number | null>(null)
  const lastSelectedIdxRef = useRef<number | null>(null)
  const lastSelectedKeyRef = useRef<string | null>(null)
  const collapseKnownKeysRef = useRef<{ folder: string | null; keys: Set<string> }>({ folder: null, keys: new Set() })

  useEffect(() => {
    const keys = new Set<string>([
      ...cacheOutputs.map((output) => output.token),
      ...visibleFiles.map((file) => file.name),
    ])
    setCollapsedWindowState((prev) => {
      const known = collapseKnownKeysRef.current
      if (known.folder !== folder) {
        collapseKnownKeysRef.current = { folder, keys }
        return { folder, files: new Set(keys) }
      }
      const next = new Set(prev.folder === folder ? prev.files : [])
      let changed = false
      for (const key of keys) {
        if (!known.keys.has(key)) {
          next.add(key)
          changed = true
        }
      }
      collapseKnownKeysRef.current = { folder, keys }
      return changed ? { folder, files: next } : prev
    })
  }, [folder, cacheOutputs, visibleFiles])

  // Pointer-based drag from a file row into the timeline lane area.
  // HTML5 drag is forbidden (memory: project_ui_drag_removed.md - caused
  // white-screen crash in 2026-04). We mimic drag with mouse events:
  //   mousedown -> arm   mousemove > 5px -> ghost + body data attribute
  //   mouseup   -> hit-test elementFromPoint against [data-lane-drop-zone]
  // Same callback as click-add (onAddFileToLane) so behaviour is identical.
  const importPanelRef = useRef<HTMLDivElement>(null)
  const dragArmRef = useRef<DragArm | null>(null)
  const didDragRef = useRef(false)
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; name: string } | null>(null)
  const dragGhostNextRef = useRef<{ x: number; y: number; name: string } | null>(null)
  const dragGhostRafRef = useRef<number | null>(null)
  const reorderArmRef = useRef<ReorderArm | null>(null)
  const didReorderDragRef = useRef(false)
  const [reorderTarget, setReorderTarget] = useState<{ idx: number; placement: 'before' | 'after' } | null>(null)
  const [reorderDraggingName, setReorderDraggingName] = useState<string | null>(null)
  const [reorderDragDeltaY, setReorderDragDeltaY] = useState(0)
  const [reorderDragBox, setReorderDragBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const reorderTargetRef = useRef<{ idx: number; placement: 'before' | 'after' } | null>(null)
  const cancelFileDragRef = useRef<(() => void) | null>(null)
  const cancelReorderDragRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      cancelFileDragRef.current?.()
      cancelReorderDragRef.current?.()
      if (dragGhostRafRef.current !== null) cancelAnimationFrame(dragGhostRafRef.current)
    }
  }, [])

  const beginDrag = (e: React.MouseEvent, arm: DragArm) => {
    if (e.button !== 0) return
    dragArmRef.current = { ...arm, x: e.clientX, y: e.clientY }
    didDragRef.current = false

    const clearVisualState = () => {
      if (didDragRef.current) unlockTextSelect()
      if (dragGhostRafRef.current !== null) {
        cancelAnimationFrame(dragGhostRafRef.current)
        dragGhostRafRef.current = null
      }
      dragGhostNextRef.current = null
      setDragGhost(null)
      delete document.body.dataset.draggingFile
      document.body.style.cursor = ''
      didDragRef.current = false
    }

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
      dragGhostNextRef.current = { x: ev.clientX, y: ev.clientY, name: arm.name }
      if (dragGhostRafRef.current === null) {
        dragGhostRafRef.current = requestAnimationFrame(() => {
          dragGhostRafRef.current = null
          setDragGhost(dragGhostNextRef.current)
        })
      }
    }

    const detach = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('dive.cancelPointerOps', onCancel)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      document.removeEventListener('mouseleave', onDocumentMouseLeave)
      cancelFileDragRef.current = null
    }

    const onUp = (ev: MouseEvent) => {
      detach()
      const arm = dragArmRef.current
      dragArmRef.current = null
      if (didDragRef.current) {
        if (arm) {
          const target = document.elementFromPoint(ev.clientX, ev.clientY)
          const dropZone = target?.closest(LANE_DROP_SELECTOR)
          if (dropZone && onAddFileToLane) onAddFileToLane(arm.file.name)
        }
      }
      clearVisualState()
    }

    const onCancel = () => {
      detach()
      dragArmRef.current = null
      clearVisualState()
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') onCancel()
    }

    const onDocumentMouseLeave = (ev: MouseEvent) => {
      if (ev.relatedTarget === null) onCancel()
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onCancel)
    window.addEventListener('dive.cancelPointerOps', onCancel)
    document.addEventListener('visibilitychange', onVisibilityChange)
    document.addEventListener('mouseleave', onDocumentMouseLeave)
    cancelFileDragRef.current = onCancel
  }

  const handleRowMouseDown = (e: React.MouseEvent, f: VideoFile) => {
    beginDrag(e, { x: e.clientX, y: e.clientY, name: f.name, file: f })
  }

  const toggleWindowCollapse = (e: React.MouseEvent, fileName: string) => {
    e.preventDefault()
    e.stopPropagation()
    setCollapsedWindowState((prev) => {
      const next = new Set(prev.folder === folder ? prev.files : [])
      if (next.has(fileName)) next.delete(fileName)
      else next.add(fileName)
      return { folder, files: next }
    })
  }

  const jumpToPipelineWindow = (e: React.SyntheticEvent, output: CacheOutput, winIdx: number) => {
    e.preventDefault()
    e.stopPropagation()
    const win = output.windows[winIdx]
    if (!win) return
    setSelectedFileKeysRaw(new Set([output.token]))
    onOpenCache?.(output.token)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('dive.scrollToSourceWindow', {
        detail: {
          pipelineToken: output.token,
          file: win.file,
          name: win.file.split(/[\\/]/).pop() ?? win.file,
          start: win.start,
          end: win.end,
          label: win.label,
        },
      }))
    }, 60)
  }

  const handleReorderPointerDown = (e: React.PointerEvent, f: VideoFile) => {
    if (e.button !== 0 || !onReorderFiles) return
    e.preventDefault()
    e.stopPropagation()
    const block = (e.currentTarget as HTMLElement).closest('[data-file-block-index]') as HTMLElement | null
    if (!block) return
    const rect = block.getBoundingClientRect()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture?.(e.pointerId)
    reorderArmRef.current = { x: e.clientX, y: e.clientY, name: f.name, rect, pointerId: e.pointerId, target }
    didReorderDragRef.current = false
    reorderTargetRef.current = null

    const findInsertTarget = (ev: PointerEvent, arm: ReorderArm, dy: number): { idx: number; placement: 'before' | 'after' } | null => {
      const panel = importPanelRef.current
      if (!panel) return null
      const panelRect = panel.getBoundingClientRect()
      if (
        ev.clientX < panelRect.left ||
        ev.clientX > panelRect.right ||
        ev.clientY < panelRect.top ||
        ev.clientY > panelRect.bottom
      ) return null
      const fromIdx = visibleFiles.findIndex((item) => item.name === f.name)
      if (fromIdx < 0) return null
      const draggedTop = arm.rect.top + dy
      const draggedBottom = draggedTop + arm.rect.height
      const blocks = Array.from(panel.querySelectorAll<HTMLElement>('[data-file-block-index]'))
        .filter((el) => el.dataset.fileBlockIndex !== String(fromIdx))
      let best: { idx: number; placement: 'before' | 'after'; distance: number } | null = null
      for (const el of blocks) {
        const rawIdx = el.dataset.fileBlockIndex
        const idx = rawIdx === undefined ? null : Number(rawIdx)
        if (!Number.isFinite(idx) || idx === null) continue
        const targetFile = visibleFiles[idx]
        if (!targetFile || targetFile.name === f.name) continue
        const rect = el.getBoundingClientRect()
        const topGate = rect.top + rect.height * 0.62
        const bottomGate = rect.bottom - rect.height * 0.62
        const movingUp = dy < 0 && draggedTop < topGate
        const movingDown = dy > 0 && draggedBottom > bottomGate
        if (!movingUp && !movingDown) continue
        const placement = movingUp ? 'before' : 'after'
        const distance = Math.abs((movingUp ? draggedTop : draggedBottom) - (movingUp ? rect.top : rect.bottom))
        if (!best || distance < best.distance) best = { idx, placement, distance }
      }
      if (!best) return null
      const { idx, placement } = best
      const isNoopAdjacent =
        (fromIdx < idx && placement === 'before' && idx === fromIdx + 1) ||
        (fromIdx > idx && placement === 'after' && idx === fromIdx - 1)
      if (isNoopAdjacent) return null
      return { idx, placement }
    }

    const detachReorder = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('dive.cancelPointerOps', onCancel)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      document.removeEventListener('mouseleave', onDocumentMouseLeave)
      cancelReorderDragRef.current = null
    }

    const onMove = (ev: PointerEvent) => {
      const arm = reorderArmRef.current
      if (!arm || ev.pointerId !== arm.pointerId) return
      const dx = ev.clientX - arm.x
      const dy = ev.clientY - arm.y
      if (!didReorderDragRef.current && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
      ev.preventDefault()
      if (!didReorderDragRef.current) {
        didReorderDragRef.current = true
        lockTextSelect()
        setReorderDraggingName(arm.name)
        setReorderDragBox({ left: arm.rect.left, top: arm.rect.top, width: arm.rect.width, height: arm.rect.height })
        setReorderDragDeltaY(0)
        document.body.style.cursor = 'grabbing'
      }
      setReorderDragDeltaY(dy)
      const nextTarget = findInsertTarget(ev, arm, dy)
      reorderTargetRef.current = nextTarget
      setReorderTarget(nextTarget)
      document.body.style.cursor = nextTarget ? 'grabbing' : 'no-drop'
    }

    const onUp = (ev: PointerEvent) => {
      const arm = reorderArmRef.current
      if (arm && ev.pointerId !== arm.pointerId) return
      detachReorder()
      reorderArmRef.current = null
      if (arm) arm.target.releasePointerCapture?.(arm.pointerId)
      if (didReorderDragRef.current) {
        unlockTextSelect()
        document.body.style.cursor = ''
        const targetInfo = reorderTargetRef.current
        const toFile = targetInfo ? visibleFiles[targetInfo.idx] : null
        if (arm && toFile && toFile.name !== arm.name) onReorderFiles(arm.name, toFile.name, targetInfo?.placement)
      }
      didReorderDragRef.current = false
      reorderTargetRef.current = null
      setReorderTarget(null)
      setReorderDraggingName(null)
      setReorderDragDeltaY(0)
      setReorderDragBox(null)
    }

    const onCancel = (ev?: PointerEvent | Event) => {
      const arm = reorderArmRef.current
      if (arm && ev instanceof PointerEvent && ev.pointerId !== arm.pointerId) return
      detachReorder()
      if (arm) arm.target.releasePointerCapture?.(arm.pointerId)
      reorderArmRef.current = null
      if (didReorderDragRef.current) unlockTextSelect()
      didReorderDragRef.current = false
      reorderTargetRef.current = null
      document.body.style.cursor = ''
      setReorderTarget(null)
      setReorderDraggingName(null)
      setReorderDragDeltaY(0)
      setReorderDragBox(null)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') onCancel()
    }

    const onDocumentMouseLeave = (ev: MouseEvent) => {
      if (ev.relatedTarget === null) onCancel()
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    window.addEventListener('dive.cancelPointerOps', onCancel)
    document.addEventListener('visibilitychange', onVisibilityChange)
    document.addEventListener('mouseleave', onDocumentMouseLeave)
    cancelReorderDragRef.current = () => onCancel()
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

  // Generic row click only marks rows for local UI selection/context actions.
  // Pipeline include/exclude is intentionally limited to the checkbox.
  const handleRowClick = (e: React.MouseEvent, f: VideoFile, idx: number) => {
    if (didDragRef.current) return
    if (addingFiles) return
    if (e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      const clickedKey = fileSelectionKey(f)
      const anchorIdx = lastSelectedKeyRef.current
        ? visibleFiles.findIndex((item) => fileSelectionKey(item) === lastSelectedKeyRef.current)
        : lastSelectedIdxRef.current
      setSelectedFileKeysRaw((prev) => {
        const next = new Set(prev)
        if (anchorIdx !== null && anchorIdx >= 0) {
          const lo = Math.min(anchorIdx, idx)
          const hi = Math.max(anchorIdx, idx)
          for (let i = lo; i <= hi; i++) {
            const item = visibleFiles[i]
            if (item) next.add(fileSelectionKey(item))
          }
        } else if (next.has(clickedKey)) {
          next.delete(clickedKey)
        } else {
          next.add(clickedKey)
        }
        return next
      })
      lastSelectedIdxRef.current = idx
      lastSelectedKeyRef.current = clickedKey
      return
    }
    const clickedKey = fileSelectionKey(f)
    setSelectedFileKeysRaw(new Set([clickedKey]))
    lastSelectedIdxRef.current = idx
    lastSelectedKeyRef.current = clickedKey
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

  const handlePickFolder = async () => {
    const chosen = await pickFolder()
    if (chosen && onPickFolderByPath) onPickFolderByPath(chosen)
  }

  const reorderDraggingFile = reorderDraggingName
    ? visibleFiles.find((item) => item.name === reorderDraggingName) ?? null
    : null
  const pipelineVirtualFiles = cacheOutputs.map((output) => ({ output }))
  const windowBlockKeys = [
    ...cacheOutputs.map((output) => output.token),
    ...visibleFiles.map((file) => file.name),
  ]
  const allWindowBlocksCollapsed = windowBlockKeys.length > 0
    && windowBlockKeys.every((key) => collapsedWindowFiles.has(key))
  const toggleAllWindowBlocks = () => {
    setCollapsedWindowState((prev) => {
      const next = new Set(prev.folder === folder ? prev.files : [])
      if (allWindowBlocksCollapsed) {
        for (const key of windowBlockKeys) next.delete(key)
      } else {
        for (const key of windowBlockKeys) next.add(key)
      }
      return { folder, files: next }
    })
  }
  return (
    <div className="card-panel h-full" data-import-panel="true" ref={importPanelRef}>
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
        {(visibleFiles.length > 0 || cacheOutputs.length > 0) && (
          <>
            <span className="mono tabular-nums" style={{ fontSize: 10.5, color: 'rgb(var(--text-muted))' }}>
              {listMode === 'raw' ? `${visibleFiles.length} raw` : `${cacheOutputs.length} cache`}
            </span>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setListMode((mode) => mode === 'raw' ? 'cache' : 'raw')}
              style={{ minWidth: 54, justifyContent: 'center' }}
            >
              {listMode === 'raw' ? 'Cache' : 'Raw'}
            </button>
            {windowBlockKeys.length > 0 && (
              <button
                type="button"
                className="btn ghost icon sm"
                onClick={toggleAllWindowBlocks}
                aria-label={allWindowBlocksCollapsed ? 'expand all windows' : 'collapse all windows'}
              >
                {allWindowBlocksCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
          </>
        )}
      </div>

      <div className="panel-body">
        {visibleFiles.length === 0 && cacheOutputs.length === 0 ? (
          <div style={{ padding: '24px 12px', fontSize: 11, color: 'rgb(var(--text-muted))', textAlign: 'center' }}>
            {folder ? 'No videos found' : 'Click Import to choose a job folder'}
          </div>
        ) : (
          <>
          {listMode === 'cache' && pipelineVirtualFiles.map(({ output }) => {
            const isCollapsed = collapsedWindowFiles.has(output.token)
            return (
              <div
                key={output.token}
                data-file-block-index={output.token}
                style={{
                  position: 'relative',
                  margin: '2px 4px 9px',
                  padding: '3px 3px 5px',
                  borderRadius: 6,
                  border: '1px solid rgb(var(--border-subtle))',
                  borderLeft: '5px solid var(--chip-blue-color)',
                  background: 'rgb(var(--bg-muted) / 0.25)',
                  boxShadow: selectedFileKeys.has(output.token) || activeCacheToken === output.token
                    ? '0 0 0 2px rgb(var(--accent-500))'
                    : undefined,
                  transition: 'box-shadow 120ms ease, background 120ms ease',
                }}
              >
                <div
                  className="file-row"
                  onClick={(e) => {
                    if (didDragRef.current) return
                    e.preventDefault()
                    e.stopPropagation()
                    if (addingFiles && onAddFileToLane) onAddFileToLane(output.token)
                    else onOpenCache?.(output.token)
                    setSelectedFileKeysRaw(new Set([output.token]))
                  }}
                  style={{ cursor: 'pointer', borderBottom: 'none', background: 'transparent' }}
                >
                  <div style={{ width: 24, height: 30, flexShrink: 0, display: 'grid', placeItems: 'center', color: 'var(--chip-blue-color)' }}>
                    <GripVertical size={13} />
                  </div>
                  <div style={{ width: 13, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div className="mono" style={{ fontSize: 11, color: 'rgb(var(--text-primary))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 700 }}>
                      {output.name}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 8, rowGap: 2, fontSize: 10.5, minWidth: 0 }}>
                      <span className="mono tabular-nums" style={{ color: 'rgb(var(--text-secondary))', whiteSpace: 'nowrap' }}>{formatDuration(output.durationSec)}</span>
                      <span className="mono tabular-nums" style={{ color: 'var(--chip-blue-color)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {output.windows.length} WINDOW{output.windows.length === 1 ? '' : 'S'}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn ghost icon sm"
                    aria-label={isCollapsed ? `show windows for ${output.name}` : `hide windows for ${output.name}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => toggleWindowCollapse(e, output.token)}
                    style={{ width: 24, height: 24, flexShrink: 0 }}
                  >
                    {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  </button>
                </div>
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '4px 8px 0 44px' }}>
                    {output.windows.map((win, winIdx) => (
                      <div
                        key={`${output.token}-window-${winIdx}-${win.start}-${win.end}`}
                        role="button"
                        tabIndex={0}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => jumpToPipelineWindow(e, output, winIdx)}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          jumpToPipelineWindow(e, output, winIdx)
                        }}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '34px 1fr',
                          alignItems: 'center',
                          gap: 6,
                          minHeight: 20,
                          borderRadius: 4,
                          border: '1px solid var(--chip-blue-border)',
                          background: 'var(--chip-solid-bg)',
                          boxShadow: 'var(--btn-primary-shadow)',
                          padding: '2px 6px',
                          cursor: 'pointer',
                        }}
                      >
                        <span className="mono tabular-nums" style={{ fontSize: 10, fontWeight: 700, color: '#f7f5ef' }}>
                          #{winIdx + 1}
                        </span>
                        <span className="mono tabular-nums" style={{ minWidth: 0, fontSize: 10.5, color: '#f7f5ef', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {formatDuration(win.start)}-{formatDuration(win.end)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {listMode === 'raw' && visibleFiles.map((f, idx) => {
            const isReorderDragging = reorderDraggingName === f.name
            const reorderFromIdx = reorderDraggingName
              ? visibleFiles.findIndex((item) => item.name === reorderDraggingName)
              : -1
            const rawInsertIdx = reorderTarget
              ? reorderTarget.placement === 'after' ? reorderTarget.idx + 1 : reorderTarget.idx
              : -1
            const visualInsertIdx = reorderTarget && reorderFromIdx >= 0
              ? rawInsertIdx > reorderFromIdx ? rawInsertIdx - 1 : rawInsertIdx
              : -1
            const isShiftedForReorder = reorderTarget && reorderFromIdx >= 0 && !isReorderDragging
              ? reorderFromIdx < visualInsertIdx
                ? idx > reorderFromIdx && idx <= visualInsertIdx
                : idx >= visualInsertIdx && idx < reorderFromIdx
              : false
            const reorderShiftDistance = reorderDragBox ? reorderDragBox.height + 9 : 34
            const reorderShiftPx = isShiftedForReorder
              ? reorderFromIdx < visualInsertIdx ? -reorderShiftDistance : reorderShiftDistance
              : 0
            return (
              <div
                key={f.path}
                data-file-block-index={idx}
                style={{
                  position: 'relative',
                  margin: '2px 4px 7px',
                  padding: '3px 3px 5px',
                  borderRadius: 6,
                  border: '1px solid rgb(var(--border-subtle))',
                  borderLeft: '5px solid var(--chip-blue-color)',
                  background: 'rgb(var(--bg-muted) / 0.25)',
                  pointerEvents: isReorderDragging ? 'none' : undefined,
                  transform: reorderShiftPx
                      ? `translate3d(0, ${reorderShiftPx}px, 0)`
                      : 'translate3d(0, 0, 0)',
                  opacity: isReorderDragging ? 0 : 1,
                  zIndex: reorderShiftPx ? 5 : 1,
                  boxShadow: selectedFileKeys.has(fileSelectionKey(f)) || activeRawFile === f.name
                      ? '0 0 0 2px rgb(var(--accent-500))'
                    : reorderShiftPx
                      ? '0 5px 12px rgba(15,23,42,0.10)'
                      : undefined,
                  transition: 'transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease, background 120ms ease',
                }}
              >
                <Tooltip content={null} side="right">
              <div
                data-file-row-index={idx}
                className="file-row"
                onMouseDown={(e) => handleRowMouseDown(e, f)}
                onClick={(e) => {
                  if (addingFiles) handleAddRowClick(e, idx)
                  else {
                    handleRowClick(e, f, idx)
                    onOpenRawFile?.(f.name)
                  }
                }}
                onDoubleClick={(e) => {
                  if (addingFiles || didDragRef.current) return
                  e.preventDefault()
                  e.stopPropagation()
                  onPreviewFileFullscreen?.(f)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setCtxMenu({ x: e.clientX, y: e.clientY, file: f })
                }}
                style={{
                  cursor: 'pointer',
                  borderBottom: isReorderDragging ? 'none' : undefined,
                  background: 'transparent',
                }}
              >
                <button
                  type="button"
                  className="btn ghost icon sm"
                  aria-label={`move ${f.name}`}
                  onPointerDown={(e) => handleReorderPointerDown(e, f)}
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{ width: 24, height: 30, flexShrink: 0, cursor: 'grab' }}
                >
                  <GripVertical size={13} />
                </button>
                <div style={{ width: 13, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div className="mono" style={{ fontSize: 11, color: 'rgb(var(--text-primary))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 8, rowGap: 2, fontSize: 10.5, minWidth: 0 }}>
                    <span className="mono tabular-nums" style={{ color: 'rgb(var(--text-secondary))', whiteSpace: 'nowrap' }}>{formatDuration(f.duration_sec)}</span>
                    <span className="mono tabular-nums" style={{ color: 'rgb(var(--text-muted))', whiteSpace: 'nowrap' }}>{formatBytes(f.size_bytes)}</span>
                  </div>
                </div>
                <div style={{ width: 24, height: 24, flexShrink: 0 }} />
              </div>
              </Tooltip>
              </div>
            )
          })}
          </>
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

      {reorderDraggingFile && reorderDragBox && createPortal(
        <div
          style={{
            position: 'fixed',
            left: reorderDragBox.left,
            top: reorderDragBox.top + reorderDragDeltaY,
            width: reorderDragBox.width,
            zIndex: 10001,
            pointerEvents: 'none',
            margin: 0,
            padding: '3px 3px 5px',
            borderRadius: 6,
            border: '1px solid rgb(var(--border-strong))',
            borderLeft: '5px solid var(--chip-blue-color)',
            background: 'rgb(var(--bg-surface))',
            transform: 'scale(1.012)',
            transformOrigin: 'center center',
            boxShadow: '0 18px 34px rgba(15,23,42,0.30), 0 0 0 1px rgb(var(--accent-500) / 0.55)',
          }}
        >
          <div className="file-row" style={{ cursor: 'grabbing', borderBottom: 'none' }}>
            <button
              type="button"
              className="btn ghost icon sm"
              aria-label={`moving ${reorderDraggingFile.name}`}
              style={{ width: 24, height: 30, flexShrink: 0, cursor: 'grabbing' }}
            >
              <GripVertical size={13} />
            </button>
            <div style={{ width: 13, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div className="mono" style={{ fontSize: 11, color: 'rgb(var(--text-primary))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {reorderDraggingFile.name}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 8, rowGap: 2, fontSize: 10.5, minWidth: 0 }}>
                <span className="mono tabular-nums" style={{ color: 'rgb(var(--text-secondary))', whiteSpace: 'nowrap' }}>{formatDuration(reorderDraggingFile.duration_sec)}</span>
                <span className="mono tabular-nums" style={{ color: 'rgb(var(--text-muted))', whiteSpace: 'nowrap' }}>{formatBytes(reorderDraggingFile.size_bytes)}</span>
              </div>
            </div>
            <button
              type="button"
              className="btn ghost icon sm"
              aria-label={`moving ${reorderDraggingFile.name}`}
              style={{ width: 24, height: 24, flexShrink: 0 }}
            >
              {collapsedWindowFiles.has(reorderDraggingFile.name) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          </div>
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
              const selectedNames = new Set(
                visibleFiles
                  .filter((file) => selectedFileKeys.has(fileSelectionKey(file)))
                  .map((file) => file.name),
              )
              const namesToRemove = selectedFileKeys.has(fileSelectionKey(f))
                ? selectedNames
                : new Set([f.name])
              const remainingCount = files.filter((item) => !namesToRemove.has(item.name)).length
              if (remainingCount === 0) {
                setDeletedState({ folder, files: new Set() })
                setSelectedFileKeysRaw(new Set())
                lastSelectedKeyRef.current = null
                lastSelectedIdxRef.current = null
                onJobMetaChange({ ...jobMeta, intro_file: '' })
                return
              }
              // Hide the row entirely. Pipeline input is no longer driven
              // by raw-list checkboxes/body_files; manual cache owns it.
              setDeletedState((prev) => {
                const next = new Set(prev.folder === folder ? prev.files : [])
                for (const name of namesToRemove) next.add(name)
                return { folder, files: next }
              })
              const nextIntro = namesToRemove.has(jobMeta.intro_file) ? '' : jobMeta.intro_file
              setSelectedFileKeysRaw(new Set())
              lastSelectedKeyRef.current = null
              lastSelectedIdxRef.current = null
              onJobMetaChange({ ...jobMeta, intro_file: nextIntro })
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
              onPreviewFile?.(f)
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
            <Eye size={14} /> Preview
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
