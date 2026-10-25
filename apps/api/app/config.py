from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="THULE_", env_file=".env", extra="ignore")

    environment: Literal["dev", "prod"] = "dev"

    database_url: str = "postgresql+asyncpg://thule:thule@127.0.0.1:55432/thule_sheets"
    # Disable pooling when the event loop changes between uses (tests).
    db_pool: bool = True

    secret_key: str = Field(default="dev-secret-change-me-0123456789abcdef", min_length=16)
    # Fernet key (urlsafe base64, 32 bytes) for stored database passwords.
    encryption_key: str = "Q2hhbmdlLW1lLWRldi1rZXktMzItYnl0ZXMtbG9uZyE="

    access_token_ttl_minutes: int = 60 * 24 * 7
    cookie_name: str = "thule_session"
    cookie_secure: bool = False

    max_upload_mb: int = 20

    # External PostgreSQL connections.
    allow_private_db_hosts: bool = False
    db_statement_timeout_ms: int = 15_000
    db_query_row_limit: int = 10_000
    db_page_size_max: int = 1_000

    # Built SPA served by the API (single-container deployment).
    static_dir: Path | None = None


DEV_SECRET_KEY = "dev-secret-change-me-0123456789abcdef"
DEV_ENCRYPTION_KEY = "Q2hhbmdlLW1lLWRldi1rZXktMzItYnl0ZXMtbG9uZyE="


def validate_production(settings: "Settings") -> None:
    if settings.environment != "prod":
        return
    if settings.secret_key == DEV_SECRET_KEY or settings.encryption_key == DEV_ENCRYPTION_KEY:
        raise RuntimeError("SECRET_KEY and ENCRYPTION_KEY must be set in production")
    if not settings.cookie_secure:
        raise RuntimeError("COOKIE_SECURE must be true in production")


@lru_cache
def get_settings() -> Settings:
    return Settings()
