"""FastAPI app factory."""
from __future__ import annotations

from fastapi import FastAPI

from aimdware_backend.routes import ingest


def create_app() -> FastAPI:
    app = FastAPI(title="aimdware-backend")
    app.include_router(ingest.router)
    return app


app = create_app()
