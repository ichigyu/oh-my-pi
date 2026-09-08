---
name: remote-devices
description: Manage and operate remote computers, VPS, desktops, servers, and SSH devices through the remote-devices Pi extension. Use when the user mentions remote connection, SSH, VPS, server, lab machine, desktop, adding SSH keys, running commands on a remote machine, or adding a new remote device.
---

# Remote Devices

Use this skill whenever the user wants to manage known remote machines or add new ones.

## Core rule

Prefer the dedicated remote device tools over ad-hoc `ssh` in bash:

1. If the user names a machine by natural language, call `remote_resolve_device` first.
2. When the user asks to check all configured devices quickly, use `remote_probe_devices`; it prints an aligned manageability table (`ROUTE`, `CHECK`, `ENDPOINT`) based on each device's configured SSH route.
3. For normal single remote commands on a resolved device, call `remote_exec` directly. Do **not** run `remote_test_connection` as a routine preflight; `remote_exec` already opens SSH and returns structured diagnostics on connection failure.
4. When you need to run many independent commands on the same device, first think through which commands can safely run in one round, then prefer one `remote_exec_batch` call. Use `mode: "parallel"` for independent lightweight read-only probes, and `mode: "sequential"` when commands depend on each other or should not run concurrently.
5. Use `remote_test_connection` only when the user explicitly asks to test one device's SSH login, after adding/changing a device, or when diagnosing a failed `remote_exec`/`remote_exec_batch` connectivity issue.
6. If multiple devices match or confidence is low, ask the user to choose before modifying anything.
7. When the user uses a new nickname for a known device, persist it with `remote_learn_alias` after the target is clear.
8. Do not store passwords in remote device config. Passwords are only temporary bootstrap credentials.

## Available tools

- `remote_list_devices`: list configured devices, aliases, tags, users.
- `remote_resolve_device`: resolve natural language names such as “lab pc”, “server”, “desktop”, “build machine”, or local aliases configured by the user.
- `remote_exec`: run one non-interactive SSH command on a configured device. It has SSH keepalive, local watchdogs, remote heartbeat, prompt detection, and structured diagnostics for unstable links. Before calling it, estimate and pass a reasonable `timeout_seconds` for the command's expected runtime. Use this directly for ordinary single-command remote tasks; no separate connectivity preflight is needed.
- `remote_read`: read the contents of a remote file. Supports text files (with offset/limit for large files) and images (jpg, png, gif, webp, bmp as attachments). Use this instead of `remote_exec cat` when the goal is to read a file. Text output is truncated to 2000 lines or 50KB and includes continuation hints.
- `remote_exec_batch`: run multiple non-interactive commands through one SSH call and return per-command structured results (`id`, `exitCode`, `durationMs`, stdout/stderr, byte counts, omitted byte counts, truncation flag). Use it instead of repeated `remote_exec` calls for bulk system inventory, health checks, and diagnostics on one device. Supports `mode: "parallel" | "sequential"`, per-command/global `max_output_bytes`, and `total_max_output_bytes`; tool-level hard caps still apply.
- `remote_probe_devices`: run the Rust `remote-probe` helper concurrently after de-duplicating config entries by `host:port`. For multiple entries on the same machine, only one management route is probed and shown: prefer `sshRoute.type = "ssh-config"`, then prefer `root`, then the first remaining entry. Output is an aligned manageability table with `ROUTE`, `CHECK`, and `ENDPOINT`: direct devices are checked via ping/TCP/SSH internally, while devices with `sshRoute.type = "ssh-config"` are judged by SSH through the configured OpenSSH alias.
- `remote_test_connection`: verify SSH key login and return basic system info. Use only for explicit connectivity tests, post-add/post-change validation, or diagnosing a previous remote failure.
- `remote_add_device`: add or update a device in the local config.
- `remote_learn_alias`: save a user's new nickname for a known device as a persistent alias.
- `remote_install_keys`: install local/trusted public SSH keys into remote users' `authorized_keys`.

## Device resolution workflow

When the user says:

> check disk usage on the lab pc

Do:

1. `remote_resolve_device({"query":"lab pc"})`
2. If confidence is acceptable and target is unique:
   `remote_exec({"device":"lab-machine","command":"df -h && free -h && uptime","timeout_seconds":30})`

If the request needs several independent probes, combine them in one batch:

```json
{
  "device": "lab-machine",
  "mode": "parallel",
  "commands": [
    { "id": "disk", "command": "df -hT" },
    { "id": "memory", "command": "free -h" },
    { "id": "uptime", "command": "uptime" }
  ],
  "timeout_seconds": 30
}
```

Do **not** insert `remote_test_connection` between these steps for ordinary operations.

When `remote_resolve_device` or another remote tool receives a confident fuzzy match, the extension automatically saves the user's phrase as an alias. Example: if “build box” clearly resolves to `build-server`, it will be added to that device's `aliases`.

When the user says:

> 服务器上执行 xxx

If “服务器” maps to one clear device, proceed. If it maps to multiple devices, ask the user to choose.

If the user clarifies an ambiguous nickname, persist it:

1. Ask the user which device they meant.
2. `remote_learn_alias({"device":"<chosen-id>","alias":"<original nickname>"})`
3. Continue with the requested remote operation.

## Adding a new device

When the user provides a new host/IP and asks to remember it:

1. Collect missing essentials if needed:
   - stable id, e.g. `lab-machine`, `build-server`, `vps-prod`
   - host/IP
   - default SSH user
   - SSH port if not 22
   - aliases/tags if useful
2. Call `remote_add_device`.
3. Call `remote_test_connection` to validate the newly added/changed device.
4. If key login is not ready, use a temporary bootstrap method outside persistent config, then call `remote_install_keys`.

Never put raw passwords into `devices.json`.

## SSH key installation workflow

When the user asks to add “local key”, “trusted local keys”, “本机 key”, “本机信任的 key”, or similar:

- Use `remote_install_keys`.
- `keySources`:
  - `local-default`: local default public key `~/.ssh/id_ed25519.pub`.
  - `local-authorized-keys`: keys trusted by this local machine in `~/.ssh/authorized_keys`.
- If the target includes `root`, connect as `root` when available.
- The tool de-duplicates keys by key type + key blob.

Example:

```json
{
  "device": "lab-machine",
  "targetUsers": ["root", "deploy"],
  "keySources": ["local-default", "local-authorized-keys"]
}
```

## Timeout and output budgeting for remote_exec / remote_exec_batch

`remote_exec.timeout_seconds` and `remote_exec_batch.timeout_seconds` are total command budgets and should usually be set explicitly by the assistant before the tool call. For `remote_exec_batch`, budget for the whole batch: parallel batches need enough time for the slowest command plus SSH overhead; sequential batches need enough time for the cumulative expected runtime. Do not rely on the 60s fallback except for ordinary short commands. Low-level SSH/connect/idle watchdogs remain fixed safety rails; only adjust the total command budget.

Use these defaults as starting points:

- Quick probes (`whoami`, `hostname`, `uptime`, `pwd`, `ls`, `df -h`, `free -h`): 10-30s.
- Status and small log reads (`systemctl status`, `journalctl -n`, config inspection, `docker ps`): 30-90s.
- Package/service diagnostics, moderate searches, small file operations: 60-180s.
- Network downloads, package installation/update, container pulls: 300-900s depending on size/network.
- Builds, full test suites, image builds, large scans: 600-1800s or more when the user explicitly expects a long run.
- Device/board operations on unstable links: prefer a conservative but sufficient budget, e.g. 120-300s for probes and much longer for flashing/builds.

Rules:

1. Estimate from command semantics and pass `timeout_seconds` in the same `remote_exec` or `remote_exec_batch` call.
2. For many lightweight independent read-only commands, plan the batch first and use `remote_exec_batch` with `mode: "parallel"` instead of issuing many separate tool calls.
3. For logs or commands with potentially large output, set `max_output_bytes` / `total_max_output_bytes` based on the expected answer, and also reduce output at source with `head`, `tail`, `grep`, `jq`, or `journalctl -n`.
4. Do not set a huge timeout or huge output budget just to hide uncertainty. If unsure, choose a conservative budget and explain/retry with a larger budget if the tool returns `total-timeout` or truncated output.
5. If the task is expected to be long and disconnect-tolerant, prefer or propose a future job-runner/background mode once available; for now, choose an explicit long total timeout.
6. Treat `idle-timeout` differently from `total-timeout`: idle timeout suggests lost heartbeat/output or a stuck connection; total timeout suggests the command exceeded the chosen budget.

## Safety rules

Remote operations can affect real machines.

- Simple read-only commands are fine: `whoami`, `hostname`, `uptime`, `df -h`, `free -h`, `systemctl status`, log reads.
- For package installs, service config changes, firewall changes, SSH daemon changes, database mutations, or destructive actions, ensure the user's request clearly authorizes the action.
- `remote_exec` and `remote_exec_batch` block common destructive commands unless `allowDangerous=true`; only set it after explicit user authorization for that exact action.
- Prefer `sudo: true` only when necessary. It uses `sudo -n`, so it fails rather than prompting for a password.
- Avoid `mode: "parallel"` for package managers, service changes, writes to shared files, destructive operations, or commands competing for the same lock/resource.
- If a remote tool fails with `errorKind` such as `connect-timeout`, `idle-timeout`, `remote-disconnected`, `sudo-password-required`, or `interactive-prompt-detected`, use that diagnostic to explain the failure and choose a targeted next step instead of blindly retrying.

## Current known devices

The package does not bundle real devices. Use `remote_list_devices` for the authoritative current list from the user's runtime config.

## Real-time output observation

`remote_exec`, `remote_exec_batch` and `remote_read` automatically mirror output to a per-device tmux session `pi-remote-<device-id>` when tmux is available. Users can observe real-time command execution by running:

```bash
tmux attach -r -t pi-remote-<device-id>
```

- The `-r` flag makes the attach read-only — keyboard input is not forwarded to the pane.
- Each tool invocation is bracketed by separator lines with tool name, command summary and timestamp.
- If tmux is not installed or the session cannot be created, the feature silently degrades with no impact on tool behavior.
