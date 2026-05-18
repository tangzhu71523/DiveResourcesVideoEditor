# DiveEdit

DiveEdit is a Windows desktop app for preparing report videos from diver communication footage.

It helps import raw job videos, detect spoken inspection sections, build a reviewable timeline, and export a clean final cut with title text, overlays, and logo placement.

Download the latest installer from the [Releases](https://github.com/tangzhu71523/DiveResourcesVideoEditor/releases) page:

```text
DiveEdit-Setup-0.1.0.exe
```

The installer ships the app runtime. Python, Node.js, and development tools are not required for normal use.

## Notes

- GPU acceleration is used when CUDA support is available.
- CPU mode is used automatically when GPU mode is unavailable.
- Working files are stored under the selected job folder:

```text
<job folder>/_diveedit/
```

The cache can be deleted after the exported video has been checked and no further edits are needed.
