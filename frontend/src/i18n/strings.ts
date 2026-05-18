export type Lang = 'en'

export const LANG_OPTIONS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'EN' },
]

const EN_STRINGS: Record<string, string> = {
  app_title: 'Dive Resources Report Video Editor',
  app_subtitle: '',

  section_import: 'Job Import',
  section_params: 'Text & Parameters',
  section_run: 'Run',
  section_timeline: 'Timeline',
  section_suggestions: 'Suggestions',
  section_export: 'Export',
  section_preview: 'Preview',

  pick_folder: 'Pick Job Folder',
  no_folder: 'No folder selected',
  files_in_folder: 'Videos in folder',
  intro_file: 'Intro',
  body_files: 'Body',
  duration: 'Duration',

  cover_text: 'Cover text',
  small_text: 'Watermark',
  target_duration: 'Target duration (min)',
  target_placeholder: '0 = auto',
  target_tip: 'Leave 0 to let the script decide; any number stretches content toward that length',
  font_adjust: 'Font tuning',
  font_hint: 'Drag the text box edges/corners in Preview to adjust spacing or scale proportionally',

  btn_run: 'Start',
  btn_run_running: 'Running...',
  btn_export: 'Export',
  btn_render_only: 'Re-render only',
  btn_open_output: 'Open output folder',

  stage_whisper: 'Speech transcription',
  stage_intro: 'Intro detection',
  stage_ocr: 'Timestamp check',
  stage_edl: 'Build edit list',
  stage_render: 'Render video',
  show_logs: 'Logs',
  hide_logs: 'Hide',
  overall_progress: 'Overall progress',

  timeline_empty: 'Timeline is empty. Segments appear here after running.',
  timeline_total: 'Total',
  timeline_segment_count: 'Segments',
  timeline_selected: 'Selected',
  delete: 'Delete',
  split: 'Split',
  preview: 'Preview',
  preview_hint: 'Click a timeline segment to see its first frame',

  suggest_empty: 'No suggestions',
  suggest_hint: 'Top candidates appear here after the run; hover for details',

  required: 'required',
  required_folder_cover: 'Pick a Job folder and fill the cover text first',
}

export const STRINGS: Record<Lang, Record<string, string>> = {
  en: EN_STRINGS,
}
