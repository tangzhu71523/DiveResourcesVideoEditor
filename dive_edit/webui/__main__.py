"""Dev launcher: `python -m dive_edit.webui` starts uvicorn on :8000.

Reload is enabled during development. Frontend (Vite) proxies /api and /ws
to this port — see frontend/vite.config.ts.
"""
from __future__ import annotations

import argparse
import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(prog="dive_edit.webui")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--reload", action="store_true",
                        help="Auto-reload on code changes (dev only)")
    args = parser.parse_args()

    uvicorn.run(
        "dive_edit.webui.server:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
