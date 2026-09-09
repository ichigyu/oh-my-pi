---
name: excel-generation
description: 从 JSON 输入生成 .xlsx 文件，支持多 sheet、单元格值/样式、公式写入、列宽行高、冻结首行、图表（柱状/折线/饼图/面积图）、条件格式、数据验证，以及基于已有模板的占位符填充。用户明确要求生成/导出 Excel 表格、报表或数据文件时使用；不涉及数据透视表自动生成、VBA/宏或公式计算。
---

# Excel 生成

## 触发边界

用户明确要求生成 `.xlsx` 文件，且需求是基础表格写入（值、样式、公式、多 sheet、列宽行高、冻结首行）时使用。

不适用：

- 数据透视表自动生成 —— openpyxl 不支持，只能写入原始数据并建议用户在 Excel/WPS 中手动创建透视表（见下方“数据透视表边界”）。
- 读取或分析已有 Excel 文件的内容 —— 使用 `mineru-document-parsing` skill。
- VBA/宏、公式计算结果 —— 本 skill 只写入公式字符串，不触发计算。

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
- `charts`：可选，图表数组，每项：
  - `type`：`bar` / `line` / `pie` / `area`。
  - `title`：图表标题。
  - `data`：`{"min_col":, "min_row":, "max_col":, "max_row":}`，1-based 单元格坐标，通常包含表头行用于系列命名。
  - `titles_from_data`：可选，默认 `true`，表示 `data` 首行/首列作为系列名。
  - `categories`：可选，`{"min_col":, "min_row":, "max_col":, "max_row":}`，分类轴数据范围。
  - `anchor`：图表左上角锚点单元格，如 `"E2"`。
- `conditional_formatting`：可选，规则数组，每项：
  - `range`：应用范围，如 `"B2:B10"`。
  - `type`：`color_scale` / `cell_is` / `formula`。
  - `color_scale`：可选 `colors`（3 个 hex 颜色，最小/中位/最大）。
  - `cell_is`：`operator`（如 `greaterThan`）、`formula`（数组）、可选 `fill_color`。
  - `formula`：`formula`（数组，Excel 公式字符串）、可选 `fill_color`。
- `data_validations`：可选，规则数组，每项：
  - `range`：应用范围。
  - `type`：openpyxl 校验类型，如 `list`、`whole`、`decimal`。
  - `formula1`：校验表达式，如 `"\"A,B,C\""` 表示下拉列表。
  - `allow_blank`：可选，默认 `true`。
  - `error_message` / `error_title`：可选，非法输入时的提示。

## 模板填充模式

传入 `template` 和 `data` 时进入模板填充模式，忽略 `sheets`：

```json
{
  "template": "path/to/template.xlsx",
  "output": "path/to/out.xlsx",
  "data": {"name": "张三", "amount": "100"}
}
```

- 读取 `template` 指定的已有 `.xlsx`，扫描所有 sheet 的所有单元格。
- 单元格值中形如 `${key}` 的占位符会被 `data[key]` 的字符串值替换，原有字体、填充、对齐等样式保留不变。
- 未匹配到的占位符原样保留，不报错。
- 不支持图片、图表、合并单元格内的占位符替换语义之外的模板结构变更。

## 调用方式

```bash
echo '{"output":"out.xlsx","sheets":[{"name":"Sheet1","rows":[[1,2,3]]}]}' | python3 skills/excel-generation/scripts/gen_excel.py
```

模板填充：

```bash
echo '{"template":"template.xlsx","output":"out.xlsx","data":{"name":"张三"}}' | python3 skills/excel-generation/scripts/gen_excel.py
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

`category` 取值：`io_error`（读取输入失败）、`invalid_json`（JSON 解析失败）、`invalid_spec`（缺少必填字段、schema 不合法、不支持的图表/校验类型、template 文件不存在等）、`generation_error`（openpyxl 写入失败，附带 `detail` traceback）、`dependency_error`（openpyxl 未安装或无法导入）。

## 校验方式

脚本执行后应校验文件存在性和 openpyxl 可读性：

```bash
python3 -c "import openpyxl; wb = openpyxl.load_workbook('out.xlsx'); print(wb.sheetnames)"
```

## 样例

见 `examples/basic_table.json`（纯数据表格）、`examples/multi_sheet_formula.json`（多 sheet + 公式 + 样式）、`examples/chart_conditional_format.json`（图表 + 条件格式 + 数据验证）、`examples/template_fill.xlsx` + `examples/template_fill_data.json`（模板填充）。

## 数据透视表边界

openpyxl 不支持生成原生数据透视表（PivotTable）对象。遇到用户要求透视表时：

1. 写入原始明细数据（可用 `sheets` 基础能力）。
2. 在 SKILL.md 或回复中明确告知：当前 skill 不生成透视表，需在 Excel/WPS 中基于写入的原始数据手动创建。
3. 不得伪造透视表结构或静默跳过用户需求。

## 能力边界

- 不支持数据透视表自动生成；如需透视表，写入原始数据后提示用户手动创建。
- openpyxl 只写入公式字符串，不计算或校验公式结果，需在 Excel/WPS/LibreOffice 中打开才会求值。
- 不支持 VBA/宏。
- 不支持读取已有工作簿并合并到新工作簿（模板填充模式仅做占位符替换，不做结构合并）。
- 图表视觉效果需在 Excel/WPS/LibreOffice 中打开人工确认；openpyxl 校验仅确认 chart 对象存在。
