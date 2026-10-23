"""Conversion between XLSX / CSV files and Univer IWorkbookData snapshots.

Supported subset: values, formulas (including Univer shared formulas), number
formats, fonts, fills, borders, alignment, wrapping, merged cells, column widths,
row heights, hidden rows/columns, frozen panes and list data validation.
"""

import csv
import io
import json
import re
import secrets
import zipfile
from datetime import date, datetime, time
from typing import Any

from openpyxl import Workbook as XlWorkbook
from openpyxl import load_workbook
from openpyxl.cell.cell import Cell
from openpyxl.formula.translate import Translator
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.utils.cell import range_boundaries
from openpyxl.utils.datetime import to_excel
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.formula import ArrayFormula
from openpyxl.worksheet.worksheet import Worksheet

from app.services.templates import APP_VERSION, LOCALE

MAX_CELLS = 500_000
MAX_SHEETS = 64
# Archive guards run before openpyxl builds cell objects: a small zip can inflate
# to gigabytes of worksheet XML (zip bomb) or declare millions of empty cells.
MAX_ARCHIVE_ENTRIES = 4_096
MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_BYTES = 192 * 1024 * 1024
# Excel cell values are limited to 32 767 characters; CSV has no such limit, so
# cap it to keep a single field from exhausting memory.
MAX_CSV_FIELD_CHARS = 1024 * 1024

STRING, NUMBER, BOOLEAN, FORCE_STRING = 1, 2, 3, 4

H_ALIGN = {"left": 1, "center": 2, "right": 3, "justify": 4, "distributed": 6}
H_ALIGN_BACK = {v: k for k, v in H_ALIGN.items()}
V_ALIGN = {"top": 1, "center": 2, "bottom": 3}
V_ALIGN_BACK = {v: k for k, v in V_ALIGN.items()}
WRAP = 3

BORDER_STYLES = {
    "thin": 1,
    "hair": 2,
    "dotted": 3,
    "dashed": 4,
    "dashDot": 5,
    "dashDotDot": 6,
    "double": 7,
    "medium": 8,
    "mediumDashed": 9,
    "mediumDashDot": 10,
    "mediumDashDotDot": 11,
    "slantDashDot": 12,
    "thick": 13,
}
BORDER_STYLES_BACK = {v: k for k, v in BORDER_STYLES.items()}
BORDER_SIDES = {"t": "top", "b": "bottom", "l": "left", "r": "right"}

DEFAULT_FONT = "Calibri"
DEFAULT_FONT_SIZE = 11
DV_RESOURCE = "SHEET_DATA_VALIDATION_PLUGIN"
INVALID_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")


class ConversionError(ValueError):
    pass


def _uid() -> str:
    return secrets.token_urlsafe(8).replace("-", "x").replace("_", "y")


# ------------------------------------------------------------------ colors


def _argb_to_hex(color: Any) -> str | None:
    if color is None or getattr(color, "type", None) != "rgb":
        return None
    value = color.rgb
    if not isinstance(value, str) or len(value) not in (6, 8):
        return None
    return f"#{value[-6:].upper()}"


def _hex_to_argb(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", value.strip())
    if m:
        return f"FF{m.group(1).upper()}"
    m = re.fullmatch(r"rgba?\((\d+),\s*(\d+),\s*(\d+)", value.strip())
    if m:
        return "FF" + "".join(f"{min(int(c), 255):02X}" for c in m.groups())
    return None


# ------------------------------------------------------------------ import


def _style_from_cell(cell: Cell) -> dict[str, Any]:
    style: dict[str, Any] = {}
    font = cell.font
    if font.b:
        style["bl"] = 1
    if font.i:
        style["it"] = 1
    if font.u:
        style["ul"] = {"s": 1}
    if font.strike:
        style["st"] = {"s": 1}
    if font.sz and float(font.sz) != DEFAULT_FONT_SIZE:
        style["fs"] = float(font.sz)
    if font.name and font.name != DEFAULT_FONT:
        style["ff"] = font.name
    if (color := _argb_to_hex(font.color)) and color != "#000000":
        style["cl"] = {"rgb": color}

    fill = cell.fill
    if (
        # Cell styles are StyleProxy objects, so check attributes instead of the type.
        getattr(fill, "fill_type", None) == "solid" and (color := _argb_to_hex(fill.fgColor))
    ):
        style["bg"] = {"rgb": color}

    align = cell.alignment
    if align.horizontal in H_ALIGN:
        style["ht"] = H_ALIGN[align.horizontal]
    if align.vertical in V_ALIGN:
        style["vt"] = V_ALIGN[align.vertical]
    if align.wrap_text:
        style["tb"] = WRAP

    if cell.number_format and cell.number_format != "General":
        style["n"] = {"pattern": cell.number_format}

    borders: dict[str, Any] = {}
    for key, side_name in BORDER_SIDES.items():
        side = getattr(cell.border, side_name)
        if side is not None and side.style in BORDER_STYLES:
            borders[key] = {
                "s": BORDER_STYLES[side.style],
                "cl": {"rgb": _argb_to_hex(side.color) or "#000000"},
            }
    if borders:
        style["bd"] = borders
    return style


def _import_value(cell: Cell) -> dict[str, Any] | None:
    value = cell.value
    if isinstance(value, ArrayFormula):
        value = value.text
    if cell.data_type == "f" and isinstance(value, str) and value.startswith("="):
        # Cached values are not imported on purpose: reading them requires a second
        # full workbook parse (memory and CPU), and Univer recalculates formulas on
        # load. The formula string itself is preserved.
        return {"f": value}
    if value is None:
        return None
    return _plain_value(value)


def _plain_value(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"v": 1 if value else 0, "t": BOOLEAN}
    if isinstance(value, int | float):
        return {"v": value, "t": NUMBER}
    if isinstance(value, datetime | date | time):
        return {"v": to_excel(value), "t": NUMBER}
    return {"v": str(value), "t": STRING}


class _StyleRegistry:
    def __init__(self) -> None:
        self.styles: dict[str, Any] = {}
        self._ids: dict[str, str] = {}

    def add(self, style: dict[str, Any]) -> str:
        key = json.dumps(style, sort_keys=True)
        if key not in self._ids:
            style_id = f"s{len(self._ids) + 1}"
            self._ids[key] = style_id
            self.styles[style_id] = style
        return self._ids[key]


def _import_sheet(
    ws: Worksheet, registry: _StyleRegistry, budget: list[int]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    sheet_id = _uid()
    cell_data: dict[str, dict[str, Any]] = {}
    for row in ws.iter_rows():
        for cell in row:
            if not isinstance(cell, Cell):
                continue
            # Count every iterated cell, including empty ones: a sheet full of
            # styled empty cells must hit the budget before it exhausts memory.
            budget[0] -= 1
            if budget[0] < 0:
                raise ConversionError(f"Too many cells, the limit is {MAX_CELLS}")
            entry = _import_value(cell) or {}
            if cell.has_style and (style := _style_from_cell(cell)):
                entry["s"] = registry.add(style)
            if not entry:
                continue
            cell_data.setdefault(str(cell.row - 1), {})[str(cell.column - 1)] = entry

    column_data: dict[str, Any] = {}
    for letter, dim in ws.column_dimensions.items():
        min_col, _, max_col, _ = range_boundaries(f"{letter}1:{letter}1")
        first = dim.min or min_col
        last = dim.max or max_col
        for col in range(first, min(last, 16384) + 1):
            item: dict[str, Any] = {}
            if dim.width:
                item["w"] = round(dim.width * 7 + 5)
            if dim.hidden:
                item["hd"] = 1
            if item:
                column_data[str(col - 1)] = item
    row_data: dict[str, Any] = {}
    for index, dim in ws.row_dimensions.items():
        item = {}
        if dim.height:
            item["h"] = round(dim.height * 4 / 3)
        if dim.hidden:
            item["hd"] = 1
        if item:
            row_data[str(index - 1)] = item

    merges = []
    for rng in ws.merged_cells.ranges:
        merges.append(
            {
                "startRow": rng.min_row - 1,
                "endRow": rng.max_row - 1,
                "startColumn": rng.min_col - 1,
                "endColumn": rng.max_col - 1,
            }
        )

    freeze = {"xSplit": 0, "ySplit": 0, "startRow": -1, "startColumn": -1}
    if ws.freeze_panes:
        col, row_idx, _, _ = range_boundaries(f"{ws.freeze_panes}:{ws.freeze_panes}")
        freeze = {
            "xSplit": col - 1,
            "ySplit": row_idx - 1,
            "startRow": row_idx - 1 if row_idx > 1 else -1,
            "startColumn": col - 1 if col > 1 else -1,
        }

    rules = []
    for dv in ws.data_validations.dataValidation:
        if dv.type != "list" or not dv.formula1:
            continue
        formula = dv.formula1
        if formula.startswith('"') and formula.endswith('"'):
            formula = formula[1:-1]
        else:
            formula = f"={formula}"
        ranges = []
        for part in str(dv.sqref).split():
            c1, r1, c2, r2 = range_boundaries(part)
            ranges.append(
                {"startRow": r1 - 1, "endRow": r2 - 1, "startColumn": c1 - 1, "endColumn": c2 - 1}
            )
        rules.append(
            {
                "uid": _uid(),
                "type": "list",
                "formula1": formula,
                "ranges": ranges,
                "allowBlank": bool(dv.allow_blank),
                "renderMode": 1,
            }
        )

    sheet = {
        "id": sheet_id,
        "name": ws.title,
        "tabColor": _argb_to_hex(ws.sheet_properties.tabColor) or "",
        "hidden": 1 if ws.sheet_state != "visible" else 0,
        "freeze": freeze,
        "rowCount": max(ws.max_row + 50, 200),
        "columnCount": max(ws.max_column + 5, 26),
        "zoomRatio": 1,
        "scrollTop": 0,
        "scrollLeft": 0,
        "defaultColumnWidth": 96,
        "defaultRowHeight": 24,
        "mergeData": merges,
        "cellData": cell_data,
        "rowData": row_data,
        "columnData": column_data,
        "rowHeader": {"width": 46},
        "columnHeader": {"height": 24},
        "showGridlines": 1 if ws.sheet_view.showGridLines is not False else 0,
        "rightToLeft": 0,
    }
    return sheet, rules


def _workbook_snapshot(
    title: str, sheets: list[dict[str, Any]], styles: dict[str, Any], rules: dict[str, Any]
) -> dict[str, Any]:
    resources = []
    if rules:
        resources.append({"name": DV_RESOURCE, "data": json.dumps(rules, ensure_ascii=False)})
    return {
        "id": _uid(),
        "name": title,
        "appVersion": APP_VERSION,
        "locale": LOCALE,
        "styles": styles,
        "sheetOrder": [s["id"] for s in sheets],
        "sheets": {s["id"]: s for s in sheets},
        "resources": resources,
    }


def _check_archive(data: bytes) -> None:
    """Reject zip bombs and oversized workbooks before openpyxl allocates cells."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
    except zipfile.BadZipFile as exc:
        raise ConversionError("File is not a valid XLSX workbook") from exc
    if len(entries) > MAX_ARCHIVE_ENTRIES:
        raise ConversionError("Workbook contains too many parts")
    if "xl/workbook.xml" not in {entry.filename for entry in entries}:
        raise ConversionError("File is not a valid XLSX workbook")
    total = 0
    for entry in entries:
        if entry.file_size > MAX_ARCHIVE_ENTRY_BYTES:
            raise ConversionError("Workbook part is too large")
        total += entry.file_size
        if total > MAX_ARCHIVE_BYTES:
            raise ConversionError("Workbook is too large when unpacked")


def _check_dimensions(data: bytes) -> None:
    """Read worksheet dimensions in lazy mode; this does not build cell objects."""
    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:  # openpyxl raises a variety of exceptions for bad files
        raise ConversionError("File is not a valid XLSX workbook") from exc
    try:
        if len(wb.worksheets) > MAX_SHEETS:
            raise ConversionError(f"Too many worksheets, the limit is {MAX_SHEETS}")
        total = 0
        for ws in wb.worksheets:
            # A declared dimension can be inflated by the file; treating it as an
            # upper bound rejects the file instead of trusting the contents.
            total += max(ws.max_row or 0, 0) * max(ws.max_column or 0, 0)
            if total > MAX_CELLS:
                raise ConversionError(f"Too many cells, the limit is {MAX_CELLS}")
    finally:
        wb.close()


def xlsx_to_snapshot(data: bytes, title: str) -> dict[str, Any]:
    _check_archive(data)
    _check_dimensions(data)
    try:
        wb = load_workbook(io.BytesIO(data), data_only=False)
    except Exception as exc:  # openpyxl raises a variety of exceptions for bad files
        raise ConversionError("File is not a valid XLSX workbook") from exc
    registry = _StyleRegistry()
    budget = [MAX_CELLS]
    sheets, rules = [], {}
    for ws in wb.worksheets:
        sheet, sheet_rules = _import_sheet(ws, registry, budget)
        sheets.append(sheet)
        if sheet_rules:
            rules[sheet["id"]] = sheet_rules
    if not sheets:
        raise ConversionError("Workbook has no worksheets")
    has_formulas = any(
        cell.get("f")
        for sheet in sheets
        for row in sheet["cellData"].values()
        for cell in row.values()
    )
    if has_formulas:
        _apply_cached_values(data, sheets)
    return _workbook_snapshot(title, sheets, registry.styles, rules)


def _parse_csv_value(raw: str) -> dict[str, Any] | None:
    text = raw.strip()
    if not text:
        return None
    if text.startswith("="):
        return {"v": raw, "t": FORCE_STRING}  # never execute formulas from CSV
    candidate = text.replace(" ", "").replace(" ", "")
    if re.fullmatch(r"-?\d+,\d+", candidate):
        candidate = candidate.replace(",", ".")
    if re.fullmatch(r"-?\d+(\.\d+)?([eE][-+]?\d+)?", candidate):
        number = float(candidate)
        return {
            "v": int(number) if number.is_integer() and "." not in candidate else number,
            "t": NUMBER,
        }
    return {"v": raw, "t": STRING}


def csv_to_snapshot(data: bytes, title: str) -> dict[str, Any]:
    csv.field_size_limit(MAX_CSV_FIELD_CHARS)
    for encoding in ("utf-8-sig", "cp1251"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ConversionError("Unsupported CSV encoding")
    sample = text[:8192]
    try:
        dialect: Any = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    cell_data: dict[str, dict[str, Any]] = {}
    max_col = 0
    count = 0
    rows = 0
    reader = csv.reader(io.StringIO(text), dialect)
    try:
        for r, row in enumerate(reader):
            rows = r + 1
            for c, raw in enumerate(row):
                if (value := _parse_csv_value(raw)) is None:
                    continue
                count += 1
                if count > MAX_CELLS:
                    raise ConversionError(f"Too many cells, the limit is {MAX_CELLS}")
                cell_data.setdefault(str(r), {})[str(c)] = value
                max_col = max(max_col, c + 1)
    except csv.Error as exc:
        raise ConversionError(f"CSV cannot be parsed: {exc}") from exc
    sheet = {
        "id": _uid(),
        "name": "Лист1",
        "tabColor": "",
        "hidden": 0,
        "freeze": {"xSplit": 0, "ySplit": 0, "startRow": -1, "startColumn": -1},
        "rowCount": max(rows + 50, 200),
        "columnCount": max(max_col + 5, 26),
        "zoomRatio": 1,
        "scrollTop": 0,
        "scrollLeft": 0,
        "defaultColumnWidth": 96,
        "defaultRowHeight": 24,
        "mergeData": [],
        "cellData": cell_data,
        "rowData": {},
        "columnData": {},
        "rowHeader": {"width": 46},
        "columnHeader": {"height": 24},
        "showGridlines": 1,
        "rightToLeft": 0,
    }
    return _workbook_snapshot(title, [sheet], {}, {})


# ------------------------------------------------------------------ export


def _resolve_style(snapshot: dict[str, Any], style: Any) -> dict[str, Any]:
    if isinstance(style, str):
        style = (snapshot.get("styles") or {}).get(style)
    return style if isinstance(style, dict) else {}


def _rich_text(cell: dict[str, Any]) -> str | None:
    body = (cell.get("p") or {}).get("body") or {}
    stream = body.get("dataStream")
    if not isinstance(stream, str):
        return None
    return stream.rstrip("\r\n").replace("\r", "\n")


def _apply_style(target: Cell, style: dict[str, Any]) -> None:
    if not style:
        return
    font_kwargs: dict[str, Any] = {}
    if style.get("bl"):
        font_kwargs["b"] = True
    if style.get("it"):
        font_kwargs["i"] = True
    if (style.get("ul") or {}).get("s"):
        font_kwargs["u"] = "single"
    if (style.get("st") or {}).get("s"):
        font_kwargs["strike"] = True
    if isinstance(style.get("fs"), int | float):
        font_kwargs["sz"] = style["fs"]
    if isinstance(style.get("ff"), str):
        font_kwargs["name"] = style["ff"]
    if color := _hex_to_argb((style.get("cl") or {}).get("rgb")):
        font_kwargs["color"] = color
    if font_kwargs:
        target.font = Font(**font_kwargs)
    if color := _hex_to_argb((style.get("bg") or {}).get("rgb")):
        target.fill = PatternFill(fill_type="solid", fgColor=color)
    horizontal = H_ALIGN_BACK.get(style.get("ht") or 0)
    vertical = V_ALIGN_BACK.get(style.get("vt") or 0)
    wrap = style.get("tb") == WRAP
    if horizontal or vertical or wrap:
        target.alignment = Alignment(horizontal=horizontal, vertical=vertical, wrap_text=wrap)
    pattern = (style.get("n") or {}).get("pattern")
    if isinstance(pattern, str) and pattern:
        target.number_format = pattern
    borders = style.get("bd") or {}
    if isinstance(borders, dict) and borders:
        sides = {}
        for key, side_name in BORDER_SIDES.items():
            side = borders.get(key)
            if isinstance(side, dict) and side.get("s") in BORDER_STYLES_BACK:
                sides[side_name] = Side(
                    style=BORDER_STYLES_BACK[side["s"]],
                    color=_hex_to_argb((side.get("cl") or {}).get("rgb")) or "FF000000",
                )
        if sides:
            target.border = Border(**sides)


def _export_value(cell: dict[str, Any], formula: str | None) -> Any:
    if formula:
        return formula if formula.startswith("=") else f"={formula}"
    if (text := _rich_text(cell)) is not None:
        return text
    value = cell.get("v")
    if value is None:
        return None
    t = cell.get("t")
    if t == BOOLEAN:
        return bool(value) and value not in ("0", "FALSE", "false")
    if t in (STRING, FORCE_STRING):
        return str(value)
    if isinstance(value, int | float | bool):
        return value
    return str(value)


def _sheet_formulas(cell_data: dict[str, Any]) -> dict[tuple[int, int], str]:
    """Resolve formulas, including cells that only reference a shared formula id (`si`)."""
    origins: dict[str, tuple[int, int, str]] = {}
    for r, row in cell_data.items():
        for c, cell in (row or {}).items():
            if isinstance(cell, dict) and cell.get("f") and cell.get("si"):
                origins[cell["si"]] = (int(r), int(c), cell["f"])
    result: dict[tuple[int, int], str] = {}
    for r, row in cell_data.items():
        for c, cell in (row or {}).items():
            if not isinstance(cell, dict):
                continue
            ri, ci = int(r), int(c)
            if cell.get("f"):
                result[(ri, ci)] = cell["f"]
            elif cell.get("si") in origins:
                orow, ocol, formula = origins[cell["si"]]
                origin = f"{get_column_letter(ocol + 1)}{orow + 1}"
                dest = f"{get_column_letter(ci + 1)}{ri + 1}"
                result[(ri, ci)] = Translator(formula, origin=origin).translate_formula(dest)
    return result


def _sheet_title(name: Any, used: set[str]) -> str:
    title = INVALID_SHEET_CHARS.sub("_", str(name or "Лист"))[:31] or "Лист"
    base, n = title, 2
    while title.lower() in used:
        suffix = f" ({n})"
        title = base[: 31 - len(suffix)] + suffix
        n += 1
    used.add(title.lower())
    return title


def _validation_rules(snapshot: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    for resource in snapshot.get("resources") or []:
        if isinstance(resource, dict) and resource.get("name") == DV_RESOURCE:
            try:
                data = json.loads(resource.get("data") or "{}")
            except ValueError:
                return {}
            return data if isinstance(data, dict) else {}
    return {}


def _ordered_sheets(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    sheets = snapshot.get("sheets")
    if not isinstance(sheets, dict) or not sheets:
        raise ConversionError("Snapshot has no sheets")
    order = [s for s in snapshot.get("sheetOrder") or [] if s in sheets]
    order += [s for s in sheets if s not in order]
    return [sheets[s] for s in order]


def _apply_cached_values(data: bytes, sheets: list[dict[str, Any]]) -> None:
    """Fill stored values for formula cells from a lazy read-only pass.

    The formula engine recalculates on load, but keeping the cached results makes
    the imported sheet readable immediately and preserves values of functions the
    client engine does not support.
    """
    by_name = {sheet["name"]: sheet for sheet in sheets}
    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception:
        return
    try:
        for ws in wb.worksheets:
            sheet = by_name.get(ws.title)
            if sheet is None:
                continue
            cell_data = sheet["cellData"]
            for row in ws.iter_rows():
                for cell in row:
                    if cell.value is None:
                        continue
                    entry = cell_data.get(str(cell.row - 1), {}).get(str(cell.column - 1))
                    if entry is None or not entry.get("f"):
                        continue
                    value = _plain_value(cell.value)
                    entry["v"] = value["v"]
                    entry["t"] = value["t"]
    finally:
        wb.close()


def _check_snapshot_cells(snapshot: dict[str, Any]) -> None:
    """Bound export work: a client-supplied snapshot can be arbitrarily large."""
    sheets = snapshot.get("sheets")
    if not isinstance(sheets, dict):
        raise ConversionError("Snapshot has no sheets")
    total = 0
    for sheet in sheets.values():
        cell_data = (sheet or {}).get("cellData") or {}
        if not isinstance(cell_data, dict):
            raise ConversionError("Snapshot cell data is invalid")
        for row in cell_data.values():
            if isinstance(row, dict):
                total += len(row)
                if total > MAX_CELLS:
                    raise ConversionError(f"Too many cells, the limit is {MAX_CELLS}")


def snapshot_to_xlsx(snapshot: dict[str, Any]) -> bytes:
    _check_snapshot_cells(snapshot)
    wb = XlWorkbook()
    wb.remove(wb.active)
    used: set[str] = set()
    rules = _validation_rules(snapshot)
    for sheet in _ordered_sheets(snapshot):
        ws = wb.create_sheet(_sheet_title(sheet.get("name"), used))
        cell_data = sheet.get("cellData") or {}
        formulas = _sheet_formulas(cell_data)
        for r, row in cell_data.items():
            for c, cell in (row or {}).items():
                if not isinstance(cell, dict):
                    continue
                ri, ci = int(r), int(c)
                value = _export_value(cell, formulas.get((ri, ci)))
                style = _resolve_style(snapshot, cell.get("s"))
                if value is None and not style:
                    continue
                target = ws.cell(row=ri + 1, column=ci + 1, value=value)
                _apply_style(target, style)

        for c, item in (sheet.get("columnData") or {}).items():
            if not isinstance(item, dict):
                continue
            dim = ws.column_dimensions[get_column_letter(int(c) + 1)]
            if isinstance(item.get("w"), int | float):
                dim.width = max((item["w"] - 5) / 7, 1)
            if item.get("hd"):
                dim.hidden = True
        for r, item in (sheet.get("rowData") or {}).items():
            if not isinstance(item, dict):
                continue
            dim = ws.row_dimensions[int(r) + 1]
            if isinstance(item.get("h"), int | float):
                dim.height = item["h"] * 3 / 4
            if item.get("hd"):
                dim.hidden = True

        for merge in sheet.get("mergeData") or []:
            ws.merge_cells(
                start_row=merge["startRow"] + 1,
                end_row=merge["endRow"] + 1,
                start_column=merge["startColumn"] + 1,
                end_column=merge["endColumn"] + 1,
            )

        freeze = sheet.get("freeze") or {}
        x, y = int(freeze.get("xSplit") or 0), int(freeze.get("ySplit") or 0)
        if x or y:
            ws.freeze_panes = f"{get_column_letter(x + 1)}{y + 1}"
        if sheet.get("showGridlines") == 0:
            ws.sheet_view.showGridLines = False
        if sheet.get("tabColor") and (tab := _hex_to_argb(sheet["tabColor"])):
            ws.sheet_properties.tabColor = tab
        if sheet.get("hidden"):
            ws.sheet_state = "hidden"

        for rule in rules.get(str(sheet.get("id")), []):
            if rule.get("type") not in ("list", "listMultiple") or not rule.get("formula1"):
                continue
            formula = str(rule["formula1"])
            formula1 = formula[1:] if formula.startswith("=") else f'"{formula}"'
            if len(formula1) > 255:
                continue  # Excel limit for inline lists
            dv = DataValidation(type="list", formula1=formula1, allow_blank=True)
            for rng in rule.get("ranges") or []:
                dv.add(
                    f"{get_column_letter(rng['startColumn'] + 1)}{rng['startRow'] + 1}:"
                    f"{get_column_letter(rng['endColumn'] + 1)}{rng['endRow'] + 1}"
                )
            ws.add_data_validation(dv)

    if not wb.worksheets:
        wb.create_sheet("Лист1")
    if all(ws.sheet_state == "hidden" for ws in wb.worksheets):
        wb.worksheets[0].sheet_state = "visible"
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def _csv_safe(value: Any) -> Any:
    """Neutralize text that spreadsheet apps would execute as a formula (CSV injection)."""
    if value is None:
        return ""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return f"'{value}"
    return value


def snapshot_to_csv(snapshot: dict[str, Any], sheet_id: str | None = None) -> bytes:
    _check_snapshot_cells(snapshot)
    sheets = _ordered_sheets(snapshot)
    sheet = next((s for s in sheets if s.get("id") == sheet_id), sheets[0])
    cell_data = sheet.get("cellData") or {}
    rows = [int(r) for r, row in cell_data.items() if row]
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    if rows:
        max_row = max(rows)
        max_col = max(int(c) for row in cell_data.values() if row for c in row)
        for r in range(max_row + 1):
            row = cell_data.get(str(r)) or {}
            values = []
            for c in range(max_col + 1):
                cell = row.get(str(c))
                if not isinstance(cell, dict):
                    values.append("")
                    continue
                text = _rich_text(cell)
                value = text if text is not None else cell.get("v")
                values.append(_csv_safe(value))
            writer.writerow(values)
    return buffer.getvalue().encode("utf-8-sig")
