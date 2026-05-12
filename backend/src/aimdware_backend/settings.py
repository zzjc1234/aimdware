"""Process-wide settings, populated from env vars."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AIMDWARE_", case_sensitive=False)

    database_url: str = "sqlite:///./aimdware.db"

    # Shared secret for /admin/* endpoints. If empty, admin endpoints
    # respond 503 (disabled). Set via $AIMDWARE_ADMIN_SECRET.
    admin_secret: str = ""

    # WebDAV (Tbox) the backend should fetch student payloads from.
    # In a production deploy this points at a Tbox instance bound to the
    # TT-side jaccount that has been granted read permission on student
    # folders.
    tbox_url: str = "http://127.0.0.1:8089"


settings = Settings()
