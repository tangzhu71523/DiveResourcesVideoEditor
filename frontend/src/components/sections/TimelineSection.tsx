import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { FilePlus, Plus, Redo2, Scissors, Trash2, Undo2 } from 'lucide-react'
import type { EDL, Segment, VideoFile } from '@/types/edl'
import Timeline, { type TimelineMode } from '../timeline/Timeline'
import { ZOOM_STEP } from '../timeline/zoom'
import TimelineToolbar from '../timeline/TimelineToolbar'
import { formatDuration } from '@/lib/format'

interface Props {
  edl: EDL | null
  folder?: string | null
  files: VideoFile[]
  selectedIdx: number | null
  selectedIdxs?: number[]
  onSelectIdx: (idx: number | null, additive?: boolean) => void
  onSegmentsChange: (segments: Segment[]) => void
  playheadSec?: number | null
  onSeek?: (segIdx: number, offsetInSeg: number) => void
  zoom: number
  onZoomChange: (zoom: number) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  addingFiles?: boolean
  onToggleAddFiles?: () => void
  onRemoveLaneFile?: (filePath: string) => void
  selectedLaneFile?: string | null
  selectedLaneFiles?: string[]
  onSelectLaneFile?: (file: string | null, additive?: boolean) => void
  isPlaying?: boolean
  playheadLaneFile?: string | null
  introMarker?: { file: string; start: number; end: number } | null
  introSelected?: boolean
  onSelectIntro?: () => void
  onDeleteIntro?: () => void
  onIntroResize?: (edge: 'start' | 'end', newVal: number) => void
  onIntroMove?: (start: number, end: number) => void
}

export default function TimelineSection({
  edl, folder = null, files, selectedIdx, selectedIdxs = [], onSelectIdx, onSegmentsChange,
  playheadSec, onSeek, zoom, onZoomChange,
  canUndo, canRedo, onUndo, onRedo,
  addingFiles, onToggleAddFiles, onRemoveLaneFile,
  selectedLaneFile = null, selectedLaneFiles = [], onSelectLaneFile,
  isPlaying = false, playheadLaneFile = null,
  introMarker = null, introSelected = false,
  onSelectIntro, onDeleteIntro, onIntroResize, onIntroMove,
}: Props) {
  // EDL 现在用统一 segments 列表;body = 非 INTRO 标签那批。
  const segments = (edl?.segments ?? []).filter((s) => s.label !== 'INTRO')
  const [mode, setMode] = useState<TimelineMode>('pointer')
  // Lane-level selection lives in App.tsx so the global keyboard Delete
  // handler can act on it directly. We just receive it as a prop.

  // Toolbar right-side readout = sum of kept window durations (rendered
  // output length, not the raw imported file pile).
  const outputBodyDurationSec = useMemo(
    () => segments.reduce((a, s) => a + (s.end - s.start), 0),
    [segments],
  )

  const selectedSeg = selectedIdx !== null && selectedIdx < segments.length ? segments[selectedIdx] : null
  const selectedIdxSet = useMemo(() => new Set(selectedIdxs), [selectedIdxs])
  const selectedLaneFileSet = useMemo(() => new Set(selectedLaneFiles), [selectedLaneFiles])
  const canDelete = introSelected || selectedLaneFileSet.size > 0 || selectedLaneFile !== null || selectedIdxSet.size > 0 || selectedIdx !== null
  const [menu, setMenu] = useState<{ x: number; y: number; alignRight: boolean } | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-timeline-context-menu="true"]')) return
      setMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const deleteSelected = () => {
    const laneDoomed = selectedLaneFileSet.size > 0
      ? selectedLaneFileSet
      : selectedLaneFile !== null
        ? new Set([selectedLaneFile])
        : new Set<string>()
    if (laneDoomed.size > 0) {
      // Lane delete = drop the lane from the visible set ONLY. We KEEP
      // the file's body_segments in the EDL cache so that re-adding the
      // lane (FilePlus → tick) brings the windows back automatically.
      // Empty re-adds (no cached segments) just show as the grey track.
      for (const file of laneDoomed) onRemoveLaneFile?.(file)
      onSelectLaneFile?.(null)
      onSelectIdx(null)
      return
    }
    if (introSelected) {
      onDeleteIntro?.()
      onSelectIdx(null)
      return
    }
    const segDoomed = selectedIdxSet.size > 0
      ? selectedIdxSet
      : selectedIdx !== null
        ? new Set([selectedIdx])
        : new Set<number>()
    if (segDoomed.size === 0) return
    const next = segments.filter((_: Segment, i: number) => !segDoomed.has(i))
    onSegmentsChange(next)
    onSelectIdx(null)
  }

  const handleAddSegment = (file: string, start: number, end: number) => {
    const newSeg: Segment = {
      file,
      start,
      end,
      label: 'HULL',
      score: 1,
      protected: false,
    }
    const next = [...segments, newSeg]
    // Sort by file appearance order, then by start within file.
    const fileOrder = new Map<string, number>()
    segments.forEach((s, i) => { if (!fileOrder.has(s.file)) fileOrder.set(s.file, i) })
    if (!fileOrder.has(file)) fileOrder.set(file, segments.length)
    next.sort((a, b) => {
      const fa = fileOrder.get(a.file) ?? 0
      const fb = fileOrder.get(b.file) ?? 0
      if (fa !== fb) return fa - fb
      return a.start - b.start
    })
    onSegmentsChange(next)
  }

  const handleSplitSegment = (segIdx: number, srcSec: number) => {
    const seg = segments[segIdx]
    if (!seg) return
    if (srcSec <= seg.start + 0.5 || srcSec >= seg.end - 0.5) return
    const a: Segment = { ...seg, end: srcSec }
    const b: Segment = { ...seg, start: srcSec }
    const next = [...segments]
    next.splice(segIdx, 1, a, b)
    onSegmentsChange(next)
  }

  return (
    <div className="panel h-full">
      {/* Toolbar row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: '1px solid rgb(var(--border-subtle))',
          background: 'rgb(var(--bg-surface))',
          flexShrink: 0,
        }}
      >
        <TimelineToolbar
          canUndo={canUndo}
          canRedo={canRedo}
          canDelete={canDelete}
          mode={mode}
          zoom={zoom}
          addingFiles={addingFiles}
          onUndo={onUndo}
          onRedo={onRedo}
          onDeleteSelected={deleteSelected}
          onZoomIn={() => onZoomChange(Math.min(12, zoom + ZOOM_STEP))}
          onZoomOut={() => onZoomChange(Math.max(1.0, zoom - ZOOM_STEP))}
          onZoomReset={() => onZoomChange(1.0)}
          onSetMode={setMode}
          onToggleAddFiles={onToggleAddFiles}
        />
        <span
          className="tabular-nums"
          style={{
            font: "500 10.5px/1 'JetBrains Mono', Consolas, monospace",
            color: 'rgb(var(--text-muted))',
            marginLeft: 'auto',
          }}
        >
          {formatDuration(outputBodyDurationSec)}
        </span>
      </div>

      {/* Timeline body — dimmed + non-interactive while addingFiles is on
          (toolbar above stays live so the FilePlus toggle is reachable).
          Light mode also drops brightness so the blur reads as muted.
          data-lane-drop-zone marks this region as the hit-test target for
          the file-row pointer drag (JobImportSection.handleRowMouseDown). */}
      <div
        className="flex-1 min-h-0 flex flex-col"
        data-lane-drop-zone="true"
        onContextMenu={(e) => {
          e.preventDefault()
          const menuW = 178
          const menuH = 220
          const margin = 10
          setMenu({
            x: e.clientX,
            y: Math.max(margin, Math.min(window.innerHeight - menuH - margin, e.clientY - menuH / 2)),
            alignRight: e.clientX + menuW + margin > window.innerWidth,
          })
        }}
        style={{
        background: 'rgb(var(--bg-raised))',
        ...(addingFiles ? (() => {
          const isLight = typeof document !== 'undefined'
            && document.documentElement.getAttribute('data-theme') !== 'dark'
          return {
            filter: isLight ? 'blur(4px) brightness(0.7)' : 'blur(4px)',
            opacity: isLight ? 0.7 : 0.55,
            pointerEvents: 'none' as const,
            transition: 'filter 120ms ease-out, opacity 120ms ease-out',
          }
        })() : null),
      }}>
        <Timeline
          segments={segments}
          files={files}
          onChange={onSegmentsChange}
          selectedIdx={selectedIdx}
          selectedIdxs={selectedIdxs}
          onSelectIdx={(idx, additive) => {
            if (idx !== null) onSelectLaneFile?.(null)
            onSelectIdx(idx, additive)
          }}
          playheadSec={playheadSec ?? null}
          onSeek={onSeek}
          zoom={zoom}
          onZoomChange={onZoomChange}
          mode={mode}
          onModeChange={setMode}
          onAddSegment={handleAddSegment}
          onSplitSegment={handleSplitSegment}
          selectedLaneFile={selectedLaneFile}
          selectedLaneFiles={selectedLaneFiles}
          onSelectLaneFile={(file, additive) => {
            if (file) onSelectIdx(null)
            onSelectLaneFile?.(file, additive)
          }}
          isPlaying={isPlaying}
          playheadLaneFile={playheadLaneFile}
          introMarker={introMarker}
          introSelected={introSelected}
          onSelectIntro={onSelectIntro}
          onIntroResize={onIntroResize}
          onIntroMove={onIntroMove}
          folder={folder}
        />
        {menu && createPortal((
          <div
            data-timeline-context-menu="true"
            style={{
              position: 'fixed',
              left: menu.alignRight ? undefined : menu.x,
              right: menu.alignRight ? Math.max(0, window.innerWidth - menu.x) : undefined,
              top: menu.y,
              width: 178,
              zIndex: 2147483647,
              padding: 4,
              borderRadius: 7,
              background: 'rgb(var(--bg-surface))',
              border: '1px solid rgb(var(--border-strong))',
              boxShadow: '0 16px 38px rgba(0,0,0,0.26), 0 4px 12px rgba(0,0,0,0.14)',
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
          >
            {[
              { label: addingFiles ? 'Finish adding files' : 'Add files', icon: <FilePlus size={13} />, action: onToggleAddFiles, disabled: !onToggleAddFiles, active: !!addingFiles },
              { label: 'Undo', icon: <Undo2 size={13} />, action: onUndo, disabled: !canUndo },
              { label: 'Redo', icon: <Redo2 size={13} />, action: onRedo, disabled: !canRedo },
              { sep: true },
              { label: mode === 'split' ? 'Exit split' : 'Split', icon: <Scissors size={13} />, action: () => setMode(mode === 'split' ? 'pointer' : 'split'), active: mode === 'split' },
              { label: mode === 'create' ? 'Exit window' : 'Window', icon: <Plus size={13} />, action: () => setMode(mode === 'create' ? 'pointer' : 'create'), active: mode === 'create' },
              { label: 'Remove', icon: <Trash2 size={13} />, action: deleteSelected, disabled: !canDelete, danger: true },
            ].map((item, idx) => {
              if ('sep' in item) {
                return <div key={`sep-${idx}`} style={{ height: 1, margin: '4px 3px', background: 'rgb(var(--border-subtle))' }} />
              }
              const disabled = !!item.disabled
              return (
                <button
                  key={item.label}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return
                    item.action?.()
                    setMenu(null)
                  }}
                  style={{
                    width: '100%',
                    height: 28,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '0 8px',
                    border: 'none',
                    borderRadius: 5,
                    background: item.active
                      ? 'rgb(var(--accent-500) / 0.14)'
                      : disabled
                        ? 'rgb(var(--bg-raised))'
                        : 'transparent',
                    color: disabled
                      ? 'rgb(var(--text-muted) / 0.52)'
                      : item.danger
                        ? 'rgb(var(--danger))'
                        : 'rgb(var(--text-primary))',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    fontWeight: 500,
                    textAlign: 'left',
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        ), document.body)}
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '6px 12px',
          borderTop: '1px solid var(--glass-border)',
          font: "500 10.5px/1 'JetBrains Mono', Consolas, monospace",
          color: 'rgb(var(--text-muted))',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {selectedSeg ? (
          <>
            <span style={{ fontWeight: 600, color: 'rgb(var(--text-secondary))' }}>
              #{(selectedIdx ?? 0) + 1}
            </span>
            <span>{selectedSeg.file.split(/[/\\]/).pop()}</span>
            <span>{formatDuration(selectedSeg.start)}→{formatDuration(selectedSeg.end)}</span>
          </>
        ) : segments.length > 0 ? (
          <span>{segments.length} segments · click a window to select</span>
        ) : (
          <span>No segments yet</span>
        )}
        <div style={{ flex: 1 }} />
        {mode !== 'pointer' ? (
          <span style={{ color: mode === 'split' ? 'rgb(var(--danger))' : '#16a34a', fontWeight: 600, marginLeft: 'auto' }}>
            {mode === 'split'
              ? '✂ Click a window to split · Esc to cancel'
              : '⊕ Drag on grey area · Esc to cancel'}
          </span>
        ) : (
          <span style={{ color: 'rgb(var(--text-muted))', marginLeft: 'auto' }}>
            <kbd>Shift</kbd>+drag edge resize · drag playhead seek · <kbd>Alt</kbd>+wheel zoom · middle-drag pan · <kbd>Shift+A</kbd> add · <kbd>Shift+S</kbd> split · <kbd>Shift+W</kbd> window · <kbd>Del</kbd> delete
          </span>
        )}
        {/* Logs popup button removed — pipeline panel now has an inline
            pseudo-terminal that streams the same log feed continuously. */}
      </div>
    </div>
  )
}

