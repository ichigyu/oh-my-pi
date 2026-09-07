---
name: feishu-docs
description: 飞书云文档 bootstrap：检测 lark-cli 安装和认证状态，引导用户完成首次配置。当用户首次提到飞书文档、飞书云文档、Lark Docs、知识库文档读写，或 lark-cli 未安装/未认证时使用。不负责文档操作本身（由 lark-doc、lark-drive、lark-wiki skills 覆盖）。
---

# 飞书云文档 Bootstrap

引导用户完成飞书 CLI 安装和认证，使 pi 能通过 lark-doc、lark-drive、lark-wiki skills 操作飞书云文档。

## 职责

- 检测 `lark-cli` 是否已安装
- 检测认证状态
- 引导用户完成首次配置（应用凭证 + 用户授权）
- 配置完成后退出，后续操作交给 lark-doc、lark-drive、lark-wiki、lark-shared skills

本 skill 不封装任何飞书文档操作。

## 流程

### 1. 检测 lark-cli 安装

```bash
lark-cli --version
```

- 成功：继续步骤 2
- 失败（command not found）：告诉用户运行以下命令安装：
  ```bash
  npm install -g @larksuite/cli && npx skills add larksuite/cli -s lark-doc lark-drive lark-wiki lark-shared -y -g
  ```
  或者如果用户使用 oh-my-pi，运行 `npm run setup`。安装完成后重新检测。

### 2. 检测认证状态

```bash
lark-cli auth status
```

输出为 JSON。根据退出码和 `ok` 字段判断：

- **退出码 0 + `ok: true`**：已登录，bootstrap 完成。告知用户可以开始使用飞书文档操作，转交给 lark-doc 等 skills。
- **退出码非 0 + `error.subtype: "not_configured"`**：未配置应用凭证，进入步骤 3。
- **退出码非 0 + 其他 error**：未登录或登录过期，进入步骤 4。

### 3. 配置应用凭证（首次使用）

执行：

```bash
lark-cli config init --new
```

检查退出码：

- **退出码 0**：命令成功，从输出中提取浏览器链接（URL），告诉用户：
  > 请在浏览器中打开以下链接完成应用配置：
  > [链接]
  >
  > 完成后告诉我。
- **退出码非 0 或输出中无有效 URL**：报告命令错误信息，停止 bootstrap。

等用户确认后继续步骤 4。

### 4. 用户授权登录

执行：

```bash
lark-cli auth login --recommend
```

检查退出码：

- **退出码 0**：命令成功，从输出中提取授权链接（URL），告诉用户：
  > 请在浏览器中打开以下链接完成授权：
  > [链接]
  >
  > 完成后告诉我。
- **退出码非 0 或输出中无有效 URL**：报告命令错误信息，停止 bootstrap。

等用户确认后验证：

```bash
lark-cli auth status
```

确认 `ok: true` 后，bootstrap 完成。如果仍然失败，报告错误并停止。

### 5. Bootstrap 完成

告知用户飞书 CLI 已就绪，可用能力包括：

- **lark-doc**：读取、创建、编辑飞书云文档
- **lark-drive**：搜索、定位、管理云空间文件
- **lark-wiki**：浏览和管理知识库

## 规则

- 每个步骤涉及浏览器交互时，必须等用户确认完成后再继续。
- 不要尝试自动化浏览器操作。
- 如果命令输出包含 URL，完整原样转发给用户，不编解码或修改。
- 如果 lark-shared skill 已加载，认证相关的详细逻辑以 lark-shared 为准。
- bootstrap 完成后不再需要本 skill，后续飞书操作由对应 lark-* skills 处理。
