# DiveEdit User Guide

DiveEdit helps prepare report videos from diver communication footage. Import a job folder, let the pipeline find narrated inspection sections, review the timeline, adjust clips if needed, then export the final video.

## Install

1. Open the GitHub Release page.
2. Download `DiveEdit-Setup-0.1.0.exe`.
3. Run the installer.
4. Keep the default install path unless office IT asks for another location.
5. Launch DiveEdit from the desktop shortcut or Start menu.

First launch may take longer because DiveEdit prepares FFmpeg, GPU support when available, and the speech model cache.

## Basic Workflow

1. Click **Import**.
2. Select the job video folder.
3. Fill in the job title fields.
4. Check the file list and confirm the videos that should be used.
5. Click **Start Pipeline**.
6. Review the generated timeline.
7. Play suspicious sections in the preview box.
8. Drag clip edges to adjust start or end points.
9. Remove unwanted clips.
10. Click **Export**.

## Import Area

Use **Import** to choose the folder that contains the job videos. DiveEdit expects the raw `.avi` files from the diver communication system.

In the file list:

- Checked files are allowed into the pipeline.
- Unchecked files are ignored.
- If an intro file is unchecked, DiveEdit will not force it into the pipeline.
- Use select all / deselect all when the folder has many videos.

## Pipeline

The pipeline reads speech, detects the intro, checks video timestamp order, and builds the first timeline.

Status messages tell you:

- whether CUDA or CPU mode is being used
- how many workers are active
- which intro video was selected
- whether OCR timestamp ordering passed
- how many clips were generated

If DiveEdit cannot detect the intro automatically, fix the title fields or manually mark the intro file, then start again.

## Timeline

The timeline is where you review and correct the cut list.

Common actions:

- Click a clip to select it.
- Shift-click to select multiple clips.
- Drag a clip edge to trim it.
- Drag the playhead to preview a time.
- Right-click the timeline to open the context menu.
- Use Remove only after selecting clips.
- Hold Alt and use the mouse wheel or touchpad zoom gesture to zoom the video lane.
- Hold Shift and drag-scroll the timeline when zoomed in.

Small clips may show as compact color blocks instead of frame thumbnails. They still behave like normal clips.

## Preview Box

The preview box shows the selected clip or the clip under the playhead.

Controls:

- Play / pause
- Drag the progress bar to seek
- Hover the volume button to show volume control
- Drag the volume bar to adjust sound
- Change playback speed
- Expand to fullscreen preview

In fullscreen mode, the control panel appears near the bottom when the mouse moves into the panel area or when playback is paused.

## Manual Editing

You can edit the timeline even without running the pipeline.

Useful cases:

- quick manual cut
- fixing a missed speech section
- removing deck chatter
- correcting intro/body boundaries

Manual changes are saved with the job cache under the job folder.

## Export

Click **Export** after the timeline looks correct.

DiveEdit renders:

- the cover/title segment
- overlay text
- logo placement
- selected timeline clips
- final report video

If export fails, check the progress log first. Most failures are caused by missing source video files, file permission problems, or interrupted setup assets.

## Job Cache

DiveEdit writes its working files to:

```text
<job folder>/_diveedit/
```

This cache keeps transcripts, timeline data, thumbnails, preview cache, and logs. It is safe to delete after the final video has been checked and uploaded.

## Troubleshooting

If preview feels slow, wait for the loading indicator to finish before rapid random seeking.

If GPU mode is not available, DiveEdit falls back to CPU mode. CPU mode is slower but should still work.

If the wrong intro is selected, check that the job title fields contain clear job number, vessel name, and work scope keywords.

If a video is missing from export, confirm it is checked in the import file list and still exists in the job folder.
