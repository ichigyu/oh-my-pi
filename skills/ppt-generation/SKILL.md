---
name: ppt-generation
description: 基于 python-pptx 从 JSON 输入生成 .pptx 演示文稿，支持读取已有模板按 layout 和占位符填充内容，也支持无模板从零生成；支持文本、图片、表格占位符和图表插入。用户明确要求生成/导出 PPT、演示文稿或幻灯片时使用；不涉及动画、复杂母版定制、字体嵌入。
---

# PPT 生成

## 触发边界

用户明确要求生成 `.pptx` 文件时使用，包括基于模板填充或无模板从零生成。

不适用：

- 动画、切换效果
- 复杂母版定制（自定义 slide master 结构）
- 字体嵌入
- 读取或分析已有 PPT 文件内容 —— 使用 `mineru-document-parsing` skill

## 依赖安装

```bash
pip install -r skills/ppt-generation/requirements.txt
```

## 使用流程

1. 若有模板，先用 `inspect_template.py` 检查模板可用的 layout 名称和占位符信息。
2. 根据 layout 名称和占位符名称/idx，准备 `gen_ppt.py` 的 JSON 输入。
3. 调用 `gen_ppt.py` 生成 `.pptx`。
4. 用 python-pptx 校验生成结果可读。

## inspect_template.py

```bash
python3 skills/ppt-generation/scripts/inspect_template.py template.pptx
```

输出结构化 JSON：

```json
{
  "ok": true,
  "layouts": [
    {"name": "Title and Content", "placeholders": [{"idx": 0, "type": "TITLE (1)", "name": "Title 1"}, ...]}
  ],
  "existing_slides": [...],
  "slide_size": {"width_emu": 9144000, "height_emu": 6858000}
}
```

用返回的 `layouts[].name` 作为 `gen_ppt.py` 中 `slides[].layout` 的值，用 `placeholders[].name`（或 `idx` 的字符串形式）作为 `placeholders` 字段的 key。

## gen_ppt.py JSON 输入格式

### 模板填充模式

传入 `template` 字段：

```json
{
  "template": "template.pptx",
  "output": "out.pptx",
  "slides": [
    {
      "layout": "Title and Content",
      "placeholders": {
        "Title 1": "标题文本",
        "Content Placeholder 2": "正文内容",
        "Picture Placeholder 3": {"image": "path/to/pic.png"},
        "Content Placeholder 4": {"table": [["表头1", "表头2"], ["值1", "值2"]]}
      },
      "charts": [
        {"type": "bar", "categories": ["Jan", "Feb"], "series": [{"name": "Sales", "values": [10, 20]}]}
      ]
    }
  ]
}
```

- `layout`：必填，必须匹配模板中已有的 layout 名称（用 `inspect_template.py` 查看）。
- `placeholders`：可选，key 是占位符名称（`inspect_template.py` 返回的 `name`）或占位符 `idx` 的字符串形式；value 可以是纯文本字符串，或 `{"image": "路径"}`（图片占位符）、`{"table": [[...],[...]]}`（表格，写入到占位符的位置和尺寸）。
- 占位符不存在时报错，不静默跳过。

### 无模板从零生成模式

不传 `template`，用 `layout_index` 选择 PowerPoint 默认母版中的内建 layout（0-11，对应 python-pptx 默认 `Presentation()` 的 `slide_layouts`，常用：`1` = Title and Content、`6` = Blank、`3` = Two Content）：

```json
{
  "output": "out.pptx",
  "slides": [
    {"layout_index": 1, "placeholders": {"Title 1": "Hello", "Content Placeholder 2": "World"}}
  ]
}
```

### 图表插入（`charts` 字段，两种模式通用）

- `type`：`bar` / `line` / `pie`。
- `categories`：分类数组。
- `series`：`[{"name": "系列名", "values": [数值...]}]`。
- 可选 `left_emu`/`top_emu`/`width_emu`/`height_emu`：位置和尺寸（EMU 单位，1 英寸 = 914400 EMU），缺省为幻灯片中部合理位置。

## 调用方式

```bash
python3 skills/ppt-generation/scripts/inspect_template.py template.pptx
echo '{"template":"template.pptx","output":"out.pptx","slides":[{"layout":"Title and Content","placeholders":{"Title 1":"Hello","Content Placeholder 2":"World"}}]}' | python3 skills/ppt-generation/scripts/gen_ppt.py
```

或从文件读取输入：

```bash
python3 skills/ppt-generation/scripts/gen_ppt.py --input spec.json
```

## 输出与错误处理

成功时输出到 stdout：

```json
{"ok": true, "output": "out.pptx"}
```

失败时输出结构化 JSON 错误，不抛出未捕获异常，退出码非 0：

```json
{"ok": false, "error": {"category": "invalid_spec", "message": "..."}}
```

`category` 取值：`io_error`（读取输入失败）、`invalid_json`（JSON 解析失败）、`invalid_spec`（缺少必填字段、layout/占位符不存在、图片文件不存在等）、`generation_error`（python-pptx 写入失败，附带 `detail` traceback）、`dependency_error`（python-pptx 未安装或无法导入）。

## 校验方式

脚本执行后应校验文件存在性和 python-pptx 可读性：

```bash
python3 -c "from pptx import Presentation; prs = Presentation('out.pptx'); print(len(prs.slides))"
```

## 样例

- `examples/from_template.json` + `examples/base_template.pptx`：从模板按 layout 填充文本占位符
- `examples/no_template.json`：无模板从零生成，含文本占位符和图表

## 能力边界

- 不支持动画、切换效果。
- 不支持自定义 slide master 结构，只能使用模板或默认母版中已有的 layout。
- 不支持字体嵌入。
- 图片占位符按占位符原有位置和尺寸缩放插入，不做智能裁剪。
- 图表类型仅覆盖 `bar`/`line`/`pie`，不含组合图表、3D 图表。
- 视觉效果最终需人工用 PowerPoint/WPS/LibreOffice Impress 打开确认；python-pptx 校验仅确认结构可读。
