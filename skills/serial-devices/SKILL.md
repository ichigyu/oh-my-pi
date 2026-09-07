---
name: serial-devices
description: >-
  Use serial_exec to run commands on a serial-connected device (development board, router,
  embedded system) via tmux shared terminal, and serial_read to read current screen content.
  Use when the user asks to interact with a device connected via RS232/USB-to-serial,
  run commands on a development board, or check serial device status.
---

# Serial Devices

通过 tmux + picocom 共享终端与串口设备交互。

## 工具

### serial_exec

在串口设备上执行 shell 命令并返回输出和退出码。

参数：
- `command`（必填）：要执行的 shell 命令
- `port`（可选）：串口设备路径，默认 `/dev/ttyUSB0`
- `baud`（可选）：波特率，默认 `115200`
- `timeout_seconds`（可选）：超时秒数，默认 30，最大 600
- `allowDangerous`（可选）：仅在用户明确授权破坏性操作时设为 true

### serial_read

读取当前串口终端屏幕内容（基于 tmux capture-pane），不发送任何命令。

参数：
- `port`（可选）：串口设备路径，默认 `/dev/ttyUSB0`
- `baud`（可选）：波特率，默认 `115200`（用于首次创建 session）
- `lines`（可选）：捕获行数，默认 50

### 使用指南

- 首次调用自动创建 tmux session（`pi-serial-<port>`）并启动 picocom
- 首次调用时自动在 Orca 中分屏显示串口终端（如 Orca 可用）
- 用户也可手动 `tmux attach -t pi-serial-ttyUSB0` 实时观看和交互
- 命令通过标记法检测完成和退出码
- 破坏性命令（reboot、rm -rf、dd 等）需要 `allowDangerous=true`
- 超时后自动发送 Ctrl+C 中断运行中命令
- serial_read 用于查看设备当前状态或了解用户手动做了什么

### Orca 分屏

首次 serial_exec 或 serial_read 调用后，extension 自动调用 `orca-ide terminal split` 创建一个 attach 到 tmux session 的终端 pane。用户在 Orca 中可以看到左边 pi 对话、右边实时串口。

如果 Orca 不可用（非 Orca 环境），分屏跳过，不影响功能。

### 前提条件

- `tmux` 和 `picocom` 已安装
- 串口设备已连接（WSL2 需先 `usbipd attach --wsl`）
- 当前用户在 `dialout` 组（或有 /dev/ttyUSB* 读写权限）
