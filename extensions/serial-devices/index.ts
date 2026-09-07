/**
 * serial-devices extension — tmux shared terminal core for serial port interaction.
 *
 * Architecture:
 *   tmux session ("pi-serial-<port>") holds a picocom long-lived connection.
 *   pi tools interact via `tmux send-keys` / `tmux capture-pane`.
 *   Users can `tmux attach -t pi-serial-<port>` to observe/interact in real time.
 *
 * Command completion detection uses a unique marker:
 *   ; echo __PI_SERIAL_DONE_<nonce>_$?__
 *   The tool polls capture-pane output until the marker appears, then extracts
 *   the exit code and trims output to the region between command echo and marker.
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_PREFIX = "pi-serial-";
const MARKER_PREFIX = "__PI_SERIAL_DONE_";
const DEFAULT_BAUD = 115200;
const DEFAULT_PORT = "/dev/ttyUSB0";
const POLL_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 600;
const PICOCOM_READY_TIMEOUT_MS = 5000;
const PICOCOM_READY_POLL_MS = 200;
const CAPTURE_SCROLLBACK_LINES = 2000;

/** Allowed device path pattern: /dev/ followed by alphanumeric, dash, underscore, dot, slash. */
const VALID_PORT_RE = /^\/dev\/[a-zA-Z0-9._\-/]+$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SerialSessionConfig = {
  port?: string;
  baud?: number;
};

/** Resolved config with defaults applied. */
type ResolvedConfig = {
  port: string;
  baud: number;
};

export type SerialExecResult = {
  stdout: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
};

// ---------------------------------------------------------------------------
// Config resolution and validation
// ---------------------------------------------------------------------------

function resolveConfig(config: SerialSessionConfig): ResolvedConfig {
  const port = config.port || DEFAULT_PORT;
  const baud = config.baud ?? DEFAULT_BAUD;
  if (!VALID_PORT_RE.test(port)) {
    throw new Error(`串口路径不合法: "${port}"。仅允许 /dev/ 下的标准设备路径。`);
  }
  if (!Number.isFinite(baud) || baud <= 0) {
    throw new Error(`波特率不合法: ${baud}`);
  }
  return { port, baud };
}

// ---------------------------------------------------------------------------
// Per-port mutex for serializing operations
// ---------------------------------------------------------------------------

const portLocks = new Map<string, Promise<void>>();

async function withPortLock<T>(port: string, fn: () => Promise<T>): Promise<T> {
  // Chain onto existing lock for this port
  const prev = portLocks.get(port) ?? Promise.resolve();
  let releaseLock: () => void;
  const next = new Promise<void>((resolve) => { releaseLock = resolve; });
  portLocks.set(port, next);
  try {
    await prev;
    return await fn();
  } finally {
    releaseLock!();
    // Clean up if we're the last in the chain
    if (portLocks.get(port) === next) portLocks.delete(port);
  }
}

// ---------------------------------------------------------------------------
// Helpers: run a local command and capture output
// ---------------------------------------------------------------------------

function runLocal(command: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      resolve({ stdout, stderr, exitCode: code });
    };
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", () => finish(1));
    if (timeoutMs && timeoutMs > 0) {
      setTimeout(() => {
        if (!finished) { child.kill("SIGKILL"); finish(124); }
      }, timeoutMs);
    }
  });
}

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// Session name helper
// ---------------------------------------------------------------------------

function sessionName(port: string): string {
  // /dev/ttyUSB0 -> pi-serial-ttyUSB0
  const slug = port.replace(/^\/dev\//, "");
  return `${SESSION_PREFIX}${slug}`;
}

// ---------------------------------------------------------------------------
// tmux session management
// ---------------------------------------------------------------------------

/** Check if a tmux session exists. */
export async function sessionExists(port: string): Promise<boolean> {
  const name = sessionName(port);
  const result = await runLocal("tmux", ["has-session", "-t", name], 5000);
  return result.exitCode === 0;
}

/** Create a new tmux session running picocom. Returns true on success. */
export async function createSession(config: SerialSessionConfig): Promise<boolean> {
  const resolved = resolveConfig(config);
  const name = sessionName(resolved.port);

  // Kill leftover session if any
  if (await sessionExists(resolved.port)) {
    await runLocal("tmux", ["kill-session", "-t", name], 5000);
  }

  // Use shell-quoted arguments to prevent injection
  const picocomCmd = `picocom ${shellQuote(resolved.port)} -b ${resolved.baud}`;
  const result = await runLocal("tmux", [
    "new-session", "-d", "-s", name,
    "-x", "200", "-y", "50",
    picocomCmd,
  ], 10000);

  if (result.exitCode !== 0) {
    throw new Error(`tmux session 创建失败 (${name}): ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }

  // Wait for picocom to become ready (check pane content for "Terminal ready" or prompt)
  const deadline = Date.now() + PICOCOM_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pane = await capturePane(resolved.port, 20);
    if (pane.includes("Terminal ready") || pane.includes("picocom")) {
      return true;
    }
    await sleep(PICOCOM_READY_POLL_MS);
  }
  // Even if we didn't see the marker, session was created — picocom may already be past "Terminal ready"
  return true;
}

/** Ensure a session exists, creating if needed. */
export async function ensureSession(config: SerialSessionConfig): Promise<void> {
  const resolved = resolveConfig(config);
  if (await sessionExists(resolved.port)) {
    // Verify picocom is still running inside the session
    const name = sessionName(resolved.port);
    const check = await runLocal("tmux", [
      "list-panes", "-t", name, "-F", "#{pane_current_command}",
    ], 5000);
    if (check.exitCode === 0 && check.stdout.includes("picocom")) {
      return; // Session healthy
    }
    // picocom died — recreate
    await runLocal("tmux", ["kill-session", "-t", name], 5000);
  }
  await createSession(resolved);
}

// ---------------------------------------------------------------------------
// tmux I/O primitives
// ---------------------------------------------------------------------------

/** Capture the current pane content (scrollback + visible). */
export async function capturePane(port: string, lines?: number): Promise<string> {
  const name = sessionName(port);
  const startLine = lines ? `-${lines}` : `-${CAPTURE_SCROLLBACK_LINES}`;
  const result = await runLocal("tmux", [
    "capture-pane", "-t", name, "-p", "-S", startLine,
  ], 5000);
  if (result.exitCode !== 0) {
    throw new Error(`capture-pane 失败 (${name}): ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

/** Send keys (text) to the tmux session. */
async function sendKeys(port: string, text: string): Promise<void> {
  const name = sessionName(port);
  const result = await runLocal("tmux", [
    "send-keys", "-t", name, text, "Enter",
  ], 5000);
  if (result.exitCode !== 0) {
    throw new Error(`send-keys 失败 (${name}): ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
}

/** Send Ctrl+C to the tmux session to interrupt current command. */
async function sendInterrupt(port: string): Promise<void> {
  const name = sessionName(port);
  await runLocal("tmux", ["send-keys", "-t", name, "C-c", ""], 5000);
}

// ---------------------------------------------------------------------------
// Marker-based command execution
// ---------------------------------------------------------------------------

function generateNonce(): string {
  return crypto.randomBytes(6).toString("hex");
}

function parseMarkerLine(line: string, nonce: string): { exitCode: number } | null {
  const prefix = `${MARKER_PREFIX}${nonce}_`;
  const idx = line.indexOf(prefix);
  if (idx < 0) return null;
  const after = line.slice(idx + prefix.length);
  const match = after.match(/^(\d+)__/);
  if (!match) return null;
  return { exitCode: parseInt(match[1], 10) };
}

/**
 * Execute a command on the serial device via tmux.
 *
 * Sends: <command> ; echo __PI_SERIAL_DONE_<nonce>_$?__
 * Polls capture-pane until the marker appears, then extracts output and exit code.
 *
 * Operations on the same port are serialized via a per-port mutex.
 */
export async function execCommand(config: SerialSessionConfig, command: string, timeoutSeconds?: number): Promise<SerialExecResult> {
  const resolved = resolveConfig(config);
  const timeout = Math.min(Math.max(1, timeoutSeconds ?? DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S);

  return withPortLock(resolved.port, async () => {
    const nonce = generateNonce();
    const marker = `${MARKER_PREFIX}${nonce}_`;
    const markerEcho = `echo ${marker}'$?'__`;

    await ensureSession(resolved);

    // Send command with marker
    const fullCommand = `${command} ; ${markerEcho}`;
    await sendKeys(resolved.port, fullCommand);

    // Poll for marker
    const startTime = Date.now();
    const deadlineMs = startTime + timeout * 1000;

    while (Date.now() < deadlineMs) {
      await sleep(POLL_INTERVAL_MS);

      const pane = await capturePane(resolved.port);
      const lines = pane.split("\n");

      // Search for marker line
      for (let i = 0; i < lines.length; i++) {
        const parsed = parseMarkerLine(lines[i], nonce);
        if (parsed) {
          const output = extractOutput(pane, marker, nonce);
          return {
            stdout: output.trim(),
            exitCode: parsed.exitCode,
            durationMs: Date.now() - startTime,
            timedOut: false,
          };
        }
      }
    }

    // Timeout — interrupt the running command with Ctrl+C to clean up
    await sendInterrupt(resolved.port);
    // Brief pause to let Ctrl+C take effect
    await sleep(500);

    const finalPane = await capturePane(resolved.port);
    const partialOutput = extractOutput(finalPane, marker, nonce);
    return {
      stdout: partialOutput.trim() || "[超时未检测到完成标记]",
      exitCode: -1,
      durationMs: Date.now() - startTime,
      timedOut: true,
    };
  });
}

/**
 * Extract command output from pane content.
 * Finds the parsed marker-result line as the end boundary,
 * and the command echo line (containing `echo <marker>`) as the start boundary.
 */
function extractOutput(pane: string, markerPrefix: string, nonce: string): string {
  const lines = pane.split("\n");
  let startIdx = -1;
  let endIdx = lines.length;

  // Find the parsed marker-result line as the end boundary (last occurrence).
  for (let i = lines.length - 1; i >= 0; i--) {
    if (parseMarkerLine(lines[i], nonce)) {
      endIdx = i;
      break;
    }
  }

  // Find start: the line right after the command echo (which contains `echo <marker>`)
  for (let i = 0; i < endIdx; i++) {
    if (lines[i].includes(`echo ${markerPrefix}`)) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx < 0) startIdx = 0;
  if (startIdx >= endIdx) return "";

  // Filter out any lines containing the marker prefix (command echo remnants)
  const output = lines
    .slice(startIdx, endIdx)
    .filter(line => !line.includes(markerPrefix))
    .join("\n");

  return output;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dangerous command guard (reused from remote-devices)
// ---------------------------------------------------------------------------

function dangerousReason(command: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/\brm\s+(-[^\n]*[rf]|-[^\n]*r|-[^\n]*f)[^\n]*(\/|~|\*)/i, "rm 递归/强制删除"],
    [/\b(dd|mkfs|parted|fdisk|wipefs)\b/i, "磁盘/分区破坏性操作"],
    [/\b(reboot|shutdown|poweroff|halt)\b/i, "重启或关机"],
    [/\bchmod\s+-R\b/i, "递归 chmod"],
    [/\bchown\s+-R\b/i, "递归 chown"],
    [/\biptables\b|\bufw\b|\bnft\b/i, "防火墙变更"],
    [/\/etc\/ssh\/sshd_config|\bsystemctl\s+restart\s+ssh/i, "SSH 配置变更"],
    [/\b(drop\s+database|drop\s+table|truncate\s+table)\b/i, "数据库删除/截断操作"],
  ];
  return patterns.find(([re]) => re.test(command))?.[1];
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatExecResult(result: SerialExecResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.timedOut) parts.push(`\n[超时 ${Math.round(result.durationMs / 1000)}s]`);
  parts.push(`\n[exit=${result.exitCode} duration=${result.durationMs}ms]`);
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

export default function serialDevicesExtension(pi: ExtensionAPI) {
  pi.on("system_prompt", (event => {
    event.systemPrompt = `${event.systemPrompt}\n\n[serial-devices]\nSerial device extension loaded. Use serial_exec to run commands on a serial-connected device (e.g. development board) via tmux shared terminal. Default port: /dev/ttyUSB0, default baud: 115200. The tmux session is named "pi-serial-<port>" and users can \`tmux attach -t pi-serial-<port>\` to observe and interact in real time. For destructive commands, only set allowDangerous=true after the user clearly authorized that exact action.`;
  }));

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify("✓ serial-devices 已加载", "info");
    }
  });

  pi.registerTool({
    name: "serial_exec",
    label: "Serial Devices: Exec",
    description: "通过串口在开发板上执行命令。基于 tmux + picocom 共享终端，用户可同时 attach 观看/交互。",
    promptSnippet: "通过串口在开发板上执行命令",
    promptGuidelines: [
      "Use serial_exec to run commands on a serial-connected device (development board, router, embedded system).",
      "Default port /dev/ttyUSB0, default baud 115200 8N1. Override with port/baud parameters if needed.",
      "The tmux session persists; users can attach with `tmux attach -t pi-serial-<port>` to see all operations in real time.",
      "For destructive commands (reboot, rm -rf, dd, mkfs, etc.), only set allowDangerous=true after the user clearly authorized that exact action.",
      "Estimate timeout_seconds from the command's expected runtime; default is 30s.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "要在串口设备上执行的 shell 命令" }),
      port: Type.Optional(Type.String({ description: "串口设备路径，默认 /dev/ttyUSB0" })),
      baud: Type.Optional(Type.Number({ description: "波特率，默认 115200" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "命令超时秒数，默认 30，最大 600" })),
      allowDangerous: Type.Optional(Type.Boolean({ description: "仅在用户明确授权破坏性操作时设为 true" })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx: ExtensionContext) {
      const command: string = params.command;
      const reason = dangerousReason(command);
      if (reason && !params.allowDangerous) {
        throw new Error(`serial_exec 拒绝执行疑似危险命令：${reason}。只有在用户明确授权后才可设置 allowDangerous=true。`);
      }

      const config: SerialSessionConfig = {
        port: params.port,
        baud: params.baud,
      };
      const result = await execCommand(config, command, params.timeout_seconds);
      const text = formatExecResult(result);

      return {
        content: [{ type: "text" as const, text }],
        details: {
          port: params.port || DEFAULT_PORT,
          baud: params.baud || DEFAULT_BAUD,
          command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          stdoutChars: result.stdout.length,
        },
        isError: result.exitCode !== 0 || result.timedOut,
      };
    },
  });
}
