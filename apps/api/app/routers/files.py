import uuid
from pathlib import PurePath
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Body, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.deps import CurrentUser, SessionDep, load_workbook, require_workspace_role
from app.models import Role, Workbook
from app.services.xlsx import (
    ConversionError,
    csv_to_snapshot,
    snapshot_to_csv,
    snapshot_to_xlsx,
    xlsx_to_snapshot,
)

router = APIRouter(prefix="/workbooks", tags=["files"])

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _content_disposition(filename: str) -> str:
    ascii_name = filename.encode("ascii", "ignore").decode() or "export"
    ascii_name = ascii_name.replace('"', "").replace("\\", "")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


async def _read_limited(file: UploadFile) -> bytes:
    limit = get_settings().max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "File is too large")
    return data


@router.post("/import", status_code=status.HTTP_201_CREATED)
async def import_workbook(
    user: CurrentUser,
    session: SessionDep,
    workspace_id: uuid.UUID = Form(),
    file: UploadFile = File(),
) -> dict[str, Any]:
    await require_workspace_role(session, workspace_id, user, Role.editor)
    data = await _read_limited(file)
    name = PurePath(file.filename or "Импорт").name
    stem, _, ext = name.rpartition(".")
    title = (stem or name)[:200] or "Импорт"
    ext = ext.lower()
    try:
        if ext in ("xlsx", "xlsm"):
            snapshot = await run_in_threadpool(xlsx_to_snapshot, data, title)
        elif ext in ("csv", "tsv", "txt"):
            snapshot = await run_in_threadpool(csv_to_snapshot, data, title)
        else:
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Use .xlsx or .csv")
    except ConversionError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    workbook = Workbook(
        workspace_id=workspace_id,
        title=title,
        created_by=user.id,
        snapshot=snapshot,
        head_rev=0,
        snapshot_rev=0,
    )
    session.add(workbook)
    await session.commit()
    return {"id": str(workbook.id), "title": workbook.title}


@router.post("/{workbook_id}/export")
async def export_workbook(
    workbook_id: uuid.UUID,
    user: CurrentUser,
    session: SessionDep,
    format: Literal["xlsx", "csv"] = Query(default="xlsx"),
    sheet_id: str | None = Query(default=None, max_length=64),
    snapshot: dict[str, Any] | None = Body(default=None, embed=True),
) -> Response:
    """Export the client's current snapshot, or the last stored one when none is sent."""
    workbook, _ = await load_workbook(session, workbook_id, user, Role.viewer)
    source = snapshot or workbook.snapshot
    try:
        if format == "xlsx":
            content = await run_in_threadpool(snapshot_to_xlsx, source)
            media_type = XLSX_MIME
        else:
            content = await run_in_threadpool(snapshot_to_csv, source, sheet_id)
            media_type = "text/csv; charset=utf-8"
    except (ConversionError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Snapshot cannot be exported"
        ) from exc
    return Response(
        content,
        media_type=media_type,
        headers={
            "Content-Disposition": _content_disposition(f"{workbook.title}.{format}"),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    )
