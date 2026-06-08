"""Settings load from a .env file, with real env vars taking precedence."""

from __future__ import annotations

import pytest

_VARS = ("AIMDWARE_ADMIN_SECRET", "AIMDWARE_DATABASE_URL", "AIMDWARE_TBOX_USER")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in _VARS:
        monkeypatch.delenv(var, raising=False)


def test_settings_load_from_dotenv(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("AIMDWARE_ADMIN_SECRET=from-dotenv\nAIMDWARE_TBOX_USER=alice\n")
    monkeypatch.chdir(tmp_path)

    from aimdware_backend.settings import Settings

    s = Settings()
    assert s.admin_secret == "from-dotenv"
    assert s.tbox_user == "alice"


def test_real_env_var_overrides_dotenv(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("AIMDWARE_ADMIN_SECRET=from-dotenv\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("AIMDWARE_ADMIN_SECRET", "from-real-env")

    from aimdware_backend.settings import Settings

    s = Settings()
    assert s.admin_secret == "from-real-env"
