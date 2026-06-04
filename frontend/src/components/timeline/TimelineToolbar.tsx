import { Award, FilePlus, Plus, Redo2, Scissors, Trash2, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import Tooltip from '../ui/Tooltip'
import type { TimelineMode } from './Timeline'

interface Props {
  canUndo: boolean
  canRedo: boolean
  canDelete: boolean
  canSetIntro?: boolean
  introSelected?: boolean
  mode: TimelineMode
  zoom: number
  addingFiles?: boolean
  onUndo: () => void
  onRedo: () => void
  onDeleteSelected: () => void
  onSetSelectedAsIntro?: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onSetMode: (mode: TimelineMode) => void
  onToggleAddFiles?: () => void
}

// v5 timeline toolbar — Split/Window are mode toggles, Delete is destructive,
// zoom buttons flank a numeric zoom indicator.
export default function TimelineToolbar({
  canUndo, canRedo, canDelete, canSetIntro = false, introSelected = false, mode, zoom, addingFiles,
  onUndo, onRedo, onDeleteSelected,
  onSetSelectedAsIntro,
  onZoomIn, onZoomOut, onZoomReset, onSetMode, onToggleAddFiles,
}: Props) {
  return (
    <div className="flex items-center gap-1.5 flex-1">
      {onToggleAddFiles && (
        <>
          <Tooltip content={addingFiles ? 'Click again to finish adding files (Shift+A)' : 'Add files to lane (Shift+A) — click, then tick files in INPUT'}>
            <button
              type="button"
              className={`btn icon sm ${addingFiles ? 'primary' : ''}`}
              onClick={onToggleAddFiles}
              aria-label="add files to lane"
              aria-pressed={!!addingFiles}
            >
              <FilePlus size={13} />
            </button>
          </Tooltip>
          <div style={{ width: 1, height: 18, background: 'var(--glass-border)', margin: '0 2px' }} />
        </>
      )}
      <Tooltip content="Undo (Ctrl+Z)">
        <button type="button" className="btn icon sm" onClick={onUndo} disabled={!canUndo} aria-label="undo">
          <Undo2 size={13} />
        </button>
      </Tooltip>
      <Tooltip content="Redo (Ctrl+Shift+Z)">
        <button type="button" className="btn icon sm" onClick={onRedo} disabled={!canRedo} aria-label="redo">
          <Redo2 size={13} />
        </button>
      </Tooltip>
      <div style={{ width: 1, height: 18, background: 'var(--glass-border)', margin: '0 2px' }} />
      <Tooltip content="Split mode (Shift+S) — click a window to split">
        <button
          type="button"
          className={`btn sm ${mode === 'split' ? 'active' : ''}`}
          onClick={() => onSetMode(mode === 'split' ? 'pointer' : 'split')}
        >
          <Scissors size={13} /> Split
        </button>
      </Tooltip>
      <Tooltip content="New window (Shift+W) — drag on grey area">
        <button
          type="button"
          className={`btn sm ${mode === 'create' ? 'active' : ''}`}
          onClick={() => onSetMode(mode === 'create' ? 'pointer' : 'create')}
        >
          <Plus size={13} /> Window
        </button>
      </Tooltip>
      <Tooltip content={introSelected ? 'Unset intro on selected window' : 'Set selected window as intro'}>
        <button
          type="button"
          className="btn sm"
          onClick={onSetSelectedAsIntro}
          disabled={!canSetIntro || !onSetSelectedAsIntro}
        >
          <Award size={13} /> {introSelected ? 'Unset Intro' : 'Set Intro'}
        </button>
      </Tooltip>
      <Tooltip content="Delete selected (Del)">
        <button
          type="button"
          className="btn sm danger icon"
          onClick={onDeleteSelected}
          disabled={!canDelete}
          aria-label="delete"
          style={{ width: 28 }}
        >
          <Trash2 size={13} />
        </button>
      </Tooltip>
      <div style={{ width: 1, height: 18, background: 'var(--glass-border)', margin: '0 2px' }} />
      <Tooltip content="Zoom out">
        <button type="button" className="btn icon sm" onClick={onZoomOut} aria-label="zoom out">
          <ZoomOut size={13} />
        </button>
      </Tooltip>
      <Tooltip content="Reset zoom (click)">
        <button
          type="button"
          className="btn sm"
          onClick={onZoomReset}
          style={{
            minWidth: 46,
            font: "500 11px/1 'JetBrains Mono', Consolas, monospace",
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {zoom.toFixed(1)}×
        </button>
      </Tooltip>
      <Tooltip content="Zoom in">
        <button type="button" className="btn icon sm" onClick={onZoomIn} aria-label="zoom in">
          <ZoomIn size={13} />
        </button>
      </Tooltip>
    </div>
  )
}
