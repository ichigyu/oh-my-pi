#!/usr/bin/env python3
"""从 JSON 输入生成 .xlsx 文件。

JSON 输入来自 stdin，或通过 --input <path> 传入文件。
输出结构化 JSON 到 stdout：{"ok": true, "output": "..."} 或 {"ok": false, "error": {...}}。
"""

import argparse
import json
import os
import sys
import traceback


def error_out(category, message, detail=None):
    payload = {
        "ok": False,
        "error": {
            "category": category,
            "message": message,
        },
    }
    if detail is not None:
        payload["error"]["detail"] = detail
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(1)


try:
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
except ImportError as exc:
    error_out("dependency_error", f"openpyxl 依赖不可用: {exc}")


def build_font(style):
    kwargs = {}
    if "bold" in style:
        kwargs["bold"] = bool(style["bold"])
    if "italic" in style:
        kwargs["italic"] = bool(style["italic"])
    if "font_size" in style:
        kwargs["size"] = style["font_size"]
    if "font_color" in style:
        kwargs["color"] = style["font_color"]
    if not kwargs:
        return None
    return Font(**kwargs)


def build_fill(style):
    color = style.get("fill_color")
    if not color:
        return None
    return PatternFill(start_color=color, end_color=color, fill_type="solid")


def build_alignment(style):
    align = style.get("align")
    valign = style.get("valign")
    if not align and not valign:
        return None
    kwargs = {}
    if align:
        kwargs["horizontal"] = align
    if valign:
        kwargs["vertical"] = valign
    return Alignment(**kwargs)


def build_border(style):
    spec = style.get("border")
    if not spec:
        return None
    style_name = spec if isinstance(spec, str) else "thin"
    side = Side(style=style_name)
    return Border(left=side, right=side, top=side, bottom=side)


def apply_style(cell, style):
    if not style:
        return
    font = build_font(style)
    if font:
        cell.font = font
    fill = build_fill(style)
    if fill:
        cell.fill = fill
    alignment = build_alignment(style)
    if alignment:
        cell.alignment = alignment
    border = build_border(style)
    if border:
        cell.border = border
    if "number_format" in style:
        cell.number_format = style["number_format"]


def write_sheet(ws, sheet_spec):
    rows = sheet_spec.get("rows", [])
    for row_idx, row in enumerate(rows, start=1):
        for col_idx, cell_spec in enumerate(row, start=1):
            cell = ws.cell(row=row_idx, column=col_idx)
            if isinstance(cell_spec, dict):
                cell.value = cell_spec.get("value")
                apply_style(cell, cell_spec.get("style"))
            else:
                cell.value = cell_spec

    for col_spec in sheet_spec.get("columns", []):
        idx = col_spec.get("index")
        width = col_spec.get("width")
        if idx is None or width is None:
            continue
        ws.column_dimensions[get_column_letter(idx)].width = width

    for row_num_str, height in sheet_spec.get("row_heights", {}).items():
        ws.row_dimensions[int(row_num_str)].height = height

    if sheet_spec.get("freeze_header"):
        ws.freeze_panes = "A2"


def generate(spec):
    if not isinstance(spec, dict):
        raise ValueError("invalid spec: 根节点必须是 JSON object")

    output_path = spec.get("output")
    if not output_path:
        raise ValueError("missing required field: output")

    sheets = spec.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        raise ValueError("missing required field: sheets (must be non-empty list)")

    for sheet_spec in sheets:
        if not isinstance(sheet_spec, dict):
            raise ValueError("invalid sheet spec: 每个 sheet 必须是 JSON object")
        rows = sheet_spec.get("rows", [])
        if not isinstance(rows, list) or any(not isinstance(row, list) for row in rows):
            raise ValueError("invalid sheet spec: rows 必须是二维数组")

    wb = Workbook()
    wb.remove(wb.active)

    used_names = [sheet_spec.get("name") for sheet_spec in sheets if sheet_spec.get("name")]
    for sheet_spec in sheets:
        name = sheet_spec.get("name")
        if not name:
            name = "Sheet"
            suffix = 2
            while name in used_names:
                name = f"Sheet{suffix}"
                suffix += 1
            used_names.append(name)
        ws = wb.create_sheet(title=name)
        write_sheet(ws, sheet_spec)

    wb.save(output_path)

    if not os.path.isfile(output_path):
        raise RuntimeError(f"保存后文件不存在: {output_path}")
    try:
        load_workbook(output_path)
    except Exception as exc:
        raise RuntimeError(f"保存后 openpyxl 无法读取生成的文件: {exc}")

    return output_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", help="JSON 输入文件路径；不传则从 stdin 读取")
    args = parser.parse_args()

    try:
        if args.input:
            with open(args.input, "r", encoding="utf-8") as f:
                raw = f.read()
        else:
            raw = sys.stdin.read()
    except OSError as exc:
        error_out("io_error", f"无法读取输入: {exc}")

    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as exc:
        error_out("invalid_json", f"JSON 解析失败: {exc}")

    try:
        output_path = generate(spec)
    except ValueError as exc:
        error_out("invalid_spec", str(exc))
    except Exception as exc:
        error_out("generation_error", str(exc), traceback.format_exc())

    print(json.dumps({"ok": True, "output": output_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
