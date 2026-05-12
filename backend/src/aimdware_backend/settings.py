"""Process-wide settings, populated from env vars."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AIMDWARE_", case_sensitive=False)

    database_url: str = "sqlite:///./aimdware.db"


settings = Settings()
