"""Workbook templates as Univer IWorkbookData snapshots.

Colors are authored for a light palette: in dark mode Univer inverts canvas
colors, so the same snapshot renders correctly in both themes and exports to
XLSX with the expected colors.
"""

import json
import secrets
from typing import Any

APP_VERSION = "1.2.0"
LOCALE = "ruRU"

STRING, NUMBER = 1, 2
H_LEFT, H_CENTER, H_RIGHT = 1, 2, 3
V_MIDDLE = 2

RUB = '#,##0 "₽"'
RUB_DIFF = '[Red]+#,##0 "₽";[Color10]-#,##0 "₽";0 "₽"'
PERCENT = "0%"
DATE = "dd.mm.yyyy"


def _id() -> str:
    return secrets.token_urlsafe(8).replace("-", "x").replace("_", "y")


def _sheet(sheet_id: str, name: str, *, rows: int = 200, cols: int = 26) -> dict[str, Any]:
    return {
        "id": sheet_id,
        "name": name,
        "tabColor": "",
        "hidden": 0,
        "freeze": {"xSplit": 0, "ySplit": 0, "startRow": -1, "startColumn": -1},
        "rowCount": rows,
        "columnCount": cols,
        "zoomRatio": 1,
        "scrollTop": 0,
        "scrollLeft": 0,
        "defaultColumnWidth": 96,
        "defaultRowHeight": 28,
        "mergeData": [],
        "cellData": {},
        "rowData": {},
        "columnData": {},
        "rowHeader": {"width": 46},
        "columnHeader": {"height": 24},
        "showGridlines": 1,
        "rightToLeft": 0,
    }


def _workbook(
    title: str, sheets: list[dict[str, Any]], styles: dict[str, Any], resources: list[Any]
) -> dict[str, Any]:
    return {
        "id": _id(),
        "name": title,
        "appVersion": APP_VERSION,
        "locale": LOCALE,
        "styles": styles,
        "sheetOrder": [s["id"] for s in sheets],
        "sheets": {s["id"]: s for s in sheets},
        "resources": resources,
    }


def blank_workbook(title: str) -> dict[str, Any]:
    return _workbook(title, [_sheet(_id(), "Лист1")], {}, [])


class _Writer:
    """Small helper that fills cellData with values, formulas and named styles."""

    def __init__(self, sheet: dict[str, Any]) -> None:
        self.cells: dict[str, dict[str, Any]] = sheet["cellData"]

    def set(
        self,
        row: int,
        col: int,
        value: Any = None,
        *,
        formula: str | None = None,
        style: str | None = None,
    ) -> None:
        cell: dict[str, Any] = {}
        if formula is not None:
            cell["f"] = formula
        elif value is not None:
            cell["v"] = value
            cell["t"] = NUMBER if isinstance(value, int | float) else STRING
        if style:
            cell["s"] = style
        self.cells.setdefault(str(row), {})[str(col)] = cell

    def row(self, row: int, values: list[Any], styles: list[str | None]) -> None:
        for col, (value, style) in enumerate(zip(values, styles, strict=True)):
            if isinstance(value, str) and value.startswith("="):
                self.set(row, col, formula=value, style=style)
            else:
                self.set(row, col, value, style=style)


def _widths(sheet: dict[str, Any], widths: list[int]) -> None:
    sheet["columnData"] = {str(i): {"w": w} for i, w in enumerate(widths)}


FINANCE_STYLES: dict[str, Any] = {
    "hdr": {"bl": 1, "bg": {"rgb": "#F1F2F6"}, "cl": {"rgb": "#1F2330"}, "vt": V_MIDDLE},
    "hdr_r": {
        "bl": 1,
        "bg": {"rgb": "#F1F2F6"},
        "cl": {"rgb": "#1F2330"},
        "vt": V_MIDDLE,
        "ht": H_RIGHT,
    },
    "txt": {"vt": V_MIDDLE},
    "muted": {"vt": V_MIDDLE, "cl": {"rgb": "#5B6070"}},
    "rub": {"vt": V_MIDDLE, "ht": H_RIGHT, "n": {"pattern": RUB}},
    "diff": {"vt": V_MIDDLE, "ht": H_RIGHT, "n": {"pattern": RUB_DIFF}},
    "status": {"vt": V_MIDDLE, "ht": H_CENTER},
    "date": {"vt": V_MIDDLE, "n": {"pattern": DATE}},
    "pct": {"vt": V_MIDDLE, "ht": H_RIGHT, "n": {"pattern": PERCENT}},
    "tot": {"bl": 1, "vt": V_MIDDLE, "bd": {"t": {"s": 1, "cl": {"rgb": "#C9CCD6"}}}},
    "tot_rub": {
        "bl": 1,
        "vt": V_MIDDLE,
        "ht": H_RIGHT,
        "n": {"pattern": RUB},
        "bd": {"t": {"s": 1, "cl": {"rgb": "#C9CCD6"}}},
    },
    "tot_diff": {
        "bl": 1,
        "vt": V_MIDDLE,
        "ht": H_RIGHT,
        "n": {"pattern": RUB_DIFF},
        "bd": {"t": {"s": 1, "cl": {"rgb": "#C9CCD6"}}},
    },
    "tot_muted": {
        "vt": V_MIDDLE,
        "cl": {"rgb": "#8B90A0"},
        "bd": {"t": {"s": 1, "cl": {"rgb": "#C9CCD6"}}},
    },
}

# Date serials (1900 system) for 01.10.2026 .. 31.10.2026: 46296 is 2026-10-01.
OCT_1 = 46296

OPERATIONS = [
    (0, "Зарплата за сентябрь", "Зарплата", 120000),
    (0, "Аренда квартиры", "Аренда", 30000),
    (2, "Супермаркет", "Продукты", 5200),
    (3, "Проездной на месяц", "Транспорт", 3100),
    (4, "Подписка на музыку и кино", "Подписки", 1990),
    (6, "Монитор", "Техника", 12800),
    (9, "Рынок и бытовая химия", "Продукты", 4800),
    (11, "Такси", "Транспорт", 2600),
    (12, "Концерт", "Развлечения", 4500),
    (14, "Облачное хранилище и ПО", "Подписки", 2410),
    (17, "Супермаркет", "Продукты", 4500),
    (20, "Такси в аэропорт", "Транспорт", 3500),
    (23, "Игры", "Развлечения", 7000),
    (27, "Домен и хостинг", "Подписки", 1000),
]

OVERVIEW = [
    ("Зарплата", 120000, "Выполнено", OCT_1, "Основной доход"),
    ("Аренда", 30000, "Выполнено", OCT_1, "Квартира"),
    ("Продукты", 15000, "Выполнено", "весь месяц", "Еда и бытовые товары"),
    ("Транспорт", 8000, "В процессе", "весь месяц", "Метро, такси"),
    ("Подписки", 6000, "Выполнено", "весь месяц", "Сервисы и ПО"),
    ("Техника", 20000, "В процессе", "весь месяц", "Покупка оборудования"),
    ("Развлечения", 10000, "Ожидает", "весь месяц", "Кино, концерты, игры"),
]


def finance_workbook(title: str) -> dict[str, Any]:
    overview_id, october_id, categories_id = _id(), _id(), _id()
    overview = _sheet(overview_id, "Обзор")
    october = _sheet(october_id, "Октябрь")
    categories = _sheet(categories_id, "Категории")

    # Октябрь: operations journal.
    w = _Writer(october)
    w.row(0, ["Дата", "Описание", "Категория", "Сумма"], ["hdr", "hdr", "hdr", "hdr_r"])
    for i, (day, text, category, amount) in enumerate(OPERATIONS, start=1):
        w.row(i, [OCT_1 + day, text, category, amount], ["date", "txt", "txt", "rub"])
    _widths(october, [110, 260, 150, 130])
    october["freeze"] = {"xSplit": 0, "ySplit": 1, "startRow": 1, "startColumn": 0}

    # Обзор: plan vs fact per category, fact comes from the journal.
    w = _Writer(overview)
    w.row(
        0,
        ["Категория", "План", "Факт", "Разница", "Статус", "Ответственный", "Дата", "Комментарий"],
        ["hdr", "hdr_r", "hdr_r", "hdr_r", "hdr", "hdr", "hdr", "hdr"],
    )
    last = len(OVERVIEW) + 1
    for i, (category, plan, status, date, comment) in enumerate(OVERVIEW, start=1):
        r = i + 1
        w.row(
            i,
            [
                category,
                plan,
                f"=SUMIF(Октябрь!$C$2:$C$200,A{r},Октябрь!$D$2:$D$200)",
                f"=C{r}-B{r}",
                status,
                "Я",
                date,
                comment,
            ],
            [
                "txt",
                "rub",
                "rub",
                "diff",
                "status",
                "txt",
                "date" if isinstance(date, int) else "txt",
                "muted",
            ],
        )
    total = last
    w.row(
        total,
        [
            "Итого",
            f"=SUM(B3:B{last})",
            f"=SUM(C3:C{last})",
            f"=C{last + 1}-B{last + 1}",
            "—",
            "—",
            "—",
            "—",
        ],
        [
            "tot",
            "tot_rub",
            "tot_rub",
            "tot_diff",
            "tot_muted",
            "tot_muted",
            "tot_muted",
            "tot_muted",
        ],
    )
    _widths(overview, [170, 130, 130, 120, 130, 150, 140, 220])
    overview["freeze"] = {"xSplit": 0, "ySplit": 1, "startRow": 1, "startColumn": 0}
    overview["rowData"] = {"0": {"h": 32}}

    # Категории: expense structure and monthly totals.
    w = _Writer(categories)
    w.row(0, ["Категория", "Факт", "Доля"], ["hdr", "hdr_r", "hdr_r"])
    expense_rows = list(range(3, last + 1))  # Обзор rows 3..8 are expenses
    for i, src in enumerate(expense_rows, start=1):
        r = i + 1
        w.row(
            i,
            [f"=Обзор!A{src}", f"=Обзор!C{src}", f"=B{r}/SUM($B$2:$B${len(expense_rows) + 1})"],
            ["txt", "rub", "pct"],
        )
    t = len(expense_rows) + 2  # blank row, then totals
    w.row(t, ["Итоги", "Факт", "План"], ["hdr", "hdr_r", "hdr_r"])
    w.row(t + 1, ["Доходы", "=Обзор!C2", "=Обзор!B2"], ["txt", "rub", "rub"])
    w.row(t + 2, ["Расходы", f"=Обзор!C{total + 1}", f"=Обзор!B{total + 1}"], ["txt", "rub", "rub"])
    w.row(
        t + 3,
        ["Остаток", f"=B{t + 2}-B{t + 3}", f"=C{t + 2}-C{t + 3}"],
        ["tot", "tot_rub", "tot_rub"],
    )
    _widths(categories, [170, 130, 130, 130])

    status_rule = {
        "uid": _id(),
        "type": "list",
        "formula1": "Выполнено,В процессе,Ожидает",
        "formula2": "#DCFCE7,#FEF3C7,#EDE9FE",
        "ranges": [{"startRow": 1, "endRow": last - 1, "startColumn": 4, "endColumn": 4}],
        "renderMode": 2,
        "allowBlank": True,
        "showErrorMessage": True,
        "errorStyle": 2,
    }
    resources = [
        {
            "name": "SHEET_DATA_VALIDATION_PLUGIN",
            "data": json.dumps({overview_id: [status_rule]}, ensure_ascii=False),
        }
    ]
    return _workbook(title, [overview, october, categories], FINANCE_STYLES, resources)


TEMPLATES = {
    "blank": blank_workbook,
    "finance": finance_workbook,
}
