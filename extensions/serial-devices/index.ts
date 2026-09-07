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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SerialSessionConfig = {
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
  const name = sessionName(config.port);

  // Kill leftover session if any
  if (await sessionExists(config.port)) {
    await runLocal("tmux", ["kill-session", "-t", name], 5000);
  }

  const picocomCmd = `picocom ${config.port} -b ${config.baud}`;
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
    const pane = await capturePane(config.port, 20);
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
  if (await sessionExists(config.port)) {
    // Verify picocom is still running inside the session
    const name = sessionName(config.port);
    const check = await runLocal("tmux", [
      "list-panes", "-t", name, "-F", "#{pane_current_command}",
    ], 5000);
    if (check.exitCode === 0 && check.stdout.includes("picocom")) {
      return; // Session healthy
    }
    // picocom died — recreate
    await runLocal("tmux", ["kill-session", "-t", name], 5000);
  }
  await createSession(config);
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

// ---------------------------------------------------------------------------
// Marker-based command execution
// ---------------------------------------------------------------------------

function generateNonce(): string {
  return crypto.randomBytes(6).toString("hex");
}

function buildMarkerPattern(nonce: string): string {
  return `${MARKER_PREFIX}${nonce}_`;
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
 */
export async function execCommand(config: SerialSessionConfig, command: string, timeoutSeconds?: number): Promise<SerialExecResult> {
  const timeout = Math.min(Math.max(1, timeoutSeconds ?? DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S);
  const nonce = generateNonce();
  const marker = `${MARKER_PREFIX}${nonce}_`;
  const markerEcho = `echo ${marker}'$?'__`;

  await ensureSession(config);

  // Capture baseline so we can isolate new output
  const baseline = await capturePane(config.port);
  const baselineLineCount = baseline.split("\n").length;

  // Send command with marker
  const fullCommand = `${command} ; ${markerEcho}`;
  await sendKeys(config.port, fullCommand);

  // Poll for marker
  const startTime = Date.now();
  const deadlineMs = startTime + timeout * 1000;

  while (Date.now() < deadlineMs) {
    await sleep(POLL_INTERVAL_MS);

    const pane = await capturePane(config.port);
    const lines = pane.split("\n");

    // Search for marker line
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseMarkerLine(lines[i], nonce);
      if (parsed) {
        // Extract output: everything between the command echo and the marker line
        const output = extractOutput(pane, fullCommand, marker, nonce);
        return {
          stdout: output.trim(),
          exitCode: parsed.exitCode,
          durationMs: Date.now() - startTime,
          timedOut: false,
        };
      }
    }
  }

  // Timeout
  const finalPane = await capturePane(config.port);
  const partialOutput = extractOutput(finalPane, fullCommand, marker, nonce);
  return {
    stdout: partialOutput.trim() || "[超时未检测到完成标记]",
    exitCode: -1,
    durationMs: Date.now() - startTime,
    timedOut: true,
  };
}

/**
 * Extract command output from pane content.
 * Finds the line containing the sent command, and collects lines until the marker.
 */
function extractOutput(pane: string, sentCommand: string, markerPrefix: string, nonce: string): string {
  const lines = pane.split("\n");
  let startIdx = -1;
  let endIdx = lines.length;

  // Find the line where our command was echoed (last occurrence to handle repeated commands)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(MARKER_PREFIX + nonce)) {
      // This is the marker line — set end
      endIdx = i;
    }
    // The command echo line contains both the user command and the marker echo
    if (lines[i].includes(markerPrefix) && startIdx === -1 && i < endIdx) {
      // This might be the echo of our full command; skip it
      continue;
    }
  }

  // Find start: the line right after the command echo
  for (let i = 0; i < endIdx; i++) {
    if (lines[i].includes(`echo ${markerPrefix}`)) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx < 0) startIdx = 0;
  if (startIdx >= endIdx) return "";

  // Filter out the marker echo line and marker result line
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

export default function serialDevicesExtension(pi: ExtensionAPI) {
  // Inject serial-devices context into system prompt
  pi.on("system_prompt", (event => {
    event.systemPrompt = `${event.systemPrompt}\n\n[serial-devices]\nSerial device extension loaded. Use serial_exec to run commands on a serial-connected device via tmux shared terminal. The tmux session is named "pi-serial-<port>" and users can attach with \`tmux attach -t pi-serial-<port>\` to observe and interact in real time.`;
  }));

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify("✓ serial-devices 已加载", "info");
    }
  });
}
