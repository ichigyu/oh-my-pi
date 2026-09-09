import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// Footer updates go through the shared event bus ("oh-my-pi:timer"), handled by the
// status-bar extension. Do NOT import status-bar.ts here: the pi extension loader
// creates one module instance per extension entry (jiti moduleCache: false), and a
// second status-bar instance would install a competing footer whose state never
// receives event updates (frozen TOKEN line).
type EventsApi = { emit: (channel: string, data: unknown) => void };
let events: EventsApi | undefined;

type TimerPhase = "idle" | "running" | "paused";
type Stage = "waiting" | "thinking" | "answering" | "tool" | "working" | "paused" | "idle";

type TimerState = {
  enabled: boolean;
  phase: TimerPhase;
  stage: Stage;
  startedAt?: number;
  accumulatedMs: number;
  pausedReason?: string;
  currentTool?: string;
};

const TICK_MS = 1000;

const state: TimerState = {
  enabled: process.env.OH_MY_PI_TASK_TIMER_DISABLED !== "1",
  phase: "idle",
  stage: "idle",
  accumulatedMs: 0,
};

let tickTimer: ReturnType<typeof setInterval> | undefined;

function elapsedMs(now = Date.now()): number {
  if (state.phase === "running" && state.startedAt !== undefined) return state.accumulatedMs + (now - state.startedAt);
  return state.accumulatedMs;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stageText(): string {
  if (state.currentTool) return `tool ${state.currentTool}`;
  if (state.phase === "paused") return `paused${state.pausedReason ? ` (${state.pausedReason})` : ""}`;
  if (state.stage === "answering") return "answering";
  if (state.stage === "thinking") return "thinking";
  if (state.stage === "waiting") return "waiting";
  if (state.stage === "working") return "working";
  return state.phase;
}

function commandArgs(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function statusText(): string {
  return `oh-my-pi timer · ${formatDuration(elapsedMs())} · ${stageText()}`;
}

function publish(): void {
  events?.emit("oh-my-pi:timer", {
    enabled: state.enabled,
    elapsed: formatDuration(elapsedMs()),
    stage: stageText(),
  });
}

function start(): void {
  state.phase = "running";
  state.stage = "working";
  state.startedAt = Date.now();
  state.accumulatedMs = 0;
  state.pausedReason = undefined;
  state.currentTool = undefined;
  publish();
}

function resume(): void {
  if (state.phase !== "paused") return;
  state.phase = "running";
  state.stage = "working";
  state.startedAt = Date.now();
  state.pausedReason = undefined;
  publish();
}

function pause(reason: string): void {
  if (state.phase === "running") {
    state.accumulatedMs = elapsedMs();
    state.startedAt = undefined;
  }
  if (state.phase !== "idle") {
    state.phase = "paused";
    state.stage = "paused";
    state.pausedReason = reason;
  }
  publish();
}

function setStage(stage: Stage): void {
  if (state.phase === "idle") return;
  if (state.phase === "paused") resume();
  state.stage = stage;
  publish();
}

function assistantEventStage(event: unknown): Stage | undefined {
  const type = String((event as { assistantMessageEvent?: { type?: unknown } })?.assistantMessageEvent?.type ?? "");
  if (type === "thinking_start" || type === "thinking_delta") return "thinking";
  if (type === "text_start" || type === "text_delta") return "answering";
  if (type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end") return "tool";
  return undefined;
}

function toolName(event: unknown): string {
  const name = (event as { toolName?: unknown }).toolName;
  return typeof name === "string" && name.trim() ? name.trim() : "tool";
}

export function showTaskTimer(ctx: ExtensionCommandContext): void {
  if (!ctx.hasUI) return;
  const lines = [
    `Status: ${state.enabled ? "enabled" : "disabled"}`,
    `Elapsed: ${formatDuration(elapsedMs())}`,
    `Stage: ${stageText()}`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

export default function taskTimer(pi: ExtensionAPI): void {
  events = pi.events;
  pi.events.on("oh-my-pi:show-task-timer", (payload) => {
    const ctx = (payload as { ctx?: ExtensionCommandContext } | undefined)?.ctx;
    if (ctx) showTaskTimer(ctx);
  });
  pi.registerCommand("task-timer", {
    description: "Show or toggle the oh-my-pi task timer",
    handler: async (args, ctx) => {
      const action = commandArgs(args).trim().toLowerCase();
      if (action === "off") state.enabled = false;
      else if (action === "on") state.enabled = true;
      else if (action === "toggle") state.enabled = !state.enabled;
      else if (action && action !== "status") {
        if (ctx.hasUI) ctx.ui.notify("Usage: /task-timer [status|on|off|toggle]", "warning");
        return;
      }
      publish();
      showTaskTimer(ctx);
    },
  });

  pi.on("session_start", () => {
    publish();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => publish(), TICK_MS);
    (tickTimer as { unref?: () => void }).unref?.();
  });

  pi.on("session_shutdown", () => {
    events?.emit("oh-my-pi:timer-clear");
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = undefined;
    state.phase = "idle";
    state.stage = "idle";
    state.accumulatedMs = 0;
    state.startedAt = undefined;
    state.currentTool = undefined;
  });

  pi.on("input", () => start());

  pi.on("before_agent_start", () => setStage("waiting"));

  pi.on("before_provider_request", () => setStage("waiting"));

  pi.on("message_update", (event) => {
    const stage = assistantEventStage(event);
    if (stage) setStage(stage);
  });

  pi.on("tool_execution_start", (event) => {
    if (state.phase === "idle") start();
    state.currentTool = toolName(event);
    setStage("tool");
  });

  pi.on("tool_execution_end", () => {
    state.currentTool = undefined;
    setStage("working");
  });

  pi.on("agent_end", () => {
    state.currentTool = undefined;
    pause("waiting for user");
  });
}
