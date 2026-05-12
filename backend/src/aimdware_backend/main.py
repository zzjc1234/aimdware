"""FastAPI app factory."""
from __future__ import annotations

from fastapi import FastAPI

from aimdware_backend.routes import admin, ingest


def create_app() -> FastAPI:
    app = FastAPI(title="aimdware-backend")
    app.include_router(ingest.router)
    app.include_router(admin.router)
    return app


app = create_app()
