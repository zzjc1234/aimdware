"""Real Tbox integration test for TboxWebDAVReader.

Skipped automatically when no Tbox is reachable. Override via env vars:
    AIMDWARE_TBOX_URL  (default http://127.0.0.1:50471)
    AIMDWARE_TBOX_USER (default admin)
    AIMDWARE_TBOX_PASS (default admin)
"""
from __future__ import annotations

import os
import time
from collections.abc import Iterator

import httpx
import pytest

from aimdware_backend.jbox import JboxNotFound, TboxWebDAVReader

TBOX_URL = os.environ.get("AIMDWARE_TBOX_URL", "http://127.0.0.1:50471")
TBOX_USER = os.environ.get("AIMDWARE_TBOX_USER", "admin")
TBOX_PASS = os.environ.get("AIMDWARE_TBOX_PASS", "admin")


def _reachable() -> bool:
    try:
        httpx.get(TBOX_URL, timeout=1.5)
        return True
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(
    not _reachable(), reason=f"Tbox not reachable at {TBOX_URL}"
)


@pytest.fixture()
def seeded_blob() -> Iterator[tuple[str, bytes]]:
    """Seed Tbox with a known blob via direct WebDAV; tear it down after."""
    subdir = f"aimdware-it-py-{int(time.time() * 1000)}"
    path = f"{subdir}/sample.json"
    payload = f'{{"hello":"backend","ts":{int(time.time() * 1000)}}}'.encode()
    auth = (TBOX_USER, TBOX_PASS)

    # MKCOL parent + PUT
    httpx.request("MKCOL", f"{TBOX_URL}/{subdir}/", auth=auth).raise_for_status()
    httpx.put(f"{TBOX_URL}/{path}", auth=auth, content=payload).raise_for_status()

    yield path, payload

    # Cleanup (best effort).
    try:
        httpx.delete(f"{TBOX_URL}/{subdir}", auth=auth)
    except httpx.HTTPError:
        pass


@pytest.mark.asyncio
async def test_reader_fetches_seeded_blob(seeded_blob: tuple[str, bytes]) -> None:
    path, payload = seeded_blob
    reader = TboxWebDAVReader(TBOX_URL, auth=(TBOX_USER, TBOX_PASS))
    got = await reader.get(path)
    assert got == payload


@pytest.mark.asyncio
async def test_reader_raises_jbox_not_found_on_missing_blob() -> None:
    reader = TboxWebDAVReader(TBOX_URL, auth=(TBOX_USER, TBOX_PASS))
    with pytest.raises(JboxNotFound):
        await reader.get(f"aimdware-it-py-missing-{int(time.time() * 1000)}/nope.json")


@pytest.mark.asyncio
async def test_reader_raises_on_bad_credentials(seeded_blob: tuple[str, bytes]) -> None:
    path = seeded_blob[0]
    reader = TboxWebDAVReader(TBOX_URL, auth=("admin", "definitely-wrong"))
    with pytest.raises(httpx.HTTPStatusError):
        await reader.get(path)
