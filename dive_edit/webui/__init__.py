"""FastAPI wrapper that bridges the React UI to the dive_edit pipeline.

The UI (frontend/) talks to this layer via /api/* and /ws/* endpoints.
Keep this module thin — all heavy lifting stays in dive_edit.* so the CLI
and the web UI share the same code paths.
"""
