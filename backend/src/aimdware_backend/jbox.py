"""WebDAV-via-Tbox blob reader."""
from __future__ import annotations

from typing import Protocol

import httpx


class JboxReader(Protocol):
    """Fetch a blob's bytes by its blob_uri. Pluggable for tests."""

    async def get(self, blob_uri: str) -> bytes: ...


class JboxNotFound(Exception):
    """Raised when the Tbox WebDAV responds 404 for the blob path."""


class TboxWebDAVReader:
    """Fetch blobs from a Tbox WebDAV endpoint (default: backend-side Tbox)."""

    def __init__(
        self,
        base_url: str,
        timeout_s: float = 10.0,
        auth: tuple[str, str] | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_s
        self._auth = auth

    async def get(self, blob_uri: str) -> bytes:
        # blob_uri stored as a relative path (e.g. "aimdware/ECE4721J/<id>.json").
        # Strip a leading slash so urljoin doesn't drop our base path.
        path = blob_uri.lstrip("/")
        url = f"{self._base_url}/{path}"
        async with httpx.AsyncClient(timeout=self._timeout, auth=self._auth) as client:
            response = await client.get(url)
        if response.status_code == 404:
            raise JboxNotFound(f"blob not found at {url}")
        response.raise_for_status()
        return response.content


def default_reader() -> JboxReader:
    """Build the default reader from settings."""
    from aimdware_backend.settings import settings

    auth = (
        (settings.tbox_user, settings.tbox_pass)
        if settings.tbox_user
        else None
    )
    return TboxWebDAVReader(settings.tbox_url, auth=auth)
