"""Flappy Bend — asset routes.

The Slopsmith plugin loader only serves the manifest-declared files
(screen.html, screen.js, settings.html, tour.json) — anything else has
to come through a plugin-owned route. This module exposes:

    GET /api/plugins/flappy_bend/assets/{path:path}

Path is constrained to an allowlist of safe sub-trees and the root
thumbnail, so Python source files and plugin.json are never reachable.
Mime types are set explicitly from the extension.
"""

from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse


# Extensions the game actually needs, with explicit content-type.
_MIME_MAP = {
    ".png":   "image/png",
    ".json":  "application/json",
    ".ogg":   "audio/ogg",
    ".mp3":   "audio/mpeg",
    ".wav":   "audio/wav",
    ".mid":   "audio/midi",
    ".midi":  "audio/midi",
    ".woff":  "font/woff",
    ".woff2": "font/woff2",
    ".ttf":   "font/ttf",
    ".otf":   "font/otf",
}

# Allowed top-level names / prefixes (after the plugin root).
# Only these sub-trees and the root thumbnail are reachable.
_ALLOWED_ROOTS = {"sprites", "fonts", "tracks"}
_ALLOWED_ROOT_FILES = {"thumb.png"}


def _is_allowed(parts: tuple) -> bool:
    """Return True iff the normalised path is within the allowlist."""
    if len(parts) == 1:
        # Root-level file: only thumb.png is permitted.
        return parts[0] in _ALLOWED_ROOT_FILES
    return parts[0] in _ALLOWED_ROOTS


def setup(app, context):
    plugin_dir = Path(__file__).resolve().parent

    @app.get("/api/plugins/flappy_bend/assets/{path:path}")
    def asset(path: str):
        # Reject traversal attempts before touching the FS.
        if not path or path.startswith("/") or ".." in path.split("/") or "\\" in path:
            raise HTTPException(status_code=400, detail="invalid path")

        parts = tuple(p for p in path.split("/") if p)
        if not parts:
            raise HTTPException(status_code=400, detail="invalid path")

        # Allowlist check — prevents serving routes.py, plugin.json, etc.
        if not _is_allowed(parts):
            raise HTTPException(status_code=404, detail="not found")

        target = (plugin_dir / path).resolve()
        try:
            target.relative_to(plugin_dir)
        except ValueError:
            raise HTTPException(status_code=400, detail="path escapes plugin dir")
        if not target.is_file():
            raise HTTPException(status_code=404, detail="not found")

        ext = target.suffix.lower()
        mime = _MIME_MAP.get(ext)
        if mime is None:
            raise HTTPException(status_code=404, detail="not found")

        # FileResponse sets Content-Length and cache headers correctly.
        return FileResponse(str(target), media_type=mime)
