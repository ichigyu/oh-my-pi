import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { COMPACT_TOOLS_ENABLED, renderCompactToolResult } from "../compact-tool-renderer";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const USER_STATE_DIR = path.join(os.homedir(), ".pi", "agent", "remote-devices");
const LOCAL_DEFAULT_KEY = "~/.ssh/id_ed25519.pub";
const CONFIG_ENV = "PI_REMOTE_DEVICES_CONFIG";
const DEFAULT_CONFIG_PATH = path.join(USER_STATE_DIR, "devices.json");
const BUNDLED_CONFIG_PATH = path.join(baseDir, "devices.json");
const MAX_OUTPUT_CHARS = 60_000;
const MAX_CAPTURE_CHARS = 12 * 1024 * 1024;
const DEFAULT_REMOTE_WRITE_MAX_CONTENT_BYTES = 1024 * 1024;
const REMOTE_READ_MAX_LINES = 2000;
const REMOTE_READ_MAX_BYTES = 50 * 1024;
const REMOTE_READ_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
const remoteWriteMaxContentBytesEnv = Number(process.env.PI_REMOTE_WRITE_MAX_CONTENT_BYTES);
const REMOTE_WRITE_MAX_CONTENT_BYTES = Number.isFinite(remoteWriteMaxContentBytesEnv)
  ? Math.max(1024, remoteWriteMaxContentBytesEnv)
  : DEFAULT_REMOTE_WRITE_MAX_CONTENT_BYTES;
const BATCH_DEFAULT_MAX_OUTPUT_BYTES = Math.max(0, Number(process.env.PI_REMOTE_BATCH_DEFAULT_MAX_OUTPUT_BYTES || 4000));
const BATCH_DEFAULT_TOTAL_OUTPUT_BYTES = Math.max(0, Number(process.env.PI_REMOTE_BATCH_DEFAULT_TOTAL_OUTPUT_BYTES || 32_000));
const BATCH_HARD_MAX_OUTPUT_BYTES = Math.max(1024, Number(process.env.PI_REMOTE_BATCH_HARD_MAX_OUTPUT_BYTES || 64_000));
const BATCH_HARD_TOTAL_OUTPUT_BYTES = Math.max(BATCH_HARD_MAX_OUTPUT_BYTES, Number(process.env.PI_REMOTE_BATCH_HARD_TOTAL_OUTPUT_BYTES || 128_000));
const BATCH_MAX_COMMANDS = Math.max(1, Math.min(64, Number(process.env.PI_REMOTE_BATCH_MAX_COMMANDS || 16)));
const REMOTE_BATCH_RESULT_MARKER = "__PI_REMOTE_BATCH_RESULT__";
const REMOTE_LIVE_WIDGET_KEY = "remote-devices-live";
const REMOTE_LIVE_MAX_RENDER_LINES = Math.max(10, Number(process.env.PI_REMOTE_LIVE_MAX_LINES || 20));
const REMOTE_LIVE_MAX_HISTORY_LINES = 240;
const REMOTE_LIVE_MAX_SESSIONS = Number(process.env.PI_REMOTE_LIVE_MAX_SESSIONS || 10);
const REMOTE_LIVE_RENDER_THROTTLE_MS = Number(process.env.PI_REMOTE_LIVE_RENDER_THROTTLE_MS || 250);
const REMOTE_LIVE_DISMISS_AFTER_MS = Number(process.env.PI_REMOTE_LIVE_DISMISS_AFTER_MS || 30_000);
const REMOTE_LIVE_TOGGLE_SHORTCUT_LABEL = "Ctrl+Shift+R";
const AUTO_ALIAS_MIN_CONFIDENCE = Number(process.env.PI_REMOTE_AUTO_ALIAS_MIN_CONFIDENCE || 0.82);
const AUTO_ALIAS_AMBIGUITY_GAP = Number(process.env.PI_REMOTE_AUTO_ALIAS_AMBIGUITY_GAP || 0.08);
const DEFAULT_CONNECT_TIMEOUT_MS = Number(process.env.PI_REMOTE_CONNECT_TIMEOUT_MS || 10_000);
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = Number(process.env.PI_REMOTE_FIRST_BYTE_TIMEOUT_MS || 15_000);
const DEFAULT_IDLE_TIMEOUT_MS = Number(process.env.PI_REMOTE_IDLE_TIMEOUT_MS || 45_000);
const DEFAULT_KILL_GRACE_MS = Number(process.env.PI_REMOTE_KILL_GRACE_MS || 1500);
const DEFAULT_HEARTBEAT_INTERVAL_MS = Number(process.env.PI_REMOTE_HEARTBEAT_INTERVAL_MS || 10_000);
const REMOTE_STARTED_MARKER = "__PI_REMOTE_STARTED__";
const REMOTE_HEARTBEAT_MARKER = "__PI_REMOTE_HEARTBEAT__";
const RECENT_OUTPUT_PREVIEW_CHARS = 4000;
const REMOTE_PROBE_SOURCE = path.join(baseDir, "bin", "remote-probe.rs");
const REMOTE_PROBE_BIN = path.join(USER_STATE_DIR, "bin", `remote-probe-${process.platform}-${process.arch}`);


type AuthConfig = {
  type?: "ssh-key" | "ssh-agent" | "password-bootstrap";
  identityFile?: string;
};

type SshRouteConfig = {
  type?: "direct" | "ssh-config";
  target?: string;
  sshHost?: string;
  label?: string;
  user?: string;
  identityFile?: string;
};

type RemoteDevice = {
  id: string;
  name?: string;
  host: string;
  port?: number;
  defaultUser: string;
  users?: string[];
  aliases?: string[];
  tags?: string[];
  auth?: AuthConfig;
  sshRoute?: SshRouteConfig;
  sudo?: boolean;
  notes?: string;
};

type DevicesConfig = {
  version: number;
  updatedAt?: string;
  devices: RemoteDevice[];
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

type RemoteErrorKind =
  | "connect-timeout"
  | "auth-failed"
  | "host-unreachable"
  | "host-key-changed"
  | "first-byte-timeout"
  | "idle-timeout"
  | "total-timeout"
  | "remote-command-failed"
  | "remote-disconnected"
  | "sudo-password-required"
  | "interactive-prompt-detected"
  | "cancelled"
  | "spawn-error";

type RemoteExecutionPhase = "starting" | "connecting" | "remote-started" | "running" | "terminating" | "finished";

type RemoteTimeoutPolicy = {
  connectTimeoutMs: number;
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  killGraceMs: number;
  heartbeatIntervalMs: number;
};

type ExecOutcome = {
  device: RemoteDevice;
  user: string;
  command: string;
  remoteCommand: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  errorKind?: RemoteErrorKind;
  phase: RemoteExecutionPhase;
  timeoutPolicy: RemoteTimeoutPolicy;
  firstByteMs?: number;
  lastActivityMs?: number;
  lastHeartbeatMs?: number;
  lastOutputPreview?: string;
};

type RemoteExecBatchMode = "sequential" | "parallel";

type RemoteExecBatchCommand = {
  id: string;
  command: string;
  maxOutputBytes: number;
};

type RemoteExecBatchResult = {
  id: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutOmittedBytes: number;
  stderrOmittedBytes: number;
  truncated: boolean;
};

type RemoteOutputStream = "stdout" | "stderr";
type RemoteLiveLine = { stream: RemoteOutputStream | "system"; text: string; timestamp: number };
type RemoteLiveSession = {
  id: string;
  toolName: string;
  device: RemoteDevice;
  user: string;
  command: string;
  cwd?: string;
  sudo: boolean;
  startedAt: number;
  updatedAt: number;
  running: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  durationMs?: number;
  totalTimeoutMs?: number;
  finishedAt?: number;
  dismissAt?: number;
  lines: RemoteLiveLine[];
  partial: Record<RemoteOutputStream, string>;
};

type RemoteLiveTerminal = {
  append: (stream: RemoteOutputStream, text: string) => void;
  system: (text: string) => void;
  setTimeoutBudget: (startedAt: number, totalTimeoutMs: number) => void;
  finish: (exitCode: number | null, timedOut: boolean, durationMs: number, aborted?: boolean) => void;
};

type ProcessRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type ProbeRunParams = {
  timeout_ms?: number;
  ssh_timeout_ms?: number;
  concurrency?: number;
  color?: boolean;
};


type OhMyPiDetailPayload = {
  source: string;
  summary: string;
  info?: string;
  lines?: string[];
  expanded?: boolean;
  tone?: "normal" | "dim" | "warn" | "error";
};

const liveSessions = new Map<string, RemoteLiveSession>();
let emitOhMyPiDetail: ((payload: OhMyPiDetailPayload) => void) | undefined;
let liveRenderTimer: ReturnType<typeof setTimeout> | undefined;
let liveTickTimer: ReturnType<typeof setTimeout> | undefined;
let liveDismissTimer: ReturnType<typeof setTimeout> | undefined;
let liveSelectedSessionId: string | undefined;
let livePanelExpanded = false;

function expandHome(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[remote-devices] output truncated: ${text.length - max} chars omitted`;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function outputLimitFromParams(value: unknown): number {
  return clampInteger(value, BATCH_DEFAULT_MAX_OUTPUT_BYTES, 0, BATCH_HARD_MAX_OUTPUT_BYTES);
}

function totalOutputLimitFromParams(value: unknown): number {
  return clampInteger(value, BATCH_DEFAULT_TOTAL_OUTPUT_BYTES, 0, BATCH_HARD_TOTAL_OUTPUT_BYTES);
}

function normalizeBatchId(value: unknown, index: number): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : `cmd${index + 1}`;
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80) || `cmd${index + 1}`;
}

function stripBatchMarkerLines(text: string): string {
  if (!text) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(REMOTE_BATCH_RESULT_MARKER))
    .join("\n");
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8Bytes(value: string, maxBytes: number): { text: string; omittedBytes: number } {
  if (maxBytes <= 0) return { text: "", omittedBytes: utf8ByteLength(value) };
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, omittedBytes: 0 };
  return { text: bytes.subarray(0, maxBytes).toString("utf8"), omittedBytes: bytes.length - maxBytes };
}

function applyTotalBatchOutputLimit(results: RemoteExecBatchResult[], maxBytes: number): RemoteExecBatchResult[] {
  let remaining = Math.max(0, maxBytes);
  return results.map((item) => {
    let stdout = item.stdout;
    let stderr = item.stderr;
    let stdoutOmittedBytes = item.stdoutOmittedBytes;
    let stderrOmittedBytes = item.stderrOmittedBytes;

    const stdoutCut = truncateUtf8Bytes(stdout, remaining);
    stdout = stdoutCut.text;
    stdoutOmittedBytes += stdoutCut.omittedBytes;
    remaining = Math.max(0, remaining - utf8ByteLength(stdout));

    const stderrCut = truncateUtf8Bytes(stderr, remaining);
    stderr = stderrCut.text;
    stderrOmittedBytes += stderrCut.omittedBytes;
    remaining = Math.max(0, remaining - utf8ByteLength(stderr));

    return {
      ...item,
      stdout,
      stderr,
      stdoutOmittedBytes,
      stderrOmittedBytes,
      truncated: item.truncated || stdoutOmittedBytes > item.stdoutOmittedBytes || stderrOmittedBytes > item.stderrOmittedBytes,
    };
  });
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x1b]*(?:\x1b\\)/g, "");
}

// Any raw control character other than tab (e.g. embedded \n/\r from a
// multi-line remote command, heredoc script, or stray terminal control code
// in remote output) must never reach the TUI as a literal character: pi-tui's
// width/truncation helpers treat C0 controls as zero-width but do NOT strip
// them, so a single logical footer row could otherwise render as multiple
// physical terminal rows and silently break the fixed-height Remote Bash
// layout (visible as "content overflowing past N lines" and, because the
// resulting height no longer matches what the TUI core expects, as flicker of
// the conversation viewport border above the footer). Collapsing to a single
// space here is the one choke point every rendered line goes through, so it
// fixes the root cause regardless of which caller produced the offending text.
function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u0008\u000A-\u001F\u007F]/g, " ");
}

function truncatePlainToWidth(value: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  return truncateToWidth(stripControlChars(stripAnsi(value)), width, ellipsis);
}

// Render only the first non-empty line of a possibly multi-line string (e.g. a
// remote_exec command that is itself a multi-line script/heredoc), with a
// "+N lines" suffix when more was omitted. This keeps the Remote Bash summary
// row meaningful (vs. dumping a jumbled one-line soup of the whole script) on
// top of the structural stripControlChars() safety net above.
function firstLinePreview(value: string): string {
  const lines = value.split(/\r\n|\r|\n/);
  const first = lines.find((line) => line.trim().length > 0) ?? lines[0] ?? "";
  const extra = lines.length - 1;
  return extra > 0 ? `${first} …(+${extra} more line${extra === 1 ? "" : "s"})` : first;
}

function formatRemoteDuration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  if (safe < 1000) return `${safe}ms`;
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)}s`;
  if (safe < 5 * 60_000) return `${Math.floor(safe / 1000)}s`;
  if (safe < 60 * 60_000) {
    const totalSeconds = Math.floor(safe / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}min${seconds}s`;
  }
  const totalMinutes = Math.floor(safe / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes}min`;
}

function sessionElapsedMs(session: RemoteLiveSession): number {
  return session.running ? Date.now() - session.startedAt : (session.durationMs ?? Math.max(0, session.updatedAt - session.startedAt));
}

function sessionTimeoutRemainingMs(session: RemoteLiveSession, now = Date.now()): number | undefined {
  if (!session.totalTimeoutMs || session.totalTimeoutMs <= 0) return undefined;
  return Math.max(0, session.startedAt + session.totalTimeoutMs - now);
}

function sessionTimeoutBudgetText(session: RemoteLiveSession): string | undefined {
  if (!session.totalTimeoutMs || session.totalTimeoutMs <= 0) return undefined;
  return formatRemoteDuration(session.totalTimeoutMs);
}

function sessionTimeoutLine(session: RemoteLiveSession): string | undefined {
  const budget = sessionTimeoutBudgetText(session);
  if (!budget) return undefined;
  if (session.running) {
    const remaining = formatRemoteDuration(sessionTimeoutRemainingMs(session) ?? 0);
    return `⏳ timeout budget ${budget} · remaining ${remaining}`;
  }
  return `⏳ timeout budget ${budget} · elapsed ${formatRemoteDuration(sessionElapsedMs(session))}`;
}

function sessionStatusText(session: RemoteLiveSession): string {
  const duration = formatRemoteDuration(sessionElapsedMs(session));
  const remaining = session.running && session.totalTimeoutMs ? ` · left ${formatRemoteDuration(sessionTimeoutRemainingMs(session) ?? 0)}` : "";
  if (session.running) return `running ${duration}${remaining}`;
  if (session.aborted) return `aborted ${duration}`;
  if (session.timedOut) return `timeout ${duration}`;
  if (session.exitCode === 0) return `done ${duration}`;
  return `failed exit=${session.exitCode ?? "unknown"} ${duration}`;
}

function orderedLiveSessions(): RemoteLiveSession[] {
  return [...liveSessions.values()].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
}

function chooseDefaultLiveSession(sessions = orderedLiveSessions()): RemoteLiveSession | undefined {
  if (liveSelectedSessionId) {
    const selected = sessions.find((session) => session.id === liveSelectedSessionId);
    if (selected) return selected;
    liveSelectedSessionId = undefined;
  }
  return sessions[0];
}

function activeLiveSession(sessions: RemoteLiveSession[]): RemoteLiveSession | undefined {
  const selected = chooseDefaultLiveSession(sessions);
  if (selected) liveSelectedSessionId = selected.id;
  return selected;
}

function refreshFinishedDismiss(session: RemoteLiveSession | undefined, now = Date.now()): void {
  if (!session || session.running) return;
  session.dismissAt = now + Math.max(0, REMOTE_LIVE_DISMISS_AFTER_MS);
  session.updatedAt = now;
}

function setLiveFocus(ctx: ExtensionContext, nextId: string): void {
  const now = Date.now();
  const previous = liveSelectedSessionId ? liveSessions.get(liveSelectedSessionId) : undefined;
  if (previous?.id !== nextId) refreshFinishedDismiss(previous, now);
  const next = liveSessions.get(nextId);
  refreshFinishedDismiss(next, now);
  liveSelectedSessionId = nextId;
  scheduleDismissPrune(ctx);
}

function selectedLiveIndex(sessions: RemoteLiveSession[], selected: RemoteLiveSession): number {
  return Math.max(0, sessions.findIndex((session) => session.id === selected.id));
}

function remoteDetailTone(session?: RemoteLiveSession): "normal" | "dim" | "warn" | "error" {
  if (!session) return "dim";
  if (session.running) return "normal";
  if (session.aborted || session.timedOut) return "warn";
  if ((session.exitCode ?? 0) !== 0) return "error";
  return "dim";
}

function remoteDetailSummary(sessions: RemoteLiveSession[], session: RemoteLiveSession | undefined): string {
  if (!session) return "idle";
  const selectedIndex = selectedLiveIndex(sessions, session);
  const runningCount = sessions.filter((item) => item.running).length;
  const failedCount = sessions.filter((item) => !item.running && (item.timedOut || item.aborted || (item.exitCode ?? 0) !== 0)).length;
  const suffixParts = [
    runningCount > 1 ? `${runningCount} running` : undefined,
    failedCount > 0 ? `${failedCount} failed` : undefined,
  ].filter(Boolean);
  const suffix = suffixParts.length ? ` · ${suffixParts.join(" · ")}` : "";
  return `REMOTE ${session.device.id} #${selectedIndex + 1}/${sessions.length} · ${sessionStatusText(session)}${suffix}`;
}

function remoteDetailInfo(session: RemoteLiveSession | undefined): string {
  return session ? firstLinePreview(session.command) : "-";
}

function remoteDetailLines(session: RemoteLiveSession | undefined): string[] {
  if (!session) return [];
  const lines: string[] = [];
  const cwd = session.cwd ? ` · cwd=${session.cwd}` : "";
  const sudo = session.sudo ? "sudo " : "";
  const name = session.device.name && session.device.name !== session.device.id ? ` (${session.device.name})` : "";
  lines.push(`${session.device.id}${name} · ${session.user}@${session.device.host}:${session.device.port ?? 22}`);
  lines.push(`$ ${sudo}${firstLinePreview(session.command)}${cwd}`);
  const timeoutLine = sessionTimeoutLine(session);
  if (timeoutLine) lines.push(timeoutLine);

  const output = [...session.lines];
  for (const stream of ["stdout", "stderr"] as const) {
    if (session.partial[stream]) output.push({ stream, text: session.partial[stream], timestamp: Date.now() });
  }
  const tail = output.filter((line) => line.stream !== "system" || line.text.trim()).slice(-Math.max(1, REMOTE_LIVE_MAX_RENDER_LINES - 4));
  const outputLines = tail.length > 0 ? tail : [{ stream: "system" as const, text: "… connecting / no output yet", timestamp: Date.now() }];
  for (const line of outputLines) {
    const marker = line.stream === "stderr" ? "! " : line.stream === "system" ? "· " : "  ";
    lines.push(`${marker}${line.text}`);
  }
  return lines;
}

function publishRemoteDetail(ctx?: ExtensionContext): void {
  const sessions = orderedLiveSessions();
  const session = activeLiveSession(sessions);
  emitOhMyPiDetail?.({
    source: "remote",
    summary: remoteDetailSummary(sessions, session),
    info: remoteDetailInfo(session),
    lines: livePanelExpanded ? remoteDetailLines(session) : [],
    expanded: livePanelExpanded,
    tone: remoteDetailTone(session),
  });
  ctx?.ui.setWidget(REMOTE_LIVE_WIDGET_KEY, undefined, { placement: "belowEditor" });
}

function selectLiveSession(ctx: ExtensionContext, delta: number): void {
  const sessions = orderedLiveSessions();
  if (sessions.length === 0) {
    if (ctx.hasUI) ctx.ui.notify("Remote Bash 当前没有可切换的设备卡片。", "info");
    return;
  }
  const current = chooseDefaultLiveSession(sessions);
  const currentIndex = current ? selectedLiveIndex(sessions, current) : 0;
  const nextIndex = (currentIndex + delta + sessions.length) % sessions.length;
  const next = sessions[nextIndex];
  setLiveFocus(ctx, next.id);
  pruneDismissedLiveSessions(ctx);
  // Fixed-height layout: switching focus never changes total footer line
  // count, so a soft (diff) render is enough and avoids a full-screen clear.
  requestLiveRender(ctx, false);
  if (ctx.hasUI) ctx.ui.notify(`Remote Bash focus → ${nextIndex + 1}/${sessions.length} ${next.device.id}`, "info");
}

function focusLiveSession(ctx: ExtensionContext, target: string): boolean {
  const sessions = orderedLiveSessions();
  const trimmed = target.trim();
  const numeric = Number(trimmed);
  const byIndex = Number.isInteger(numeric) ? sessions[numeric - 1] : undefined;
  const matched = byIndex || sessions.find((session) => session.id === trimmed || session.device.id === trimmed || session.device.host === trimmed);
  if (!matched) return false;
  setLiveFocus(ctx, matched.id);
  pruneDismissedLiveSessions(ctx);
  requestLiveRender(ctx, false);
  if (ctx.hasUI) ctx.ui.notify(`Remote Bash focus → ${matched.device.id}`, "info");
  return true;
}

function installLiveRenderer(ctx: ExtensionContext, _force = false): void {
  if (ctx.mode !== "tui") return;
  publishRemoteDetail(ctx);
}

function pruneLiveSessions(ctx: ExtensionContext): void {
  if (liveSessions.size <= REMOTE_LIVE_MAX_SESSIONS) return;
  const removable = [...liveSessions.values()]
    .filter((session) => session.id !== liveSelectedSessionId)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  for (const session of removable) {
    if (liveSessions.size <= REMOTE_LIVE_MAX_SESSIONS) break;
    liveSessions.delete(session.id);
  }
  if (liveSessions.size > REMOTE_LIVE_MAX_SESSIONS && liveSelectedSessionId) {
    liveSessions.delete(liveSelectedSessionId);
    liveSelectedSessionId = undefined;
  }
  // This path only runs once the session count already exceeds the cap, so it
  // never empties the panel (at least REMOTE_LIVE_MAX_SESSIONS remain); total
  // footer height stays fixed, so a soft render is sufficient here too.
  requestLiveRender(ctx, false);
}

function scheduleDismissPrune(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  if (liveDismissTimer) {
    clearTimeout(liveDismissTimer);
    liveDismissTimer = undefined;
  }

  const now = Date.now();
  let nextAt: number | undefined;
  for (const session of liveSessions.values()) {
    if (session.running || session.id === liveSelectedSessionId || !session.dismissAt) continue;
    if (session.dismissAt <= now) {
      nextAt = now;
      break;
    }
    nextAt = Math.min(nextAt ?? session.dismissAt, session.dismissAt);
  }
  if (nextAt === undefined) return;

  liveDismissTimer = setTimeout(() => {
    liveDismissTimer = undefined;
    pruneDismissedLiveSessions(ctx);
  }, Math.max(80, nextAt - now));
  (liveDismissTimer as { unref?: () => void }).unref?.();
}

function pruneDismissedLiveSessions(ctx: ExtensionContext): void {
  const now = Date.now();
  let changed = false;
  for (const session of [...liveSessions.values()]) {
    if (session.running || session.id === liveSelectedSessionId || !session.dismissAt || session.dismissAt > now) continue;
    liveSessions.delete(session.id);
    changed = true;
  }
  if (liveSelectedSessionId && !liveSessions.has(liveSelectedSessionId)) liveSelectedSessionId = undefined;
  // Only force a full-screen clear when the panel actually disappears (all
  // sessions pruned); removing invisible finished cards while others remain
  // never changes total footer height, so a soft render avoids needless flicker.
  if (liveSessions.size === 0) requestLiveRender(ctx, true);
  else if (changed) requestLiveRender(ctx, false);
  scheduleDismissPrune(ctx);
}

function scheduleLiveTicker(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || liveTickTimer) return;
  const hasRunning = [...liveSessions.values()].some((session) => session.running);
  if (!hasRunning) return;
  const hasYoungRunning = [...liveSessions.values()].some((session) => session.running && Date.now() - session.startedAt < 10_000);
  liveTickTimer = setTimeout(() => {
    liveTickTimer = undefined;
    // Soft render: the fixed-height layout never changes total footer line
    // count on a routine tick, so a diff render is enough. Forcing a full
    // screen clear here every 500ms-1s was the main source of the
    // conversation-viewport top border flickering during running commands.
    requestLiveRender(ctx, false);
    scheduleLiveTicker(ctx);
  }, hasYoungRunning ? 500 : 1000);
  (liveTickTimer as { unref?: () => void }).unref?.();
}

function requestLiveRender(ctx: ExtensionContext, immediate = false): void {
  if (ctx.mode !== "tui") return;
  if (immediate) {
    if (liveRenderTimer) clearTimeout(liveRenderTimer);
    liveRenderTimer = undefined;
    installLiveRenderer(ctx, true);
    return;
  }
  if (liveRenderTimer) return;
  liveRenderTimer = setTimeout(() => {
    liveRenderTimer = undefined;
    installLiveRenderer(ctx, false);
  }, Math.max(80, REMOTE_LIVE_RENDER_THROTTLE_MS));
  (liveRenderTimer as { unref?: () => void }).unref?.();
}

function pushLiveLine(session: RemoteLiveSession, stream: RemoteOutputStream | "system", text: string): void {
  session.lines.push({ stream, text, timestamp: Date.now() });
  if (session.lines.length > REMOTE_LIVE_MAX_HISTORY_LINES) {
    session.lines.splice(0, session.lines.length - REMOTE_LIVE_MAX_HISTORY_LINES);
  }
  session.updatedAt = Date.now();
}

function appendLiveOutput(session: RemoteLiveSession, stream: RemoteOutputStream, text: string): void {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const combined = session.partial[stream] + normalized;
  const parts = combined.split("\n");
  session.partial[stream] = parts.pop() ?? "";
  for (const part of parts) pushLiveLine(session, stream, part);
  session.updatedAt = Date.now();
}

function startRemoteLiveTerminal(
  ctx: ExtensionContext,
  id: string,
  toolName: string,
  device: RemoteDevice,
  user: string,
  command: string,
  cwd: string | undefined,
  sudo: boolean,
  timeoutSeconds?: number,
): RemoteLiveTerminal | undefined {
  if (ctx.mode !== "tui") return undefined;
  const totalTimeoutMs = buildTimeoutPolicy(timeoutSeconds).totalTimeoutMs;
  const session: RemoteLiveSession = {
    id,
    toolName,
    device,
    user,
    command,
    cwd,
    sudo,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    running: true,
    totalTimeoutMs,
    lines: [],
    partial: { stdout: "", stderr: "" },
  };
  pushLiveLine(session, "system", `ssh ${user}@${device.host}:${device.port ?? 22}`);
  const wasEmpty = liveSessions.size === 0;
  const selectedBeforeInsert = liveSelectedSessionId ? liveSessions.get(liveSelectedSessionId) : undefined;
  // A new remote bash always grabs focus. The previous focused card (if any)
  // keeps its normal finished/dismiss lifecycle: if it already finished, give
  // it a fresh dismiss window now that it is no longer being watched; if it
  // is still running, it simply stays visible as a background tab.
  refreshFinishedDismiss(selectedBeforeInsert);
  liveSessions.set(id, session);
  liveSelectedSessionId = id;
  pruneDismissedLiveSessions(ctx);
  pruneLiveSessions(ctx);
  // Only force a full-screen clear on the 0 -> 1 session transition, i.e. when
  // the Remote Bash panel is newly appearing. Every other update keeps the
  // exact same total footer line count, so a soft render is enough and avoids
  // needless top-border flicker in the conversation pane above the footer.
  requestLiveRender(ctx, wasEmpty);
  scheduleLiveTicker(ctx);

  return {
    append(stream, text) {
      appendLiveOutput(session, stream, text);
      requestLiveRender(ctx);
    },
    system(text) {
      pushLiveLine(session, "system", text);
      requestLiveRender(ctx);
    },
    setTimeoutBudget(startedAt, totalTimeoutMs) {
      session.startedAt = startedAt;
      session.totalTimeoutMs = totalTimeoutMs;
      session.updatedAt = Date.now();
      // Content-only update; total footer height is unchanged, so soft render.
      requestLiveRender(ctx, false);
    },
    finish(exitCode, timedOut, durationMs, aborted = false) {
      for (const stream of ["stdout", "stderr"] as const) {
        if (session.partial[stream]) {
          pushLiveLine(session, stream, session.partial[stream]);
          session.partial[stream] = "";
        }
      }
      if (aborted) pushLiveLine(session, "system", "operation aborted by user");
      else if (timedOut) pushLiveLine(session, "system", "operation timed out");
      session.running = false;
      session.exitCode = exitCode;
      session.timedOut = timedOut;
      session.aborted = aborted;
      session.durationMs = durationMs;
      session.finishedAt = Date.now();
      session.dismissAt = session.finishedAt + Math.max(0, REMOTE_LIVE_DISMISS_AFTER_MS);
      session.updatedAt = session.finishedAt;
      // Finishing never removes the card immediately (dismiss is scheduled
      // separately), so total footer height is unchanged here too.
      requestLiveRender(ctx, false);
      scheduleDismissPrune(ctx);
    },
  };
}

function toggleRemoteLiveTerminal(ctx?: ExtensionContext): void {
  if (liveSessions.size === 0) {
    if (ctx?.hasUI) ctx.ui.notify("Remote Bash 当前没有可展开的 bash 记录。", "info");
    return;
  }
  livePanelExpanded = !livePanelExpanded;
  if (ctx?.mode === "tui") requestLiveRender(ctx, true);
  if (ctx?.hasUI) ctx.ui.notify(livePanelExpanded ? "Remote Bash 已展开。" : "Remote Bash 已折叠。", "info");
}

function closeRemoteLiveTerminal(ctx?: ExtensionContext, notify = true): void {
  if (liveRenderTimer) clearTimeout(liveRenderTimer);
  if (liveTickTimer) clearTimeout(liveTickTimer);
  if (liveDismissTimer) clearTimeout(liveDismissTimer);
  liveRenderTimer = undefined;
  liveTickTimer = undefined;
  liveDismissTimer = undefined;
  liveSessions.clear();
  liveSelectedSessionId = undefined;
  livePanelExpanded = false;
  if (ctx?.mode === "tui") publishRemoteDetail(ctx);
  else publishRemoteDetail();
  if (notify && ctx?.hasUI) ctx.ui.notify("Remote Bash 已清空，bash 记录已全部删除。", "info");
}

function clearRemoteLiveTerminal(ctx?: ExtensionContext): void {
  closeRemoteLiveTerminal(ctx, false);
}

function runLocalProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000).unref?.();
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_CHARS) stdout = stdout.slice(-MAX_OUTPUT_CHARS);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_OUTPUT_CHARS) stderr = stderr.slice(-MAX_OUTPUT_CHARS);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// tmux session management for remote device output tee
// ---------------------------------------------------------------------------

const REMOTE_TMUX_PREFIX = "pi-remote-";
const REMOTE_TMUX_SCROLLBACK = 10_000;

/** Build the tmux session name for a remote device. */
function remoteSessionName(deviceId: string): string {
  return `${REMOTE_TMUX_PREFIX}${deviceId}`;
}

/** Check if a tmux session for the given device exists. Returns false if tmux is unavailable. */
async function remoteSessionExists(deviceId: string): Promise<boolean> {
  const name = remoteSessionName(deviceId);
  try {
    const result = await runLocalProcess("tmux", ["has-session", "-t", name], 5000);
    return result.exitCode === 0;
  } catch {
    // tmux binary not found or spawn error
    return false;
  }
}

/**
 * Ensure a persistent tmux session exists for the given device.
 * Returns the session name on success, or null if tmux is unavailable or creation failed.
 * The session runs a simple idle shell (`cat`) as an output-only receiver.
 */
async function ensureRemoteTmuxSession(deviceId: string): Promise<string | null> {
  const name = remoteSessionName(deviceId);

  // Check if tmux is available
  try {
    const whichResult = await runLocalProcess("which", ["tmux"], 5000);
    if (whichResult.exitCode !== 0) return null;
  } catch {
    return null;
  }

  // Check if session already exists and is healthy
  try {
    const hasResult = await runLocalProcess("tmux", ["has-session", "-t", name], 5000);
    if (hasResult.exitCode === 0) {
      // Ensure scrollback is applied even for pre-existing sessions
      await runLocalProcess("tmux", [
        "set-option", "-t", name, "history-limit", String(REMOTE_TMUX_SCROLLBACK),
      ], 5000);
      return name;
    }
  } catch {
    return null;
  }

  // Create new session with large scrollback
  try {
    const createResult = await runLocalProcess("tmux", [
      "new-session", "-d", "-s", name,
      "-x", "200", "-y", "50",
      "stty -echo; cat",  // idle process — output-only receiver, no tty echo
    ], 10_000);
    if (createResult.exitCode !== 0) {
      // Concurrent call may have created the session — re-check
      const existingResult = await runLocalProcess("tmux", ["has-session", "-t", name], 5000);
      if (existingResult.exitCode === 0) return name;
      return null;
    }

    // Set scrollback buffer — check result
    const setOptionResult = await runLocalProcess("tmux", [
      "set-option", "-t", name, "history-limit", String(REMOTE_TMUX_SCROLLBACK),
    ], 5000);
    if (setOptionResult.exitCode !== 0) return null;

    return name;
  } catch {
    return null;
  }
}

let tmuxTeeCounter = 0;

/**
 * Write text to a remote-device tmux session pane.
 * Uses `tmux load-buffer` + `tmux paste-buffer` for reliable handling of
 * special characters. Falls back silently on any error.
 */
async function teeToRemoteTmux(sessionName: string, text: string): Promise<void> {
  if (!text) return;
  const teeId = `${process.pid}-${++tmuxTeeCounter}`;
  const tmpFile = path.join(os.tmpdir(), `pi-remote-tee-${teeId}`);
  const bufferName = `pi-tee-${teeId}`;
  try {
    fs.writeFileSync(tmpFile, text, "utf8");
    const loadResult = await runLocalProcess("tmux", ["load-buffer", "-b", bufferName, tmpFile], 3000);
    if (loadResult.exitCode === 0) {
      await runLocalProcess("tmux", ["paste-buffer", "-b", bufferName, "-t", sessionName, "-d"], 3000);
    }
  } catch {
    // Silent degradation — tmux tee is best-effort
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}

/** Write a command start separator to the tmux session. */
async function tmuxWriteSeparator(sessionName: string, toolName: string, commandSummary: string): Promise<void> {
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const line = `\n═══ [${toolName}] ${commandSummary} · ${ts} ═══\n`;
  await teeToRemoteTmux(sessionName, line);
}

/** Write a command finish marker to the tmux session. */
async function tmuxWriteFinish(sessionName: string, exitCode: number | null | undefined, durationMs: number | undefined): Promise<void> {
  const code = exitCode ?? "?";
  const dur = durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : "?";
  const line = `\n─── exit=${code} · ${dur} ───\n`;
  await teeToRemoteTmux(sessionName, line);
}

/** Helper: create a tmux tee context for a remote operation. Returns null if tmux unavailable. */
async function createRemoteTmuxTee(deviceId: string, toolName: string, commandSummary: string): Promise<{
  sessionName: string;
  tee: (text: string) => void;
  finish: (exitCode: number | null | undefined, durationMs: number | undefined) => Promise<void>;
} | null> {
  const sessionName = await ensureRemoteTmuxSession(deviceId);
  if (!sessionName) return null;
  await tmuxWriteSeparator(sessionName, toolName, commandSummary);
  // Serialize all tmux writes to avoid race conditions
  let writeChain: Promise<void> = Promise.resolve();
  let pending = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const doFlush = () => {
    if (pending) {
      const text = pending;
      pending = "";
      writeChain = writeChain.then(() => teeToRemoteTmux(sessionName, text));
    }
    flushTimer = null;
  };
  return {
    sessionName,
    tee(text: string) {
      pending += text;
      if (!flushTimer) flushTimer = setTimeout(doFlush, 50);
    },
    async finish(exitCode, durationMs) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      // Flush remaining output, then write finish marker, all serialized
      const remaining = pending;
      pending = "";
      if (remaining) {
        writeChain = writeChain.then(() => teeToRemoteTmux(sessionName, remaining));
      }
      writeChain = writeChain.then(() => tmuxWriteFinish(sessionName, exitCode, durationMs));
      await writeChain;
    },
  };
}

async function ensureRemoteProbeBinary(): Promise<string> {
  if (!fs.existsSync(REMOTE_PROBE_SOURCE)) {
    throw new Error(`remote probe Rust 源码不存在：${REMOTE_PROBE_SOURCE}`);
  }
  const sourceStat = fs.statSync(REMOTE_PROBE_SOURCE);
  const binaryFresh = fs.existsSync(REMOTE_PROBE_BIN) && fs.statSync(REMOTE_PROBE_BIN).mtimeMs >= sourceStat.mtimeMs;
  if (binaryFresh) return REMOTE_PROBE_BIN;
  fs.mkdirSync(path.dirname(REMOTE_PROBE_BIN), { recursive: true });
  const rustcCandidates = ["rustc", path.join(os.homedir(), ".cargo", "bin", "rustc")];
  let compiled: ProcessRunResult | undefined;
  let lastSpawnError: any;
  for (const rustc of rustcCandidates) {
    if (rustc !== "rustc" && !fs.existsSync(rustc)) continue;
    try {
      compiled = await runLocalProcess(rustc, ["--edition=2021", "-O", REMOTE_PROBE_SOURCE, "-o", REMOTE_PROBE_BIN], 120_000);
      break;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        lastSpawnError = error;
        continue;
      }
      throw error;
    }
  }
  if (!compiled) {
    if (fs.existsSync(REMOTE_PROBE_BIN)) return REMOTE_PROBE_BIN;
    throw new Error(`rustc not found and no prebuilt remote-probe binary is available.${lastSpawnError?.message ? ` ${lastSpawnError.message}` : ""}`);
  }
  if (compiled.exitCode !== 0 || compiled.timedOut) {
    if (fs.existsSync(REMOTE_PROBE_BIN)) return REMOTE_PROBE_BIN;
    throw new Error(`remote-probe compile failed${compiled.timedOut ? " (timeout)" : ""}: ${compiled.stderr || compiled.stdout || `exit=${compiled.exitCode}`}`);
  }
  return REMOTE_PROBE_BIN;
}

function buildRemoteProbeArgs(params: ProbeRunParams = {}): string[] {
  const args = ["--config", configPath()];
  if (params.timeout_ms) args.push("--timeout-ms", String(params.timeout_ms));
  if (params.ssh_timeout_ms) args.push("--ssh-timeout-ms", String(params.ssh_timeout_ms));
  if (params.concurrency) args.push("--concurrency", String(params.concurrency));
  if (params.color === false) args.push("--no-color");
  return args;
}

function normalizeProbeMessage(message: string): string {
  const text = stripAnsi(message).trim();
  const lower = text.toLowerCase();
  if (text === "ping 不通") return "ping failed";
  if (text === "ping 不可用") return "ping unavailable";
  if (text === "DNS解析失败") return "DNS resolution failed";
  if (text === "SSH认证失败") return "SSH auth failed";
  if (text === "host key异常") return "host key mismatch";
  if (text === "SSH连接超时") return "SSH connect timeout";
  if (text === "SSH端口拒绝") return "SSH port refused";
  if (text === "网络不可达") return "network unreachable";
  if (text === "SSH登录失败") return "SSH login failed";
  const portMatch = text.match(/^SSH端口(\d+)(超时|不通)$/);
  if (portMatch) return `SSH port ${portMatch[1]} ${portMatch[2] === "超时" ? "timeout" : "unreachable"}`;
  if (lower === "正常") return "ok";
  return text || "unknown failure";
}

type ParsedProbeLine = { ok: boolean; message: string };

type ProbeDevice = { device: RemoteDevice; port: number };

function probeUserRank(user: string): number {
  return user === "root" ? 0 : 1;
}

function probeDeviceRank(device: RemoteDevice): number {
  const routeBonus = device.sshRoute?.type === "ssh-config" ? -10 : 0;
  return routeBonus + probeUserRank(device.defaultUser);
}

function selectProbeDevices(config: DevicesConfig): ProbeDevice[] {
  const selected: ProbeDevice[] = [];
  for (const device of config.devices) {
    const port = device.port ?? 22;
    const existing = selected.find((item) => item.device.host === device.host && item.port === port);
    if (!existing) {
      selected.push({ device, port });
      continue;
    }
    if (probeDeviceRank(device) < probeDeviceRank(existing.device)) {
      existing.device = device;
      existing.port = port;
    }
  }
  return selected;
}

function isProbeSummaryLine(line: string): boolean {
  return /^(?:warning )?OK (?:all )?\d+\/\d+ devices · \d+ hosts$/.test(stripAnsi(line).trim());
}

function isProbeTableHeaderLine(line: string): boolean {
  const clean = stripAnsi(line).trim().replace(/\s+/g, " ");
  return /^S DEVICE .* ENDPOINT$/.test(clean);
}

function reorderFormattedProbeOutput(rawStdout: string): string {
  const headerLines: string[] = [];
  const okLines: string[] = [];
  const failedLines: string[] = [];
  const otherLines: string[] = [];
  const summaryLines: string[] = [];

  for (const rawLine of rawStdout.trim().split(/\r?\n/)) {
    const cleanLine = stripAnsi(rawLine).trim();
    if (!cleanLine) continue;
    if (isProbeSummaryLine(cleanLine)) summaryLines.push(rawLine);
    else if (isProbeTableHeaderLine(cleanLine)) headerLines.push(rawLine);
    else if (cleanLine.startsWith("✓ ")) okLines.push(rawLine);
    else if (cleanLine.startsWith("× ")) failedLines.push(rawLine);
    else otherLines.push(rawLine);
  }

  return [...headerLines, ...okLines, ...otherLines, ...failedLines, ...summaryLines].join("\n");
}

function formatProbeOutput(rawStdout: string, config: DevicesConfig): string {
  const cleanStdout = stripAnsi(rawStdout).trim();
  if (cleanStdout.split(/\r?\n/).some(isProbeSummaryLine)) return reorderFormattedProbeOutput(rawStdout);

  const parsed = new Map<string, ParsedProbeLine>();
  for (const rawLine of cleanStdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([✓×])\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    parsed.set(match[2], { ok: match[1] === "✓", message: normalizeProbeMessage(match[3]) });
  }
  if (parsed.size === 0) return cleanStdout;

  const selected = selectProbeDevices(config);
  selected.sort((a, b) => {
    const aOk = parsed.get(a.device.id)?.ok === true;
    const bOk = parsed.get(b.device.id)?.ok === true;
    if (aOk === bOk) return 0;
    return aOk ? -1 : 1;
  });

  const width = Math.max(2, ...selected.map(({ device }) => device.id.length));
  let okCount = 0;
  const lines = selected.map(({ device }) => {
    const result = parsed.get(device.id);
    if (result?.ok) okCount += 1;
    return `${result?.ok ? "✓" : "×"} ${device.id.padEnd(width)} ${result ? result.message : "probe missing result"}`;
  });
  const totalCount = selected.length;
  const summary = okCount === totalCount
    ? `OK all ${okCount}/${totalCount} devices · ${totalCount} hosts`
    : `OK ${okCount}/${totalCount} devices · ${totalCount} hosts`;
  return [...lines, summary].join("\n");
}

async function runRemoteProbe(params: ProbeRunParams = {}): Promise<ProcessRunResult> {
  const binary = await ensureRemoteProbeBinary();
  const config = readConfig();
  const probeDeviceCount = selectProbeDevices(config).length;
  const timeoutMs = Math.max(30_000, probeDeviceCount * Math.max(params.ssh_timeout_ms ?? 3500, params.timeout_ms ?? 1500));
  const result = await runLocalProcess(binary, buildRemoteProbeArgs(params), timeoutMs);
  return { ...result, stdout: formatProbeOutput(result.stdout, config) };
}

function parseProbeCliArgs(args: string[]): ProbeRunParams {
  const params: ProbeRunParams = { color: true };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const readNumber = () => {
      const value = Number(args[++i]);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    if (key === "--timeout-ms") params.timeout_ms = readNumber();
    else if (key === "--ssh-timeout-ms") params.ssh_timeout_ms = readNumber();
    else if (key === "--concurrency") params.concurrency = readNumber();
    else if (key === "--color") params.color = true;
    else if (key === "--no-color") params.color = false;
  }
  return params;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-]+/g, "");
}

function configPath(): string {
  return process.env[CONFIG_ENV] || DEFAULT_CONFIG_PATH;
}

function ensureConfigFile(): string {
  const target = configPath();
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (target !== BUNDLED_CONFIG_PATH && fs.existsSync(BUNDLED_CONFIG_PATH)) {
      fs.copyFileSync(BUNDLED_CONFIG_PATH, target);
    } else {
      writeConfig({ version: 1, updatedAt: new Date().toISOString(), devices: [] });
    }
  }
  return target;
}

function readConfig(): DevicesConfig {
  const file = ensureConfigFile();
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as DevicesConfig;
  if (!Array.isArray(parsed.devices)) parsed.devices = [];
  return parsed;
}

function writeConfig(config: DevicesConfig): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...config, version: config.version || 1, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function publicDevice(device: RemoteDevice) {
  return {
    id: device.id,
    name: device.name,
    host: device.host,
    port: device.port ?? 22,
    defaultUser: device.defaultUser,
    users: device.users ?? [device.defaultUser],
    aliases: device.aliases ?? [],
    tags: device.tags ?? [],
    auth: {
      type: device.auth?.type ?? "ssh-key",
      identityFile: device.auth?.identityFile,
    },
    sshRoute: device.sshRoute,
    sudo: Boolean(device.sudo),
    notes: device.notes,
  };
}

function scoreDevice(device: RemoteDevice, query: string): number {
  const q = normalize(query);
  if (!q) return 0;
  const id = normalize(device.id);
  const name = normalize(device.name ?? "");
  if (q === id) return 1;
  if (q === name) return 0.98;
  for (const alias of device.aliases ?? []) {
    const a = normalize(alias);
    if (q === a) return 0.96;
    if (a.includes(q) || q.includes(a)) return 0.82;
  }
  if (id.includes(q) || q.includes(id)) return 0.78;
  if (name.includes(q) || q.includes(name)) return 0.74;
  for (const tag of device.tags ?? []) {
    const t = normalize(tag);
    if (q === t) return 0.68;
    if (t.includes(q) || q.includes(t)) return 0.5;
  }
  if (normalize(device.host).includes(q)) return 0.65;
  return 0;
}

function resolveDevice(query: string): { device?: RemoteDevice; confidence: number; candidates: Array<{ device: RemoteDevice; score: number }> } {
  const config = readConfig();
  const candidates = config.devices
    .map((device) => ({ device, score: scoreDevice(device, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return { confidence: 0, candidates: [] };
  return { device: best.device, confidence: best.score, candidates };
}

function sanitizeAlias(alias: string): string | undefined {
  const value = alias.replace(/\s+/g, " ").trim();
  if (!value || value.length > 80 || /[\r\n]/.test(value)) return undefined;
  if (normalize(value).length < 2) return undefined;
  return value;
}

function isKnownDeviceName(device: RemoteDevice, alias: string): boolean {
  const q = normalize(alias);
  const known = [
    device.id,
    device.name ?? "",
    device.host,
    ...(device.aliases ?? []),
    ...(device.tags ?? []),
  ].filter(Boolean);
  return known.some((value) => normalize(value) === q);
}

function addAliasToDevice(deviceId: string, rawAlias: string): string | undefined {
  const alias = sanitizeAlias(rawAlias);
  if (!alias) return undefined;
  const config = readConfig();
  const index = config.devices.findIndex((d) => d.id === deviceId);
  if (index < 0) return undefined;
  const device = config.devices[index];
  if (isKnownDeviceName(device, alias)) return undefined;
  device.aliases = [...(device.aliases ?? []), alias];
  writeConfig(config);
  return alias;
}

function learnResolvedAlias(query: string, resolved: { device?: RemoteDevice; confidence: number; candidates: Array<{ device: RemoteDevice; score: number }> }): string | undefined {
  if (!resolved.device || resolved.confidence < AUTO_ALIAS_MIN_CONFIDENCE) return undefined;
  const runnerUp = resolved.candidates.find((candidate) => candidate.device.id !== resolved.device!.id);
  if (runnerUp && runnerUp.score >= resolved.confidence - AUTO_ALIAS_AMBIGUITY_GAP) return undefined;
  const learned = addAliasToDevice(resolved.device.id, query);
  if (learned) resolved.device.aliases = [...(resolved.device.aliases ?? []), learned];
  return learned;
}

function getDevice(idOrAlias: string): RemoteDevice {
  const config = readConfig();
  const exact = config.devices.find((d) => d.id === idOrAlias);
  if (exact) return exact;
  const resolved = resolveDevice(idOrAlias);
  if (!resolved.device || resolved.confidence < 0.5) {
    throw new Error(`未找到远程设备：${idOrAlias}`);
  }
  learnResolvedAlias(idOrAlias, resolved);
  return resolved.device;
}

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

function remoteWritePathReason(remotePath: string): string | undefined {
  const normalized = remotePath
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/\.\//g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  const sensitivePatterns: Array<[RegExp, string]> = [
    [/^\/etc(?:\/|$)/, "系统 /etc 配置路径"],
    [/^\/root(?:\/|$)/, "root home 路径"],
    [/(?:^|\/)\.ssh\/(?:authorized_keys|config|known_hosts)$/i, "SSH 配置或密钥信任路径"],
    [/^\/(?:etc|lib|usr\/lib)\/systemd\//i, "systemd 自启动配置"],
    [/(?:^|\/)\.config\/systemd\//i, "user systemd 自启动配置"],
    [/^\/var\/spool\/cron(?:\/|$)|^\/etc\/cron(?:\.|\/|$)/i, "cron 自启动配置"],
    [/^\/etc\/sudoers(?:\.d)?(?:\/|$)/i, "sudoers 配置"],
  ];
  const reason = sensitivePatterns.find(([re]) => re.test(normalized))?.[1];
  if (reason) return reason;
  if (/^(?:\.bashrc|\.zshrc|\.profile|\.bash_profile|\.zprofile|\.config\/fish\/config\.fish)$/i.test(normalized)) return "shell profile 自启动配置";
  if (/^(?:\.bashrc|\.zshrc|\.profile|\.bash_profile|\.zprofile|config\.fish)$/i.test(base)) return "shell profile 自启动配置";
  return undefined;
}

function validateRemoteWriteParams(params: any): { mode: "overwrite" | "append"; contentBytes: number } {
  if (!params.path || typeof params.path !== "string") throw new Error("remote_write path 必须是非空字符串");
  if (/[\u0000\r\n]/.test(params.path)) throw new Error("remote_write path 不能包含 NUL 或换行");
  if (typeof params.content !== "string") throw new Error("remote_write content 必须是字符串");
  const mode = params.mode === "append" ? "append" : params.mode === "overwrite" || params.mode === undefined ? "overwrite" : undefined;
  if (!mode) throw new Error("remote_write mode 必须是 overwrite 或 append");
  const contentBytes = Buffer.byteLength(params.content, "utf8");
  if (contentBytes > REMOTE_WRITE_MAX_CONTENT_BYTES) {
    throw new Error(`remote_write content 太大：${contentBytes} bytes，最大允许 ${REMOTE_WRITE_MAX_CONTENT_BYTES} bytes`);
  }
  return { mode, contentBytes };
}

function buildRemoteWriteScript(remotePath: string, mode: "overwrite" | "append"): string {
  const redirect = mode === "append" ? ">>" : ">";
  return `set -euo pipefail
TARGET_PATH=${shellQuote(remotePath)}
case "$TARGET_PATH" in
  "~") TARGET_PATH="$HOME" ;;
  "~/"*) TARGET_PATH="$HOME/${"$"}{TARGET_PATH#~/}" ;;
esac
TMP_FILE=$(mktemp)
cleanup_remote_write() { rm -f "$TMP_FILE"; }
trap cleanup_remote_write EXIT INT TERM
base64 -d > "$TMP_FILE"
TARGET_DIR=$(dirname -- "$TARGET_PATH")
install -d -- "$TARGET_DIR"
cat "$TMP_FILE" ${redirect} "$TARGET_PATH"
BYTES=$(wc -c < "$TMP_FILE" | tr -d ' ')
printf 'remote_write path=%s mode=%s bytes=%s\n' "$TARGET_PATH" ${shellQuote(mode)} "$BYTES"`;
}

function buildRemoteReadScript(remotePath: string, offset: number, limit: number, maxBytes: number): string {
  const MARKER = "__PI_REMOTE_READ_RESULT";
  // printf format: MARKER\ttype\ttotalLines\tcontentLines\tcontentBytes\tmimeType\tbase64Data\n
  const printResult = `printf '${MARKER}\t%s\t%s\t%s\t%s\t%s\t%s\n'`;
  const endLine = offset + limit - 1;
  return `
__PI_READ_TARGET=${shellQuote(remotePath)}
case "$__PI_READ_TARGET" in
  "~") __PI_READ_TARGET="$HOME" ;;
  "~/"*) __PI_READ_TARGET="$HOME/${'$'}{__PI_READ_TARGET#~/}" ;;
esac

if [ ! -e "$__PI_READ_TARGET" ]; then
  ${printResult} "error" "0" "0" "0" "" ""
  printf 'File not found: %s\n' "$__PI_READ_TARGET" >&2
  exit 1
fi
if [ ! -r "$__PI_READ_TARGET" ]; then
  ${printResult} "error" "0" "0" "0" "" ""
  printf 'Permission denied: %s\n' "$__PI_READ_TARGET" >&2
  exit 1
fi
if [ -d "$__PI_READ_TARGET" ]; then
  ${printResult} "error" "0" "0" "0" "" ""
  printf 'Is a directory: %s\n' "$__PI_READ_TARGET" >&2
  exit 1
fi

__PI_READ_EXT=$(printf '%s' "$__PI_READ_TARGET" | sed 's/.*\\.//' | tr '[:upper:]' '[:lower:]')
case "$__PI_READ_EXT" in
  jpg|jpeg|png|gif|webp|bmp)
    __PI_READ_MIME=""
    case "$__PI_READ_EXT" in
      jpg|jpeg) __PI_READ_MIME="image/jpeg" ;;
      png) __PI_READ_MIME="image/png" ;;
      gif) __PI_READ_MIME="image/gif" ;;
      webp) __PI_READ_MIME="image/webp" ;;
      bmp) __PI_READ_MIME="image/bmp" ;;
    esac
    __PI_READ_SIZE=$(wc -c < "$__PI_READ_TARGET" | tr -d ' ')
    if [ "$__PI_READ_SIZE" -gt 10485760 ]; then
      ${printResult} "error" "$__PI_READ_SIZE" "0" "0" "$__PI_READ_MIME" ""
      printf 'Image too large: %s bytes (max 10MB)\n' "$__PI_READ_SIZE" >&2
      exit 1
    fi
    __PI_READ_B64=$(base64 < "$__PI_READ_TARGET" | tr -d '\n')
    ${printResult} "image" "$__PI_READ_SIZE" "0" "0" "$__PI_READ_MIME" "$__PI_READ_B64"
    exit 0
    ;;
esac

__PI_READ_TOTAL_LINES=$(wc -l < "$__PI_READ_TARGET" | tr -d ' ')
__PI_READ_CONTENT=$(sed -n '${offset},${endLine}p' "$__PI_READ_TARGET" | head -c ${maxBytes})
__PI_READ_CONTENT_LINES=$(printf '%s' "$__PI_READ_CONTENT" | wc -l | tr -d ' ')
__PI_READ_CONTENT_BYTES=$(printf '%s' "$__PI_READ_CONTENT" | wc -c | tr -d ' ')
__PI_READ_B64=$(printf '%s' "$__PI_READ_CONTENT" | base64 | tr -d '\n')

${printResult} "text" "$__PI_READ_TOTAL_LINES" "$__PI_READ_CONTENT_LINES" "$__PI_READ_CONTENT_BYTES" "" "$__PI_READ_B64"
`;
}

function buildTimeoutPolicy(timeoutSeconds?: number): RemoteTimeoutPolicy {
  const totalTimeoutMs = Math.max(1000, Math.floor((timeoutSeconds ?? 60) * 1000));
  return {
    connectTimeoutMs: Math.max(1000, Math.min(DEFAULT_CONNECT_TIMEOUT_MS, totalTimeoutMs)),
    firstByteTimeoutMs: Math.max(1000, Math.min(DEFAULT_FIRST_BYTE_TIMEOUT_MS, totalTimeoutMs)),
    idleTimeoutMs: Math.max(1000, DEFAULT_IDLE_TIMEOUT_MS),
    totalTimeoutMs,
    killGraceMs: Math.max(250, DEFAULT_KILL_GRACE_MS),
    heartbeatIntervalMs: Math.max(1000, DEFAULT_HEARTBEAT_INTERVAL_MS),
  };
}

function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (typeof child.pid === "number") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* ignore */ }
  }
}

function detectInteractivePrompt(text: string): boolean {
  return /(?:^|\n)\s*(?:password|passphrase)\s*(?:for [^:]+)?\s*:\s*$/i.test(text)
    || /are you sure you want to continue connecting/i.test(text)
    || /\[(?:y\/n|yes\/no|Y\/n|y\/N)\]/.test(text)
    || /\benter\s+(?:password|passphrase)\b/i.test(text);
}

function classifyRemoteError(outcome: {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stderr: string;
  stdout: string;
  triggeredErrorKind?: RemoteErrorKind;
}): RemoteErrorKind | undefined {
  if (outcome.triggeredErrorKind) return outcome.triggeredErrorKind;
  const combined = `${outcome.stderr}\n${outcome.stdout}`;
  if (outcome.aborted) return "cancelled";
  if (/sudo: .*password.*required|sudo: a password is required|sudo: no tty present/i.test(combined)) return "sudo-password-required";
  if (detectInteractivePrompt(combined)) return "interactive-prompt-detected";
  if (/permission denied \(publickey|permission denied, please try again|authentication failed/i.test(combined)) return "auth-failed";
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(combined)) return "host-key-changed";
  if (/connection timed out|operation timed out|connect to host .* port .*: Connection timed out/i.test(combined)) return "connect-timeout";
  if (/no route to host|network is unreachable|could not resolve hostname|name or service not known|temporary failure in name resolution/i.test(combined)) return "host-unreachable";
  if (/broken pipe|connection reset by peer|connection closed|client_loop: send disconnect|connection to .* closed/i.test(combined)) return "remote-disconnected";
  if (outcome.timedOut) return "total-timeout";
  if (outcome.exitCode !== 0) return "remote-command-failed";
  return undefined;
}

function appendWithLimit(current: string, chunk: string, maxChars: number): { text: string; omitted: number } {
  const room = Math.max(0, maxChars - current.length);
  return { text: current + chunk.slice(0, room), omitted: Math.max(0, chunk.length - room) };
}

function rememberPreview(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= RECENT_OUTPUT_PREVIEW_CHARS ? next : next.slice(next.length - RECENT_OUTPUT_PREVIEW_CHARS);
}

async function runSsh(device: RemoteDevice, options: {
  user?: string;
  command: string;
  cwd?: string;
  sudo?: boolean;
  timeoutSeconds?: number;
  allowDangerous?: boolean;
  stdin?: string | Buffer;
  signal?: AbortSignal;
  onStart?: (timing: { startedAt: number; totalTimeoutMs: number; timeoutPolicy: RemoteTimeoutPolicy }) => void;
  onOutput?: (stream: RemoteOutputStream, text: string) => void;
  onSystem?: (text: string) => void;
}): Promise<ExecOutcome> {
  const reason = dangerousReason(options.command);
  if (reason && !options.allowDangerous) {
    throw new Error(`remote_exec 拒绝执行疑似危险命令：${reason}。只有在用户明确授权后才可设置 allowDangerous=true。`);
  }

  const user = options.user || device.sshRoute?.user || device.defaultUser;
  const port = String(device.port ?? 22);
  const route = device.sshRoute?.type === "ssh-config" ? device.sshRoute : undefined;
  const routeTarget = route?.target || route?.sshHost;
  const identityFile = expandHome(route?.identityFile || device.auth?.identityFile);
  const policy = buildTimeoutPolicy(options.timeoutSeconds);
  const heartbeatSeconds = Math.max(1, Math.ceil(policy.heartbeatIntervalMs / 1000));

  const commandBody = options.cwd
    ? `cd ${shellQuote(options.cwd)} || exit $?\n${options.command}`
    : options.command;
  const wrappedScript = `printf '%s %s\\n' ${shellQuote(REMOTE_STARTED_MARKER)} "$$" >&2
__pi_remote_hb_pid=
cleanup_pi_remote_hb() {
  if [ -n "${"$"}__pi_remote_hb_pid" ]; then kill "${"$"}__pi_remote_hb_pid" >/dev/null 2>&1 || true; wait "${"$"}__pi_remote_hb_pid" 2>/dev/null || true; fi
}
trap cleanup_pi_remote_hb EXIT INT TERM
(
  __pi_remote_sleep_pid=
  trap 'if [ -n "$__pi_remote_sleep_pid" ]; then kill "$__pi_remote_sleep_pid" >/dev/null 2>&1 || true; fi; exit 0' TERM INT EXIT
  while :; do
    sleep ${heartbeatSeconds} &
    __pi_remote_sleep_pid=$!
    wait "$__pi_remote_sleep_pid" || exit 0
    __pi_remote_sleep_pid=
    printf '%s %s\\n' ${shellQuote(REMOTE_HEARTBEAT_MARKER)} "$(date +%s)" >&2
  done
) &
__pi_remote_hb_pid=$!
${commandBody}
__pi_remote_exit=$?
exit "$__pi_remote_exit"`;

  const remoteCommand = options.sudo
    ? `sudo -n bash -lc ${shellQuote(wrappedScript)}`
    : `bash -lc ${shellQuote(wrappedScript)}`;

  const args = [
    "-o", "BatchMode=yes",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${Math.max(1, Math.ceil(policy.connectTimeoutMs / 1000))}`,
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
    "-o", "TCPKeepAlive=yes",
  ];
  if (identityFile) args.push("-i", identityFile);
  if (routeTarget) {
    args.push("-l", user, routeTarget, remoteCommand);
  } else {
    args.push("-p", port, `${user}@${device.host}`, remoteCommand);
  }

  const started = Date.now();
  options.onStart?.({ startedAt: started, totalTimeoutMs: policy.totalTimeoutMs, timeoutPolicy: policy });
  return await new Promise<ExecOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stderrControlPartial = "";
    let stdoutOmitted = 0;
    let stderrOmitted = 0;
    let timedOut = false;
    let settled = false;
    let phase: RemoteExecutionPhase = "connecting";
    let triggeredErrorKind: RemoteErrorKind | undefined;
    let firstByteAt: number | undefined;
    let lastActivityAt = started;
    let lastHeartbeatAt: number | undefined;
    let recentOutputPreview = "";
    let watchdogTimer: ReturnType<typeof setInterval> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    try {
      child.stdin.end(options.stdin ?? "");
    } catch {
      // Remote commands are non-interactive; stdin write failures are reported through ssh exit/stderr.
    }

    const noteActivity = (chunk?: string) => {
      const now = Date.now();
      if (!firstByteAt) firstByteAt = now;
      lastActivityAt = now;
      if (chunk) recentOutputPreview = rememberPreview(recentOutputPreview, stripAnsi(chunk));
    };

    const appendCaptured = (stream: RemoteOutputStream, chunk: string) => {
      if (!chunk) return;
      noteActivity(chunk);
      options.onOutput?.(stream, chunk);
      if (stream === "stdout") {
        const appended = appendWithLimit(stdout, chunk, MAX_CAPTURE_CHARS);
        stdout = appended.text;
        stdoutOmitted += appended.omitted;
      } else {
        const appended = appendWithLimit(stderr, chunk, MAX_CAPTURE_CHARS);
        stderr = appended.text;
        stderrOmitted += appended.omitted;
      }
      if (!triggeredErrorKind && detectInteractivePrompt(`${stderr}\n${stdout}`)) {
        terminate("interactive-prompt-detected", "interactive prompt detected; terminating non-interactive remote command");
      }
    };

    const appendRemoteStderr = (chunk: string) => {
      const combined = stderrControlPartial + chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const parts = combined.split("\n");
      stderrControlPartial = parts.pop() ?? "";
      if (!triggeredErrorKind && detectInteractivePrompt(`${stderr}\n${stdout}\n${stderrControlPartial}`)) {
        terminate("interactive-prompt-detected", "interactive prompt detected; terminating non-interactive remote command");
      }
      const visible: string[] = [];
      for (const line of parts) {
        if (line.startsWith(REMOTE_STARTED_MARKER)) {
          phase = "running";
          noteActivity(line);
          options.onSystem?.("remote shell started");
          continue;
        }
        if (line.startsWith(REMOTE_HEARTBEAT_MARKER)) {
          lastHeartbeatAt = Date.now();
          noteActivity(line);
          continue;
        }
        visible.push(line);
      }
      if (visible.length > 0) appendCaptured("stderr", `${visible.join("\n")}\n`);
    };

    const finalizeStderrPartial = () => {
      if (!stderrControlPartial) return;
      const line = stderrControlPartial;
      stderrControlPartial = "";
      if (line.startsWith(REMOTE_STARTED_MARKER)) {
        phase = "running";
        noteActivity(line);
        return;
      }
      if (line.startsWith(REMOTE_HEARTBEAT_MARKER)) {
        lastHeartbeatAt = Date.now();
        noteActivity(line);
        return;
      }
      appendCaptured("stderr", line);
    };

    const terminate = (kind: RemoteErrorKind, message: string) => {
      if (settled || phase === "terminating") return;
      triggeredErrorKind = kind;
      timedOut = kind.endsWith("timeout");
      phase = "terminating";
      options.onSystem?.(`watchdog: ${message}`);
      killProcessTree(child, "SIGTERM");
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), policy.killGraceMs);
      (killTimer as { unref?: () => void }).unref?.();
    };

    const onAbort = () => terminate("cancelled", "operation cancelled by caller");

    const finish = (exitCode: number | null, extraStderr?: string) => {
      if (settled) return;
      settled = true;
      const stoppedAtPhase = phase;
      phase = "finished";
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      finalizeStderrPartial();
      if (extraStderr) stderr += stderr ? `\n${extraStderr}` : extraStderr;
      if (stdoutOmitted > 0) stdout += `\n\n[remote-devices] stdout capture truncated: ${stdoutOmitted} chars omitted`;
      if (stderrOmitted > 0) stderr += `\n\n[remote-devices] stderr capture truncated: ${stderrOmitted} chars omitted`;
      const aborted = Boolean(options.signal?.aborted) && triggeredErrorKind === "cancelled";
      const errorKind = classifyRemoteError({ exitCode, timedOut, aborted, stderr, stdout, triggeredErrorKind });
      resolve({
        device,
        user,
        command: options.command,
        remoteCommand,
        stdout,
        stderr,
        exitCode,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        errorKind,
        phase: stoppedAtPhase,
        timeoutPolicy: policy,
        firstByteMs: firstByteAt ? firstByteAt - started : undefined,
        lastActivityMs: lastActivityAt - started,
        lastHeartbeatMs: lastHeartbeatAt ? lastHeartbeatAt - started : undefined,
        lastOutputPreview: compactOutputPreview(recentOutputPreview, 500),
      });
    };

    watchdogTimer = setInterval(() => {
      if (settled) return;
      const now = Date.now();
      const elapsed = now - started;
      if (options.signal?.aborted) {
        terminate("cancelled", "operation cancelled by caller");
      } else if (elapsed >= policy.totalTimeoutMs) {
        terminate("total-timeout", `total timeout after ${Math.ceil(policy.totalTimeoutMs / 1000)}s`);
      } else if (!firstByteAt && elapsed >= policy.firstByteTimeoutMs) {
        terminate("first-byte-timeout", `no output within ${Math.ceil(policy.firstByteTimeoutMs / 1000)}s`);
      } else if (firstByteAt && now - lastActivityAt >= policy.idleTimeoutMs) {
        terminate("idle-timeout", `no output or heartbeat for ${Math.ceil(policy.idleTimeoutMs / 1000)}s`);
      }
    }, 500);
    (watchdogTimer as { unref?: () => void }).unref?.();

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => appendCaptured("stdout", chunk));
    child.stderr.on("data", (chunk: string) => appendRemoteStderr(chunk));
    child.on("error", (error) => {
      triggeredErrorKind = "spawn-error";
      finish(null, String(error?.message ?? error));
    });
    child.on("close", (code) => {
      const extra = triggeredErrorKind === "cancelled"
        ? "aborted"
        : triggeredErrorKind && triggeredErrorKind !== "remote-command-failed"
          ? `remote execution stopped: ${triggeredErrorKind}`
          : undefined;
      finish(typeof code === "number" ? code : null, extra);
    });
  });
}

function buildRemoteBatchScript(commands: RemoteExecBatchCommand[], mode: RemoteExecBatchMode, continueOnError: boolean): string {
  const lines: string[] = [
    "__pi_batch_tmp=$(mktemp -d) || exit 125",
    "cleanup_pi_batch() { rm -rf \"$__pi_batch_tmp\"; }",
    "trap cleanup_pi_batch EXIT INT TERM",
    "__pi_batch_now_ms() {",
    "  __v=$(date +%s%3N 2>/dev/null || true)",
    "  case \"$__v\" in *N*|\"\") printf '%s000' \"$(date +%s)\" ;; *) printf '%s' \"$__v\" ;; esac",
    "}",
    "__pi_batch_b64() {",
    "  if base64 --help 2>&1 | grep -q -- '--wrap'; then base64 --wrap=0 \"$1\"; else base64 \"$1\" | tr -d '\\n'; fi",
    "}",
    "__pi_batch_run() {",
    "  __id=$1; __cmd_b64=$2; __limit=$3",
    "  __cmd_file=\"$__pi_batch_tmp/cmd_$__id.sh\"",
    "  __out_file=\"$__pi_batch_tmp/out_$__id.txt\"",
    "  __err_file=\"$__pi_batch_tmp/err_$__id.txt\"",
    "  printf '%s' \"$__cmd_b64\" | base64 -d > \"$__cmd_file\"",
    "  __start=$(__pi_batch_now_ms)",
    "  bash \"$__cmd_file\" >\"$__out_file\" 2>\"$__err_file\"",
    "  __exit=$?",
    "  __end=$(__pi_batch_now_ms)",
    "  __duration=$((__end - __start))",
    "  [ \"$__duration\" -ge 0 ] 2>/dev/null || __duration=0",
    "  __stdout_bytes=$(wc -c < \"$__out_file\" | tr -d ' ')",
    "  __stderr_bytes=$(wc -c < \"$__err_file\" | tr -d ' ')",
    "  __stdout_omitted=0; __stderr_omitted=0",
    "  if [ \"$__stdout_bytes\" -gt \"$__limit\" ]; then __stdout_omitted=$((__stdout_bytes - __limit)); fi",
    "  if [ \"$__stderr_bytes\" -gt \"$__limit\" ]; then __stderr_omitted=$((__stderr_bytes - __limit)); fi",
    "  __out_cut=\"$__pi_batch_tmp/out_cut_$__id.txt\"",
    "  __err_cut=\"$__pi_batch_tmp/err_cut_$__id.txt\"",
    "  head -c \"$__limit\" \"$__out_file\" > \"$__out_cut\"",
    "  head -c \"$__limit\" \"$__err_file\" > \"$__err_cut\"",
    "  __out_b64=$(__pi_batch_b64 \"$__out_cut\")",
    "  __err_b64=$(__pi_batch_b64 \"$__err_cut\")",
    "  __result_file=\"$__pi_batch_tmp/result_$__id.txt\"",
    `  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' ${shellQuote(REMOTE_BATCH_RESULT_MARKER)} \"$__id\" \"$__exit\" \"$__duration\" \"$__stdout_bytes\" \"$__stderr_bytes\" \"$__stdout_omitted\" \"$__stderr_omitted\" \"$__out_b64\" \"$__err_b64\" > \"$__result_file\"`,
    "  return \"$__exit\"",
    "}",
  ];

  if (mode === "parallel") {
    lines.push("__pi_batch_pids=\"\"");
    for (const item of commands) {
      const commandB64 = Buffer.from(item.command, "utf8").toString("base64");
      lines.push(`( __pi_batch_run ${shellQuote(item.id)} ${shellQuote(commandB64)} ${shellQuote(String(item.maxOutputBytes))} ) &`);
      lines.push("__pi_batch_pids=\"$__pi_batch_pids $!\"");
    }
    lines.push("for __pid in $__pi_batch_pids; do wait \"$__pid\" || true; done");
    for (const item of commands) {
      lines.push(`[ -f "$__pi_batch_tmp/result_${item.id}.txt" ] && cat "$__pi_batch_tmp/result_${item.id}.txt"`);
    }
  } else {
    for (const item of commands) {
      const commandB64 = Buffer.from(item.command, "utf8").toString("base64");
      lines.push(`__pi_batch_run ${shellQuote(item.id)} ${shellQuote(commandB64)} ${shellQuote(String(item.maxOutputBytes))}`);
      lines.push("__pi_batch_status=$?");
      lines.push(`[ -f "$__pi_batch_tmp/result_${item.id}.txt" ] && cat "$__pi_batch_tmp/result_${item.id}.txt"`);
      if (!continueOnError) lines.push("[ \"$__pi_batch_status\" -eq 0 ] || exit 0");
    }
  }
  lines.push("exit 0");
  return lines.join("\n");
}

function decodeBatchPayload(value: string): string {
  if (!value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function parseRemoteBatchResults(outcome: ExecOutcome, commands: RemoteExecBatchCommand[]): RemoteExecBatchResult[] {
  const byId = new Map<string, RemoteExecBatchResult>();
  for (const line of outcome.stdout.split(/\r?\n/)) {
    if (!line.startsWith(`${REMOTE_BATCH_RESULT_MARKER}\t`)) continue;
    const parts = line.split("\t");
    if (parts.length < 10) continue;
    const [, id, exitCode, durationMs, stdoutBytes, stderrBytes, stdoutOmittedBytes, stderrOmittedBytes, stdoutB64, stderrB64] = parts;
    const command = commands.find((item) => item.id === id)?.command ?? "";
    byId.set(id, {
      id,
      command,
      exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
      durationMs: Math.max(0, Number(durationMs) || 0),
      stdout: decodeBatchPayload(stdoutB64),
      stderr: decodeBatchPayload(stderrB64),
      stdoutBytes: Math.max(0, Number(stdoutBytes) || 0),
      stderrBytes: Math.max(0, Number(stderrBytes) || 0),
      stdoutOmittedBytes: Math.max(0, Number(stdoutOmittedBytes) || 0),
      stderrOmittedBytes: Math.max(0, Number(stderrOmittedBytes) || 0),
      truncated: (Number(stdoutOmittedBytes) || 0) > 0 || (Number(stderrOmittedBytes) || 0) > 0,
    });
  }
  return commands.map((item) => byId.get(item.id) ?? {
    id: item.id,
    command: item.command,
    exitCode: null,
    durationMs: 0,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutOmittedBytes: 0,
    stderrOmittedBytes: 0,
    truncated: false,
  });
}

type RemoteReadResult = {
  type: "text" | "image" | "error";
  totalLines: number;
  contentLines: number;
  contentBytes: number;
  mimeType: string;
  data: string; // base64 for image, decoded text for text
};

function parseRemoteReadResult(outcome: ExecOutcome): RemoteReadResult | undefined {
  const MARKER = "__PI_REMOTE_READ_RESULT";
  for (const line of outcome.stdout.split(/\r?\n/)) {
    if (!line.startsWith(`${MARKER}\t`)) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [, type, totalLines, contentLines, contentBytes, mimeType, b64] = parts;
    const decoded = type === "image" ? b64 : (() => {
      try { return Buffer.from(b64, "base64").toString("utf8"); } catch { return ""; }
    })();
    return {
      type: type as "text" | "image" | "error",
      totalLines: Math.max(0, Number(totalLines) || 0),
      contentLines: Math.max(0, Number(contentLines) || 0),
      contentBytes: Math.max(0, Number(contentBytes) || 0),
      mimeType: mimeType || "",
      data: decoded,
    };
  }
  return undefined;
}

function formatBatchToolText(outcome: ExecOutcome, mode: RemoteExecBatchMode, results: RemoteExecBatchResult[]): string {
  const failed = results.filter((item) => item.exitCode !== 0).length;
  const truncatedCount = results.filter((item) => item.truncated).length;
  const payload = {
    summary: {
      device: outcome.device.id,
      mode,
      exitCode: outcome.exitCode,
      errorKind: outcome.errorKind,
      durationMs: outcome.durationMs,
      commands: results.length,
      failed,
      truncated: truncatedCount,
    },
    results: results.map((item) => ({
      id: item.id,
      exitCode: item.exitCode,
      durationMs: item.durationMs,
      stdoutBytes: item.stdoutBytes,
      stderrBytes: item.stderrBytes,
      stdoutOmittedBytes: item.stdoutOmittedBytes,
      stderrOmittedBytes: item.stderrOmittedBytes,
      stdout: item.stdout,
      stderr: item.stderr,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

function outcomeDiagnostics(outcome: ExecOutcome): Record<string, unknown> {
  return {
    errorKind: outcome.errorKind,
    phase: outcome.phase,
    firstByteMs: outcome.firstByteMs,
    lastActivityMs: outcome.lastActivityMs,
    lastHeartbeatMs: outcome.lastHeartbeatMs,
    timeoutPolicy: outcome.timeoutPolicy,
    lastOutputPreview: outcome.lastOutputPreview,
  };
}

function formatExec(outcome: ExecOutcome): string {
  const flags = [outcome.errorKind ? `kind=${outcome.errorKind}` : "", outcome.timedOut ? "timeout" : "", outcome.aborted ? "aborted" : ""].filter(Boolean).join(" ");
  const header = [
    `device=${outcome.device.id} host=${outcome.device.host} user=${outcome.user} exit=${outcome.exitCode ?? "unknown"} duration=${outcome.durationMs}ms${flags ? ` ${flags}` : ""}`,
    `phase=${outcome.phase} firstByte=${outcome.firstByteMs ?? "n/a"}ms lastActivity=${outcome.lastActivityMs ?? "n/a"}ms lastHeartbeat=${outcome.lastHeartbeatMs ?? "n/a"}ms`,
    `command=${outcome.command}`,
  ].join("\n");
  const stdout = outcome.stdout ? `\n--- stdout ---\n${truncate(outcome.stdout)}` : "";
  const stderr = outcome.stderr ? `\n--- stderr ---\n${truncate(outcome.stderr)}` : "";
  const preview = outcome.lastOutputPreview && !stdout && !stderr ? `\n--- last output preview ---\n${outcome.lastOutputPreview}` : "";
  return `${header}${stdout}${stderr}${preview}`;
}

function compactOutputPreview(value: string, maxWidth = 80): string {
  return truncatePlainToWidth(value.replace(/\s+/g, " ").trim(), maxWidth, "…");
}

function formatExecContent(outcome: ExecOutcome): string {
  const flags = [outcome.errorKind ? `kind=${outcome.errorKind}` : "", outcome.timedOut ? "timeout" : "", outcome.aborted ? "aborted" : ""].filter(Boolean).join(" ");
  const header = `remote_exec ${outcome.device.id} exit=${outcome.exitCode ?? "unknown"} duration=${outcome.durationMs}ms${flags ? ` ${flags}` : ""}`;
  // Share a single MAX_OUTPUT_CHARS budget across stdout + stderr to prevent
  // combined content from exceeding the intended cap.
  let remaining = MAX_OUTPUT_CHARS;
  let stdoutSection = "";
  let stderrSection = "";
  if (outcome.stdout) {
    const truncated = truncate(outcome.stdout, remaining);
    stdoutSection = `\n--- stdout ---\n${truncated}`;
    remaining = Math.max(0, remaining - truncated.length);
  }
  if (outcome.stderr && remaining > 0) {
    stderrSection = `\n--- stderr ---\n${truncate(outcome.stderr, remaining)}`;
  } else if (outcome.stderr) {
    stderrSection = `\n--- stderr ---\n[remote-devices] stderr omitted: stdout already consumed output budget (${outcome.stderr.length} chars)`;
  }
  const preview = outcome.lastOutputPreview && !stdoutSection && !stderrSection ? `\n--- last output preview ---\n${outcome.lastOutputPreview}` : "";
  return `${header}${stdoutSection}${stderrSection}${preview}`;
}

function summarizeRemoteToolCall(toolName: string, args: any): string {
  if (toolName === "remote_list_devices") {
    const filters = [args?.query ? `query=${args.query}` : "", args?.tag ? `tag=${args.tag}` : ""].filter(Boolean).join(" ");
    return filters || "list configured devices";
  }
  if (toolName === "remote_resolve_device") return `resolve ${args?.query ?? "device"}`;
  if (toolName === "remote_exec") return `exec ${args?.device ?? "device"}`;
  if (toolName === "remote_read") {
    const range = args?.offset ? `:${args.offset}${args?.limit ? `+${args.limit}` : ""}` : "";
    return `read ${args?.device ?? "device"}:${args?.path ?? "path"}${range}`;
  }
  if (toolName === "remote_exec_batch") return `batch ${args?.device ?? "device"} ${Array.isArray(args?.commands) ? args.commands.length : 0} cmds ${args?.mode ?? "sequential"}`;
  if (toolName === "remote_write") return `write ${args?.device ?? "device"}:${args?.path ?? "path"} ${args?.mode ?? "overwrite"}`;
  if (toolName === "remote_test_connection") return `test ${args?.device ?? "device"}`;
  if (toolName === "remote_probe_devices") return "probe all devices";
  if (toolName === "remote_add_device") return `${args?.overwrite ? "update" : "add"} ${args?.id ?? "device"}`;
  if (toolName === "remote_learn_alias") return `${args?.device ?? "device"} alias=${args?.alias ?? "..."}`;
  if (toolName === "remote_install_keys") return `${args?.device ?? "device"} users=${Array.isArray(args?.targetUsers) ? args.targetUsers.join(",") : "..."}`;
  return "remote-devices";
}

function renderRemoteToolCall(toolName: string, args: any, theme: Theme): Text {
  const title = theme.fg("toolTitle", theme.bold(toolName));
  const summary = truncatePlainToWidth(summarizeRemoteToolCall(toolName, args), 120, "…");
  return new Text(`${title} ${theme.fg("muted", summary)}`, 0, 0);
}

function toolContentText(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n");
}

function renderRemoteToolResult(result: any, options: any, theme: Theme, context: any): Text {
  if (!COMPACT_TOOLS_ENABLED) return new Text("", 0, 0);
  return renderCompactToolResult("remote", result, options, theme, context);
}

function renderProbeToolResult(result: any, options: any, theme: Theme, context: any): Text {
  if (COMPACT_TOOLS_ENABLED) return renderCompactToolResult("remote_probe_devices", result, options, theme, context);
  if (options?.isPartial) return new Text(theme.fg("warning", "remote_probe_devices: running..."), 0, 0);
  const text = toolContentText(result) || "remote_probe_devices: No output";
  return new Text(theme.fg("muted", text), 0, 0);
}

function readLocalPublicKeys(sources: string[], explicitPublicKeys?: string[]): string[] {
  const lines: string[] = [];
  if (sources.includes("local-default")) {
    const p = expandHome(LOCAL_DEFAULT_KEY)!;
    if (fs.existsSync(p)) lines.push(...fs.readFileSync(p, "utf8").split(/\r?\n/));
  }
  if (sources.includes("local-authorized-keys")) {
    const p = path.join(os.homedir(), ".ssh", "authorized_keys");
    if (fs.existsSync(p)) lines.push(...fs.readFileSync(p, "utf8").split(/\r?\n/));
  }
  if (explicitPublicKeys?.length) lines.push(...explicitPublicKeys);

  const seen = new Set<string>();
  const keys: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2 || !parts[0].startsWith("ssh-")) continue;
    const sig = `${parts[0]} ${parts[1]}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    keys.push(line);
  }
  return keys;
}

function validateDeviceInput(device: RemoteDevice): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(device.id)) {
    throw new Error("设备 id 只能包含字母、数字、点、下划线、连字符，且长度 1-64");
  }
  if (!device.host) throw new Error("host 必填");
  if (!device.defaultUser) throw new Error("defaultUser 必填");
}

function deviceSummaryForPrompt(): string {
  const config = readConfig();
  if (config.devices.length === 0) return "Known remote devices: none.";
  const rows = config.devices.map((d) => {
    const aliases = (d.aliases ?? []).slice(0, 8).join("/") || "none";
    const tags = (d.tags ?? []).slice(0, 8).join("/") || "none";
    const route = d.sshRoute?.type === "ssh-config" ? `, sshRoute=${d.sshRoute.label ?? d.sshRoute.target ?? d.sshRoute.sshHost}` : "";
    return `- ${d.id}: ${d.name ?? d.id}, host=${d.host}, defaultUser=${d.defaultUser}${route}, aliases=${aliases}, tags=${tags}`;
  });
  return `Known remote devices for remote-devices tools:\n${rows.join("\n")}`;
}

export default function (pi: ExtensionAPI) {
  emitOhMyPiDetail = (payload) => pi.events.emit("oh-my-pi:detail", payload);

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n[remote-devices]\n${deviceSummaryForPrompt()}\nUse remote_resolve_device before operating on a named remote device unless the device id is explicit. Use remote_probe_devices when the user asks to quickly test all configured devices and wants concise health/latency results. For normal single remote commands, call remote_exec directly; do not preflight with remote_test_connection because remote_exec already performs SSH connection and structured diagnostics. When you need to run many independent read-only probes or status commands on one device, plan which commands can run together and prefer one remote_exec_batch call with mode=parallel; use mode=sequential when commands depend on previous results or must not run concurrently. Use remote_exec_batch output limits deliberately: request max_output_bytes/total_max_output_bytes large enough for the expected result, but rely on the tool hard caps and prefer concise commands for logs. Use remote_test_connection only when the user explicitly asks to test connectivity, after adding/changing a device, or when diagnosing a failed remote_exec/connectivity issue. Prefer dedicated remote tools over ad-hoc ssh bash commands. Use remote_read to read remote file contents instead of remote_exec cat; remote_read supports offset/limit for large files and returns images as attachments. Use remote_write for remote text file writes instead of building heredocs through remote_exec; remote_write treats content as data while still requiring allowDangerous for sensitive target paths. When calling remote_exec or remote_exec_batch, estimate timeout_seconds from the expected runtime: quick probes 10-30s, package/service/log diagnostics 60-180s, builds/tests/downloads 300-1800s, explicitly long jobs longer as requested. Keep low-level SSH/connect/idle watchdogs fixed; only adjust total command budget. When the user uses a new nickname for a known device, persist it with remote_learn_alias after the target is clear. Never store passwords in device config. Users can observe real-time remote command output by running \`tmux attach -r -t pi-remote-<device-id>\` in another terminal; remote_exec, remote_exec_batch and remote_read automatically mirror output to the corresponding tmux session when tmux is available.`,
  }));

  pi.on("session_start", async (_event, ctx) => {
    ensureConfigFile();
    installLiveRenderer(ctx, true);
    if (ctx.hasUI) ctx.ui.notify(`✓ remote-devices 就绪：${readConfig().devices.length} 台设备`, "info");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearRemoteLiveTerminal(ctx);
    emitOhMyPiDetail = undefined;
  });

  pi.registerShortcut("alt+.", {
    description: "remote-devices：切到下一个 Remote Bash 设备卡片",
    handler: (ctx) => selectLiveSession(ctx, 1),
  });

  pi.registerShortcut("alt+,", {
    description: "remote-devices：切到上一个 Remote Bash 设备卡片",
    handler: (ctx) => selectLiveSession(ctx, -1),
  });

  pi.registerShortcut("ctrl+shift+r", {
    description: "remote-devices：展开/折叠 Remote Bash 面板",
    handler: (ctx) => toggleRemoteLiveTerminal(ctx),
  });

  pi.registerCommand("remote-devices", {
    description: "List/test/probe remote devices managed by the remote-devices extension",
    handler: async (args, ctx) => {
      const parts = (args || "list").trim().split(/\s+/).filter(Boolean);
      const action = parts[0] || "list";
      const target = parts[1];
      if (action === "next") {
        selectLiveSession(ctx, 1);
        return;
      }
      if (action === "prev" || action === "previous") {
        selectLiveSession(ctx, -1);
        return;
      }
      if (action === "focus" && target) {
        if (!focusLiveSession(ctx, target)) ctx.ui.notify(`Remote Bash 没有匹配的卡片：${target}`, "warning");
        return;
      }
      if (action === "toggle") {
        toggleRemoteLiveTerminal(ctx);
        return;
      }
      if (action === "expand") {
        if (liveSessions.size === 0) ctx.ui.notify("Remote Bash 当前没有可展开的 bash 记录。", "info");
        else {
          livePanelExpanded = true;
          requestLiveRender(ctx, true);
        }
        return;
      }
      if (action === "collapse") {
        livePanelExpanded = false;
        requestLiveRender(ctx, true);
        return;
      }
      if (action === "clear" || action === "close") {
        closeRemoteLiveTerminal(ctx);
        return;
      }
      if (action === "list") {
        const config = readConfig();
        const text = config.devices
          .map((d) => `${d.id} (${d.name ?? d.id}) -> ${d.defaultUser}@${d.host}:${d.port ?? 22} aliases=[${(d.aliases ?? []).join(", ")}]`)
          .join("\n") || "No remote devices configured.";
        ctx.ui.notify(text, "info");
        return;
      }
      if (action === "probe" || action === "health") {
        try {
          const result = await runRemoteProbe(parseProbeCliArgs(parts.slice(1)));
          const text = result.stdout.trim() || result.stderr.trim() || "No output";
          ctx.ui.notify(text, result.exitCode === 0 || result.exitCode === 2 ? "info" : "error");
        } catch (error: any) {
          ctx.ui.notify(error?.message ?? String(error), "error");
        }
        return;
      }
      if (action === "test" && target) {
        const device = getDevice(target);
        const command = "whoami; hostname; uname -sr; uptime";
        const timeoutSeconds = 20;
        const live = startRemoteLiveTerminal(ctx, `command-${Date.now()}`, "remote_test", device, device.defaultUser, command, undefined, false, timeoutSeconds);
        const out = await runSsh(device, {
          command,
          timeoutSeconds,
          onStart: ({ startedAt, totalTimeoutMs }) => live?.setTimeoutBudget(startedAt, totalTimeoutMs),
          onOutput: (stream, text) => live?.append(stream, text),
          onSystem: (text) => live?.system(text),
        });
        live?.finish(out.exitCode, out.timedOut, out.durationMs, out.aborted);
        ctx.ui.notify(formatExec(out), out.exitCode === 0 ? "info" : "error");
        return;
      }
      ctx.ui.notify("Usage: /remote-devices [list|next|prev|focus <index|device>|clear|close|probe|test <device>]", "warning");
    },
  });

  pi.registerTool({
    name: "remote_list_devices",
    label: "Remote Devices: List",
    description: "列出已配置的远程设备。用于查看有哪些 VPS、台式机、服务器可供远程管理。",
    promptSnippet: "列出已配置远程设备及别名/标签",
    promptGuidelines: ["Use remote_list_devices when the user asks what remote machines/devices are available."],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "可选：按 id/name/alias/tag/host 模糊过滤" })),
      tag: Type.Optional(Type.String({ description: "可选：按标签过滤" })),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_list_devices", args, theme),
    renderResult: renderRemoteToolResult,
    async execute(_id, params: any): Promise<ToolResult> {
      const config = readConfig();
      let devices = config.devices;
      if (params.query) devices = devices.filter((d) => scoreDevice(d, params.query!) > 0);
      if (params.tag) devices = devices.filter((d) => (d.tags ?? []).map(normalize).includes(normalize(params.tag!)));
      const publicDevices = devices.map(publicDevice);
      const text = publicDevices.length
        ? publicDevices.map((d) => `${d.id}: ${d.name ?? d.id} -> ${d.defaultUser}@${d.host}:${d.port}${d.sshRoute?.type === "ssh-config" ? ` route=${d.sshRoute.label ?? d.sshRoute.target ?? d.sshRoute.sshHost}` : ""}; aliases=${d.aliases.join("/") || "none"}; tags=${d.tags.join("/") || "none"}`).join("\n")
        : "No matching remote devices.";
      return { content: [{ type: "text", text }], details: { configPath: configPath(), devices: publicDevices } };
    },
  });

  pi.registerTool({
    name: "remote_resolve_device",
    label: "Remote Devices: Resolve",
    description: "根据自然语言名称、别名、标签或 IP 解析远程设备。",
    promptSnippet: "把用户说的设备名称/别名解析为设备 id",
    promptGuidelines: [
      "Use remote_resolve_device before remote operations when the user names a machine by alias, e.g. lab pc, build machine, server.",
      "Confident fuzzy matches are automatically saved as aliases so the same nickname resolves directly next time.",
      "If remote_resolve_device returns multiple close candidates or confidence < 0.7, ask the user to choose, then call remote_learn_alias with the user's original nickname and chosen device.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "用户说的设备名称、别名、标签或 IP" }),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_resolve_device", args, theme),
    renderResult: renderRemoteToolResult,
    async execute(_id, params: any): Promise<ToolResult> {
      const resolved = resolveDevice(params.query);
      const learnedAlias = learnResolvedAlias(params.query, resolved);
      const candidates = resolved.candidates.slice(0, 5).map((c) => ({ score: c.score, device: publicDevice(c.device) }));
      const text = resolved.device
        ? `matched=${resolved.device.id} confidence=${resolved.confidence.toFixed(2)}${learnedAlias ? ` learned_alias=${learnedAlias}` : ""}\n${JSON.stringify(publicDevice(resolved.device), null, 2)}`
        : `No remote device matched query: ${params.query}`;
      return { content: [{ type: "text", text }], details: { query: params.query, matched: resolved.device ? publicDevice(resolved.device) : null, confidence: resolved.confidence, learnedAlias, candidates } };
    },
  });

  pi.registerTool({
    name: "remote_write",
    label: "Remote Devices: Write Text",
    description: "把文本内容安全写入远程文件。适用于写文档、配置片段、脚本模板或日志文本；文本内容不会按 shell 命令做危险词扫描。",
    promptSnippet: "把文本写入远程文件，避免用 remote_exec 拼 heredoc",
    promptGuidelines: [
      "Use remote_write instead of remote_exec when the task is to write text content to a remote file.",
      "remote_write content is data, not a shell command; dangerous words inside content such as reboot, shutdown, or rm -rf do not require allowDangerous by themselves.",
      "Use allowDangerous=true only when the target path or write action is sensitive, such as SSH config, authorized_keys, shell profiles, systemd units, cron, sudoers, or critical /etc files.",
      "Do not use remote_write for binary files in the first version; it only supports text content.",
    ],
    parameters: Type.Object({
      device: Type.String({ description: "设备 id 或明确别名" }),
      path: Type.String({ description: "远端文件路径；相对路径会按 cwd 或远端当前目录解析" }),
      content: Type.String({ description: `要写入的文本内容；最大 ${REMOTE_WRITE_MAX_CONTENT_BYTES} bytes` }),
      mode: Type.Optional(Type.String({ description: "overwrite 或 append；默认 overwrite" })),
      user: Type.Optional(Type.String({ description: "可选：覆盖默认登录用户" })),
      cwd: Type.Optional(Type.String({ description: "可选：远端工作目录，用于解析相对路径" })),
      sudo: Type.Optional(Type.Boolean({ description: "是否用 sudo -n 写入" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "总执行超时秒数；默认 60" })),
      allowDangerous: Type.Optional(Type.Boolean({ description: "仅在用户明确授权敏感路径或高风险写入时设为 true" })),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_write", args, theme),
    renderResult: renderRemoteToolResult,
    async execute(toolCallId, params: any, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolResult> {
      const device = getDevice(params.device);
      const { mode, contentBytes } = validateRemoteWriteParams(params);
      const sensitiveReason = remoteWritePathReason(params.path);
      if (sensitiveReason && !params.allowDangerous) {
        throw new Error(`remote_write 拒绝写入敏感路径：${sensitiveReason}。只有在用户明确授权后才可设置 allowDangerous=true。`);
      }
      const user = params.user || device.sshRoute?.user || device.defaultUser;
      const sudo = Boolean(params.sudo);
      const timeoutSeconds = params.timeout_seconds ?? 60;
      const command = buildRemoteWriteScript(params.path, mode);
      const live = startRemoteLiveTerminal(ctx, toolCallId, "remote_write", device, user, `write ${mode} ${params.path}`, params.cwd, sudo, timeoutSeconds);
      const outcome = await runSsh(device, {
        user,
        command,
        cwd: params.cwd,
        sudo,
        timeoutSeconds,
        allowDangerous: true,
        stdin: Buffer.from(params.content, "utf8").toString("base64"),
        signal,
        onStart: ({ startedAt, totalTimeoutMs }) => live?.setTimeoutBudget(startedAt, totalTimeoutMs),
        onOutput: (stream, text) => live?.append(stream, text),
        onSystem: (text) => live?.system(text),
      });
      live?.finish(outcome.exitCode, outcome.timedOut, outcome.durationMs, outcome.aborted);
      const text = [
        `remote_write ${device.id}`,
        `path=${JSON.stringify(params.path)}`,
        `mode=${mode}`,
        `bytes=${contentBytes}`,
        `sudo=${sudo}`,
        `exit=${outcome.exitCode ?? "unknown"}`,
        `duration=${outcome.durationMs}ms`,
      ].join(" ");
      return {
        content: [{ type: "text", text }],
        details: {
          device: publicDevice(device),
          user: outcome.user,
          path: params.path,
          mode,
          sudo,
          contentBytes,
          timeoutSeconds,
          sensitiveReason,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          aborted: outcome.aborted,
          durationMs: outcome.durationMs,
          stdout: truncate(outcome.stdout, 4000),
          stderr: truncate(outcome.stderr, 4000),
          diagnostics: outcomeDiagnostics(outcome),
        },
        isError: outcome.exitCode !== 0 || Boolean(outcome.errorKind),
      };
    },
  });

  pi.registerTool({
    name: "remote_exec",
    label: "Remote Devices: Exec",
    description: "通过 SSH 在指定远程设备上执行非交互命令。适用于查看状态、配置服务、远程诊断。",
    promptSnippet: "通过 SSH 在已配置设备上执行命令",
    promptGuidelines: [
      "Use remote_read to read remote file contents instead of remote_exec cat; use remote_write when writing text content to a remote file; use remote_exec instead of raw ssh in bash when operating on a configured remote device.",
      "Do not call remote_test_connection before remote_exec as routine preflight; remote_exec already performs SSH connection and returns structured diagnostics on failure.",
      "remote_exec uses SSH key auth and BatchMode; it will not prompt for passwords.",
      "Before calling remote_exec, estimate timeout_seconds from the command's expected runtime instead of relying on the 60s fallback: quick probes 10-30s, package/service/log diagnostics 60-180s, builds/tests/downloads 5-30min, explicitly long jobs longer as requested.",
      "Do not inflate timeout_seconds to hide uncertainty; if runtime is unknown, choose a conservative budget and explain/retry with a larger timeout when needed.",
      "For destructive commands, only set allowDangerous=true after the user clearly authorized that exact destructive action.",
    ],
    parameters: Type.Object({
      device: Type.String({ description: "设备 id 或明确别名" }),
      command: Type.String({ description: "要在远端执行的 shell 命令" }),
      user: Type.Optional(Type.String({ description: "可选：覆盖默认登录用户" })),
      cwd: Type.Optional(Type.String({ description: "可选：远端工作目录" })),
      sudo: Type.Optional(Type.Boolean({ description: "是否用 sudo -n 执行" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "总执行超时秒数。调用前应按命令预期耗时估算；默认 60 只是兜底，不适合构建/测试/下载等长任务" })),
      allowDangerous: Type.Optional(Type.Boolean({ description: "仅在用户明确授权破坏性操作时设为 true" })),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_exec", args, theme),
    renderResult: renderRemoteToolResult,
    async execute(toolCallId, params: any, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolResult> {
      const device = getDevice(params.device);
      const reason = dangerousReason(params.command);
      if (reason && !params.allowDangerous) {
        throw new Error(`remote_exec 拒绝执行疑似危险命令：${reason}。只有在用户明确授权后才可设置 allowDangerous=true。`);
      }
      const user = params.user || device.defaultUser;
      const sudo = Boolean(params.sudo);
      const timeoutSeconds = params.timeout_seconds ?? 60;
      const live = startRemoteLiveTerminal(ctx, toolCallId, "remote_exec", device, user, params.command, params.cwd, sudo, timeoutSeconds);
      const tmuxTee = await createRemoteTmuxTee(device.id, "remote_exec", params.command);
      const outcome = await runSsh(device, {
        user: params.user,
        command: params.command,
        cwd: params.cwd,
        sudo,
        timeoutSeconds,
        allowDangerous: Boolean(params.allowDangerous),
        signal,
        onStart: ({ startedAt, totalTimeoutMs }) => live?.setTimeoutBudget(startedAt, totalTimeoutMs),
        onOutput: (stream, text) => { live?.append(stream, text); tmuxTee?.tee(text); },
        onSystem: (text) => live?.system(text),
      });
      live?.finish(outcome.exitCode, outcome.timedOut, outcome.durationMs, outcome.aborted);
      await tmuxTee?.finish(outcome.exitCode, outcome.durationMs);
      return {
        content: [{ type: "text", text: formatExecContent(outcome) }],
        details: {
          device: publicDevice(device),
          user: outcome.user,
          command: outcome.command,
          remoteCommand: outcome.remoteCommand,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          aborted: outcome.aborted,
          durationMs: outcome.durationMs,
          stdoutChars: outcome.stdout.length,
          stderrChars: outcome.stderr.length,
          diagnostics: outcomeDiagnostics(outcome),
        },
        isError: outcome.exitCode !== 0 || Boolean(outcome.errorKind),
      };
    },
  });

  pi.registerTool({
    name: "remote_read",
    label: "Remote Devices: Read",
    description: `Read the contents of a remote file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${REMOTE_READ_MAX_LINES} lines or ${REMOTE_READ_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
    promptSnippet: "读取远端文件内容，支持文本和图片",
    promptGuidelines: [
      "Use remote_read to read remote file contents instead of remote_exec cat.",
      "remote_read supports offset/limit for large files, similar to the local read tool.",
      "For text files, output is truncated and includes continuation hints.",
      "For images (jpg, png, gif, webp, bmp), the image is returned as an attachment.",
    ],
    parameters: Type.Object({
      device: Type.String({ description: "设备 id 或明确别名" }),
      path: Type.String({ description: "远端文件路径" }),
      offset: Type.Optional(Type.Number({ description: "起始行号（1-indexed）" })),
      limit: Type.Optional(Type.Number({ description: "最大读取行数" })),
      user: Type.Optional(Type.String({ description: "可选：覆盖默认登录用户" })),
      sudo: Type.Optional(Type.Boolean({ description: "是否用 sudo -n 读取" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "总执行超时秒数；默认 60" })),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_read", args, theme),
    renderResult: renderRemoteToolResult,
    async execute(toolCallId, params: any, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolResult> {
      const device = getDevice(params.device);
      const user = params.user || device.defaultUser;
      const sudo = Boolean(params.sudo);
      const timeoutSeconds = params.timeout_seconds ?? 60;
      const offset = Math.max(1, Math.floor(params.offset ?? 1));
      const limit = Math.max(1, Math.min(REMOTE_READ_MAX_LINES, Math.floor(params.limit ?? REMOTE_READ_MAX_LINES)));
      const command = buildRemoteReadScript(params.path, offset, limit, REMOTE_READ_MAX_BYTES);
      const live = startRemoteLiveTerminal(ctx, toolCallId, "remote_read", device, user, `read ${params.path}`, undefined, sudo, timeoutSeconds);
      const tmuxTee = await createRemoteTmuxTee(device.id, "remote_read", `read ${params.path}`);
      const outcome = await runSsh(device, {
        user: params.user,
        command,
        sudo,
        timeoutSeconds,
        allowDangerous: true,
        signal,
        onStart: ({ startedAt, totalTimeoutMs }) => live?.setTimeoutBudget(startedAt, totalTimeoutMs),
        onOutput: (stream, text) => { live?.append(stream, text); tmuxTee?.tee(text); },
        onSystem: (text) => live?.system(text),
      });
      live?.finish(outcome.exitCode, outcome.timedOut, outcome.durationMs, outcome.aborted);
      await tmuxTee?.finish(outcome.exitCode, outcome.durationMs);

      if (outcome.errorKind || outcome.exitCode !== 0) {
        const errorText = outcome.stderr.trim() || outcome.stdout.trim() || `remote_read failed: exit=${outcome.exitCode ?? "unknown"}`;
        return {
          content: [{ type: "text", text: errorText }],
          details: { device: publicDevice(device), user: outcome.user, path: params.path, exitCode: outcome.exitCode, diagnostics: outcomeDiagnostics(outcome) },
          isError: true,
        };
      }

      const parsed = parseRemoteReadResult(outcome);
      if (!parsed) {
        return {
          content: [{ type: "text", text: `remote_read: failed to parse remote output` }],
          details: { device: publicDevice(device), user: outcome.user, path: params.path, stdout: truncate(outcome.stdout, 4000) },
          isError: true,
        };
      }

      if (parsed.type === "error") {
        return {
          content: [{ type: "text", text: outcome.stderr.trim() || "remote_read: unknown error" }],
          details: { device: publicDevice(device), user: outcome.user, path: params.path },
          isError: true,
        };
      }

      if (parsed.type === "image") {
        const mimeType = parsed.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp";
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            { type: "image", data: parsed.data, mimeType },
          ] as any,
          details: { device: publicDevice(device), user: outcome.user, path: params.path, type: "image", mimeType, sizeBytes: parsed.totalLines },
        };
      }

      // Text file
      const totalLines = parsed.totalLines;
      const textContent = parsed.data;
      // Use remote contentLines count (from wc -l) to avoid split() off-by-one.
      // wc -l counts newlines, so add 1 if content is non-empty and doesn't end with newline.
      let outputLines = parsed.contentLines;
      if (textContent && !textContent.endsWith("\n")) outputLines = Math.max(outputLines, outputLines + 1);
      const endLine = offset + Math.max(0, outputLines) - 1;
      // Detect byte-level truncation within a line: if contentBytes hit maxBytes
      // and the last line is likely partial, don't advance past it.
      const byteTruncated = parsed.contentBytes >= REMOTE_READ_MAX_BYTES && outputLines > 0;
      const safeEndLine = byteTruncated ? Math.max(offset, endLine - 1) : endLine;
      const hasMore = safeEndLine < totalLines;

      let outputText = textContent;
      if (offset > totalLines && totalLines > 0) {
        outputText = `Offset ${offset} is beyond the end of the file (${totalLines} lines total).`;
      } else if (hasMore) {
        const nextOffset = safeEndLine + 1;
        const remaining = totalLines - safeEndLine;
        outputText += `\n\n[Showing lines ${offset}-${safeEndLine} of ${totalLines}. ${remaining} more lines. Use offset=${nextOffset} to continue.]`;
      } else if (offset > 1) {
        outputText += `\n\n[Showing lines ${offset}-${safeEndLine} of ${totalLines}.]`;
      }

      return {
        content: [{ type: "text", text: outputText }],
        details: {
          device: publicDevice(device),
          user: outcome.user,
          path: params.path,
          type: "text",
          totalLines,
          offset,
          limit,
          outputLines,
          contentBytes: parsed.contentBytes,
          durationMs: outcome.durationMs,
        },
      };
    },
  });

  pi.registerTool({
    name: "remote_exec_batch",
    label: "Remote Devices: Exec Batch",
    description: "通过一次 SSH 调用在指定远程设备上结构化执行多条非交互命令。支持顺序或并行模式、每条命令输出上限和总输出硬上限，适合批量状态探测和远程诊断。",
    promptSnippet: "一次 SSH 调用批量执行多条远程命令，可并行并结构化返回结果",
    promptGuidelines: [
      "Use remote_exec_batch instead of multiple remote_exec calls when you need several independent read-only probes or status commands on the same device.",
      "Before calling it, group commands that can run in one round; choose mode=parallel for independent lightweight probes, and mode=sequential when commands depend on each other or must not run concurrently.",
      "Set timeout_seconds for the whole batch based on the slowest/total expected runtime; do not rely on the fallback for long operations.",
      "Use max_output_bytes and total_max_output_bytes to request enough output for the expected answer; hard caps still apply, so keep log commands concise with head/tail/grep/journalctl -n.",
      "For destructive commands, only set allowDangerous=true after the user clearly authorized that exact destructive action.",
    ],
    parameters: Type.Object({
      device: Type.String({ description: "设备 id 或明确别名" }),
      commands: Type.Array(Type.Object({
        id: Type.Optional(Type.String({ description: "命令结果 id；建议用 cpu/mem/disk/logs 这类稳定短标识" })),
        command: Type.String({ description: "要在远端执行的 shell 命令" }),
        max_output_bytes: Type.Optional(Type.Number({ description: `此命令 stdout/stderr 各自最多返回多少字节；默认 ${BATCH_DEFAULT_MAX_OUTPUT_BYTES}，硬上限 ${BATCH_HARD_MAX_OUTPUT_BYTES}` })),
      }), { description: `命令列表，最多 ${BATCH_MAX_COMMANDS} 条` }),
      mode: Type.Optional(Type.String({ description: "sequential 或 parallel；默认 sequential" })),
      continueOnError: Type.Optional(Type.Boolean({ description: "顺序模式下某条命令失败后是否继续；默认 true。并行模式总是等待所有命令" })),
      max_output_bytes: Type.Optional(Type.Number({ description: `默认每条命令 stdout/stderr 输出上限；默认 ${BATCH_DEFAULT_MAX_OUTPUT_BYTES}，硬上限 ${BATCH_HARD_MAX_OUTPUT_BYTES}` })),
      total_max_output_bytes: Type.Optional(Type.Number({ description: `所有命令 stdout/stderr 合计返回上限；默认 ${BATCH_DEFAULT_TOTAL_OUTPUT_BYTES}，硬上限 ${BATCH_HARD_TOTAL_OUTPUT_BYTES}` })),
      user: Type.Optional(Type.String({ description: "可选：覆盖默认登录用户" })),
      cwd: Type.Optional(Type.String({ description: "可选：远端工作目录" })),
      sudo: Type.Optional(Type.Boolean({ description: "是否用 sudo -n 执行整个批处理" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "整个批处理的总执行超时秒数。调用前应按批处理预期耗时估算" })),
      allowDangerous: Type.Optional(Type.Boolean({ description: "仅在用户明确授权破坏性操作时设为 true" })),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_exec_batch", args, theme),
    renderResult: renderRemoteToolResult,
    async execute(toolCallId, params: any, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolResult> {
      const device = getDevice(params.device);
      const rawCommands = Array.isArray(params.commands) ? params.commands : [];
      if (rawCommands.length === 0) throw new Error("remote_exec_batch commands 不能为空");
      if (rawCommands.length > BATCH_MAX_COMMANDS) throw new Error(`remote_exec_batch 一次最多允许 ${BATCH_MAX_COMMANDS} 条命令`);

      const defaultOutputLimit = outputLimitFromParams(params.max_output_bytes);
      const seenIds = new Set<string>();
      const commands: RemoteExecBatchCommand[] = rawCommands.map((raw: any, index: number) => {
        if (!raw?.command || typeof raw.command !== "string") throw new Error(`remote_exec_batch commands[${index}].command 必须是字符串`);
        let id = normalizeBatchId(raw.id, index);
        const baseId = id;
        let suffix = 2;
        while (seenIds.has(id)) id = `${baseId}_${suffix++}`;
        seenIds.add(id);
        const reason = dangerousReason(raw.command);
        if (reason && !params.allowDangerous) {
          throw new Error(`remote_exec_batch 拒绝执行疑似危险命令 ${id}: ${reason}。只有在用户明确授权后才可设置 allowDangerous=true。`);
        }
        return {
          id,
          command: raw.command,
          maxOutputBytes: outputLimitFromParams(typeof raw.max_output_bytes === "number" ? raw.max_output_bytes : defaultOutputLimit),
        };
      });

      const mode: RemoteExecBatchMode = params.mode === "parallel" ? "parallel" : "sequential";
      const continueOnError = params.continueOnError !== false;
      const totalOutputLimit = totalOutputLimitFromParams(params.total_max_output_bytes);
      const batchScript = buildRemoteBatchScript(commands, mode, continueOnError);
      const user = params.user || device.defaultUser;
      const sudo = Boolean(params.sudo);
      const timeoutSeconds = params.timeout_seconds ?? 60;
      const live = startRemoteLiveTerminal(ctx, toolCallId, "remote_exec_batch", device, user, `${mode} batch: ${commands.map((item) => item.id).join(", ")}`, params.cwd, sudo, timeoutSeconds);
      const batchSummary = `${mode} batch: ${commands.map((item) => item.id).join(", ")}`;
      const tmuxTee = await createRemoteTmuxTee(device.id, "remote_exec_batch", batchSummary);
      const outcome = await runSsh(device, {
        user: params.user,
        command: batchScript,
        cwd: params.cwd,
        sudo,
        timeoutSeconds,
        allowDangerous: true,
        signal,
        onStart: ({ startedAt, totalTimeoutMs }) => live?.setTimeoutBudget(startedAt, totalTimeoutMs),
        onOutput: (stream, text) => { live?.append(stream, stream === "stdout" ? stripBatchMarkerLines(text) : text); tmuxTee?.tee(stream === "stdout" ? stripBatchMarkerLines(text) : text); },
        onSystem: (text) => live?.system(text),
      });
      live?.finish(outcome.exitCode, outcome.timedOut, outcome.durationMs, outcome.aborted);
      await tmuxTee?.finish(outcome.exitCode, outcome.durationMs);

      const parsedResults = parseRemoteBatchResults(outcome, commands);
      const results = applyTotalBatchOutputLimit(parsedResults, totalOutputLimit);
      const failed = results.some((item) => item.exitCode !== 0 || item.exitCode === null);
      const isError = outcome.exitCode !== 0 || Boolean(outcome.errorKind) || failed;
      return {
        content: [{ type: "text", text: formatBatchToolText(outcome, mode, results) }],
        details: {
          device: publicDevice(device),
          user: outcome.user,
          mode,
          continueOnError,
          commandCount: commands.length,
          timeoutSeconds,
          maxOutputBytesDefault: defaultOutputLimit,
          totalMaxOutputBytes: totalOutputLimit,
          hardCaps: {
            maxCommands: BATCH_MAX_COMMANDS,
            perStreamOutputBytes: BATCH_HARD_MAX_OUTPUT_BYTES,
            totalOutputBytes: BATCH_HARD_TOTAL_OUTPUT_BYTES,
          },
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          aborted: outcome.aborted,
          durationMs: outcome.durationMs,
          diagnostics: outcomeDiagnostics(outcome),
          results,
        },
        isError,
      };
    },
  });

  pi.registerTool({
    name: "remote_probe_devices",
    label: "Remote Devices: Probe All",
    description: "快速并发检测所有已配置远程设备按配置路线是否可 SSH 管理，输出保持简洁：正常显示绿色 √ 和 SSH 延时；异常只显示英文根因，例如 ping failed / SSH auth failed。",
    promptSnippet: "一次性快速检测所有远程设备按配置路线是否可管理及 SSH 延时",
    promptGuidelines: [
      "Use remote_probe_devices when the user asks to test connectivity/latency for all configured remote devices.",
      "Prefer this over calling remote_test_connection repeatedly when the user wants a concise all-device health summary.",
    ],
    parameters: Type.Object({
      timeout_ms: Type.Optional(Type.Number({ description: "ping/TCP 单步超时毫秒，默认 1500" })),
      ssh_timeout_ms: Type.Optional(Type.Number({ description: "SSH 登录超时毫秒，默认 3500" })),
      concurrency: Type.Optional(Type.Number({ description: "并发数，默认 64" })),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_probe_devices", args, theme),
    renderResult: renderProbeToolResult,
    async execute(_id, params: any): Promise<ToolResult> {
      const result = await runRemoteProbe({
        timeout_ms: params.timeout_ms,
        ssh_timeout_ms: params.ssh_timeout_ms,
        concurrency: params.concurrency,
        color: false,
      });
      const text = result.stdout.trim() || result.stderr.trim() || "No output";
      return {
        content: [{ type: "text", text }],
        details: { exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr.trim() },
        isError: result.exitCode === 1 || result.timedOut,
      };
    },
  });

  pi.registerTool({
    name: "remote_test_connection",
    label: "Remote Devices: Test Connection",
    description: "测试远程设备 SSH key 登录，并返回 whoami、hostname、系统版本、uptime。仅用于显式连通性测试、新增/变更设备后的验证，或远程执行失败后的诊断。",
    promptSnippet: "测试远程设备 SSH 连接（非 remote_exec 前置步骤）",
    promptGuidelines: [
      "Use remote_test_connection only when the user explicitly asks to test connectivity, after adding/changing a device, or when diagnosing a failed remote_exec/connectivity issue.",
      "Do not use remote_test_connection as a routine preflight before remote_exec; remote_exec already tests the SSH path and reports diagnostics.",
    ],
    parameters: Type.Object({
      device: Type.String({ description: "设备 id 或别名" }),
      user: Type.Optional(Type.String({ description: "可选：覆盖默认登录用户" })),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_test_connection", args, theme),
    renderResult: renderRemoteToolResult,
    async execute(toolCallId, params: any, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolResult> {
      const device = getDevice(params.device);
      const command = "printf 'whoami='; whoami; printf 'hostname='; hostname; printf 'kernel='; uname -srmo; printf 'os='; (grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '\"' || true); printf 'uptime='; uptime";
      const user = params.user || device.defaultUser;
      const timeoutSeconds = 25;
      const live = startRemoteLiveTerminal(ctx, toolCallId, "remote_test_connection", device, user, "test SSH connection", undefined, false, timeoutSeconds);
      const outcome = await runSsh(device, {
        user: params.user,
        command,
        timeoutSeconds,
        signal,
        onStart: ({ startedAt, totalTimeoutMs }) => live?.setTimeoutBudget(startedAt, totalTimeoutMs),
        onOutput: (stream, text) => live?.append(stream, text),
        onSystem: (text) => live?.system(text),
      });
      live?.finish(outcome.exitCode, outcome.timedOut, outcome.durationMs, outcome.aborted);
      return {
        content: [{ type: "text", text: formatExec(outcome) }],
        details: { device: publicDevice(device), user: outcome.user, exitCode: outcome.exitCode, timedOut: outcome.timedOut, aborted: outcome.aborted, durationMs: outcome.durationMs, diagnostics: outcomeDiagnostics(outcome) },
        isError: outcome.exitCode !== 0 || Boolean(outcome.errorKind),
      };
    },
  });

  pi.registerTool({
    name: "remote_learn_alias",
    label: "Remote Devices: Learn Alias",
    description: "把用户对某台远程设备的新称呼保存为别名，后续可直接用该称呼解析设备。",
    promptSnippet: "把服务器新称呼持久保存为设备别名",
    promptGuidelines: [
      "Use when the user uses a new nickname for a known remote device and the target is clear.",
      "If the nickname is ambiguous, ask the user to choose the device first, then save it with remote_learn_alias.",
    ],
    parameters: Type.Object({
      device: Type.String({ description: "设备 id 或已明确指向该设备的现有别名" }),
      alias: Type.String({ description: "用户刚使用的新称呼/昵称" }),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_learn_alias", args, theme),
    renderResult: renderRemoteToolResult,
    async execute(_id, params: any): Promise<ToolResult> {
      const device = getDevice(params.device);
      const learnedAlias = addAliasToDevice(device.id, params.alias);
      const refreshed = readConfig().devices.find((d) => d.id === device.id) ?? device;
      const text = learnedAlias
        ? `learned_alias ${learnedAlias} -> ${device.id}`
        : `alias already known or invalid for device=${device.id}`;
      return {
        content: [{ type: "text", text }],
        details: { device: publicDevice(refreshed), alias: params.alias, learnedAlias, configPath: configPath() },
      };
    },
  });

  pi.registerTool({
    name: "remote_add_device",
    label: "Remote Devices: Add",
    description: "添加或更新一个远程设备到 remote-devices 清单。不会保存密码。",
    promptSnippet: "快速添加/更新远程设备配置",
    promptGuidelines: [
      "Use remote_add_device when the user provides a new host/IP and wants it remembered as a remote device.",
      "Do not store passwords in remote_add_device. Use password only in a separate bootstrap flow, then install SSH keys.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "设备唯一 id，如 lab-machine 或 build-server" }),
      host: Type.String({ description: "主机名或 IP" }),
      defaultUser: Type.String({ description: "默认 SSH 用户" }),
      name: Type.Optional(Type.String({ description: "展示名称" })),
      port: Type.Optional(Type.Number({ description: "SSH 端口，默认 22" })),
      users: Type.Optional(Type.Array(Type.String(), { description: "已知用户列表" })),
      aliases: Type.Optional(Type.Array(Type.String(), { description: "自然语言别名" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "标签" })),
      identityFile: Type.Optional(Type.String({ description: "SSH 私钥路径，默认 ~/.ssh/id_ed25519" })),
      sudo: Type.Optional(Type.Boolean({ description: "默认用户是否具备 sudo 能力" })),
      notes: Type.Optional(Type.String({ description: "备注" })),
      overwrite: Type.Optional(Type.Boolean({ description: "若 id 已存在，是否覆盖更新" })),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_add_device", args, theme),
    renderResult: renderRemoteToolResult,
    async execute(_id, params: any): Promise<ToolResult> {
      const config = readConfig();
      const nextDevice: RemoteDevice = {
        id: params.id,
        name: params.name,
        host: params.host,
        port: params.port ?? 22,
        defaultUser: params.defaultUser,
        users: params.users?.length ? params.users : [params.defaultUser],
        aliases: params.aliases ?? [],
        tags: params.tags ?? [],
        auth: { type: "ssh-key", identityFile: params.identityFile || "~/.ssh/id_ed25519" },
        sudo: Boolean(params.sudo),
        notes: params.notes,
      };
      validateDeviceInput(nextDevice);
      const index = config.devices.findIndex((d) => d.id === nextDevice.id);
      if (index >= 0 && !params.overwrite) {
        throw new Error(`设备 ${nextDevice.id} 已存在；如需更新请设置 overwrite=true`);
      }
      if (index >= 0) config.devices[index] = nextDevice;
      else config.devices.push(nextDevice);
      writeConfig(config);
      const text = `${index >= 0 ? "updated" : "added"} device=${nextDevice.id} config=${configPath()}\n${JSON.stringify(publicDevice(nextDevice), null, 2)}`;
      return { content: [{ type: "text", text }], details: { action: index >= 0 ? "updated" : "added", configPath: configPath(), device: publicDevice(nextDevice) } };
    },
  });

  pi.registerTool({
    name: "remote_install_keys",
    label: "Remote Devices: Install SSH Keys",
    description: "把本机公钥、本机 authorized_keys 中信任的公钥或显式给出的公钥安装到远程用户 authorized_keys。",
    promptSnippet: "给远程设备用户安装 SSH 公钥",
    promptGuidelines: [
      "Use remote_install_keys when the user asks to add local or trusted SSH keys to a remote device user.",
      "Prefer connecting as root for remote_install_keys when targetUsers includes root; otherwise sudo -n may fail if sudo requires a password.",
    ],
    parameters: Type.Object({
      device: Type.String({ description: "设备 id 或别名" }),
      targetUsers: Type.Array(Type.String(), { description: "要安装 authorized_keys 的远端用户列表" }),
      connectUser: Type.Optional(Type.String({ description: "SSH 登录用户；默认 root（若设备含 root 用户）否则 defaultUser" })),
      keySources: Type.Optional(Type.Array(Type.String(), { description: "local-default、local-authorized-keys；默认两者都用" })),
      explicitPublicKeys: Type.Optional(Type.Array(Type.String(), { description: "额外显式公钥行" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "超时秒数，默认 40" })),
    }),
    renderCall: (args: any, theme: Theme) => renderRemoteToolCall("remote_install_keys", args, theme),
    renderResult: renderRemoteToolResult,
    async execute(toolCallId, params: any, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolResult> {
      const device = getDevice(params.device);
      const sources = params.keySources?.length ? params.keySources : ["local-default", "local-authorized-keys"];
      const keys = readLocalPublicKeys(sources, params.explicitPublicKeys);
      if (keys.length === 0) throw new Error("没有找到可安装的本机公钥");
      const users = [...new Set(params.targetUsers.filter(Boolean))];
      if (users.length === 0) throw new Error("targetUsers 不能为空");
      const connectUser = params.connectUser || ((device.users ?? []).includes("root") ? "root" : device.defaultUser);
      const keysB64 = Buffer.from(keys.join("\n") + "\n", "utf8").toString("base64");
      const usersLiteral = users.map(shellQuote).join(" ");
      const script = `set -euo pipefail
TMP_KEYS=$(mktemp)
printf %s ${shellQuote(keysB64)} | base64 -d > "$TMP_KEYS"
for U in ${usersLiteral}; do
  if ! id "$U" >/dev/null 2>&1; then echo "ERROR user_not_found=$U" >&2; exit 1; fi
  HOME_DIR=$(getent passwd "$U" | cut -d: -f6)
  SSH_DIR="$HOME_DIR/.ssh"
  AUTH_KEYS="$SSH_DIR/authorized_keys"
  install -d -m 700 "$SSH_DIR"
  touch "$AUTH_KEYS"
  chmod 600 "$AUTH_KEYS"
  added=0
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    kt=$(printf '%s\\n' "$key" | awk '{print $1}')
    kb=$(printf '%s\\n' "$key" | awk '{print $2}')
    if awk -v kt="$kt" -v kb="$kb" 'NF>=2 && $1==kt && $2==kb {found=1} END{exit found?0:1}' "$AUTH_KEYS"; then :; else printf '%s\\n' "$key" >> "$AUTH_KEYS"; added=$((added+1)); fi
  done < "$TMP_KEYS"
  if [ "$U" = root ]; then chown root:root "$SSH_DIR" "$AUTH_KEYS"; else chown "$U:$U" "$SSH_DIR" "$AUTH_KEYS"; fi
  total=$(awk 'NF && $1 !~ /^#/ {c++} END{print c+0}' "$AUTH_KEYS")
  echo "user=$U added=$added total_keys=$total file=$AUTH_KEYS"
done
rm -f "$TMP_KEYS"`;
      const needsSudo = connectUser !== "root";
      const timeoutSeconds = params.timeout_seconds ?? 40;
      const live = startRemoteLiveTerminal(
        ctx,
        toolCallId,
        "remote_install_keys",
        device,
        connectUser,
        `install SSH keys for ${users.join(", ")}`,
        undefined,
        needsSudo,
        timeoutSeconds,
      );
      const outcome = await runSsh(device, {
        user: connectUser,
        command: script,
        sudo: needsSudo,
        timeoutSeconds,
        signal,
        onStart: ({ startedAt, totalTimeoutMs }) => live?.setTimeoutBudget(startedAt, totalTimeoutMs),
        onOutput: (stream, text) => live?.append(stream, text),
        onSystem: (text) => live?.system(text),
      });
      live?.finish(outcome.exitCode, outcome.timedOut, outcome.durationMs, outcome.aborted);
      return {
        content: [{ type: "text", text: formatExec(outcome) }],
        details: { device: publicDevice(device), connectUser, targetUsers: users, keyCount: keys.length, sources, exitCode: outcome.exitCode, timedOut: outcome.timedOut, aborted: outcome.aborted, durationMs: outcome.durationMs, diagnostics: outcomeDiagnostics(outcome) },
        isError: outcome.exitCode !== 0 || Boolean(outcome.errorKind),
      };
    },
  });
}
