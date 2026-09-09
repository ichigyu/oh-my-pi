---
name: excel-generation
description: 从 JSON 输入生成 .xlsx 文件，支持多 sheet、单元格值/样式、公式写入、列宽行高与冻结首行。用户明确要求生成/导出 Excel 表格、报表或数据文件时使用；不涉及图表、条件格式、模板填充或数据透视表（见后续 issue #159 扩展）。
---

# Excel 生成

## 触发边界

用户明确要求生成 `.xlsx` 文件，且需求是基础表格写入（值、样式、公式、多 sheet、列宽行高、冻结首行）时使用。

不适用：

- 需要图表、条件格式、数据验证或模板占位符填充 —— 这些是 excel-generation 的后续扩展能力，若已实现请参考同一 skill 目录下的扩展说明；未实现时如实告知边界。
- 数据透视表自动生成 —— openpyxl 不支持，只能写入原始数据并建议用户在 Excel/WPS 中手动创建透视表。
- 读取或分析已有 Excel 文件的内容 —— 使用 `mineru-document-parsing` skill。

## 依赖安装

```bash
pip install -r skills/excel-generation/requirements.txt
```

## JSON 输入格式

```json
{
  "output": "path/to/out.xlsx",
  "sheets": [
    {
      "name": "Sheet1",
      "freeze_header": true,
      "columns": [{"index": 1, "width": 20}],
      "row_heights": {"1": 24},
      "rows": [
        [
          {"value": "标题", "style": {
            "bold": true,
            "italic": false,
            "font_size": 12,
            "font_color": "FFFFFF",
            "fill_color": "4472C4",
            "align": "center",
            "valign": "center",
            "border": "thin",
            "number_format": "0.00"
          }},
          "普通值",
          100,
          "=A2+B2"
        ]
      ]
    }
  ]
}
```

字段说明：

- `output`（必填）：输出文件路径。
- `sheets`（必填，非空数组）：每个元素定义一个 sheet。
  - `name`：sheet 名称，缺省为 `Sheet`。
  - `rows`：二维数组，每个单元格可以是原始值（字符串/数字/公式字符串）或 `{"value": ..., "style": {...}}` 对象。
  - `columns`：可选，`[{"index": 列号(从1开始), "width": 宽度}]`。
  - `row_heights`：可选，`{"行号(字符串)": 高度}`。
  - `freeze_header`：可选，`true` 时冻结首行（等价 `freeze_panes = "A2"`）。
- `style` 支持字段：`bold`、`italic`、`font_size`、`font_color`（RGB hex，不带 `#`）、`fill_color`（RGB hex）、`align`（`left`/`center`/`right`）、`valign`（`top`/`center`/`bottom`）、`border`（如 `thin`，应用到四边）、`number_format`（Excel number format 字符串）。
- 公式：单元格值以 `=` 开头的字符串会被 Excel/openpyxl 识别为公式，本 skill 不校验公式语法，只原样写入。
- 跨 sheet 引用使用标准 Excel 语法，例如 `=Sheet1!A1`。

## 调用方式

```bash
echo '{"output":"out.xlsx","sheets":[{"name":"Sheet1","rows":[[1,2,3]]}]}' | python3 skills/excel-generation/scripts/gen_excel.py
```

或从文件读取输入：

```bash
python3 skills/excel-generation/scripts/gen_excel.py --input spec.json
```

## 输出与错误处理

成功时输出到 stdout：

```json
{"ok": true, "output": "out.xlsx"}
```

失败时输出结构化 JSON 错误，不抛出未捕获异常，退出码非 0：

```json
{"ok": false, "error": {"category": "invalid_spec", "message": "..."}}
```

`category` 取值：`io_error`（读取输入失败）、`invalid_json`（JSON 解析失败）、`invalid_spec`（缺少必填字段）、`generation_error`（openpyxl 写入失败，附带 `detail` traceback）。

## 校验方式

脚本执行后应校验文件存在性和 openpyxl 可读性：

```bash
python3 -c "import openpyxl; wb = openpyxl.load_workbook('out.xlsx'); print(wb.sheetnames)"
```

## 样例

见 `examples/basic_table.json`（纯数据表格）和 `examples/multi_sheet_formula.json`（多 sheet + 公式 + 样式）。

## 能力边界

- 不支持图表、条件格式、数据验证、模板占位符填充。
- 不支持数据透视表自动生成；如需透视表，写入原始数据后提示用户手动创建。
- openpyxl 只写入公式字符串，不计算或校验公式结果，需在 Excel/WPS/LibreOffice 中打开才会求值。
- 不支持读取已有工作簿或合并单元格；这些超出当前 issue 范围。
