import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import { showTavilyPoolStatus, tavilyPoolStats } from "./tavily-tools";
import { getMineruStatus } from "./mineru/config";
import { runMineruCommand } from "./mineru";
import { showOhMyPiStatusBar } from "./status-bar";
import { getRtkStatus, showRtkAdapter } from "./rtk-adapter";
import { showTaskTimer } from "./task-timer";
import { parseSkillFrontmatter } from "./lib/skill-frontmatter.ts";
import { checkUsageHealth } from "./usage/health.ts";
import { getAppendSystemStatus } from "./append-system/status.ts";

type ToolsState = {
  enabledTools: string[];
};

type DoctorSeverity = "pass" | "info" | "warn" | "fail";

type DoctorCheck = {
  severity: DoctorSeverity;
  label: string;
  detail?: string;
};

type MenuItem =
  | "Tools"
  | "Commands"
  | "Skills"
  | "Extensions"
  | "Remote devices"
  | "Status bar"
  | "Task timer"
  | "Doctor"
  | "RTK setup"
  | "MinerU"
  | "Tavily status";

const MENU_ITEMS: MenuItem[] = ["Tools", "Commands", "Skills", "Extensions", "Remote devices", "Status bar", "Task timer", "Doctor", "RTK setup", "MinerU", "Tavily status"];
const ARG_ALIASES: Record<string, MenuItem> = {
  tools: "Tools",
  commands: "Commands",
  skills: "Skills",
  extensions: "Extensions",
  remote: "Remote devices",
  devices: "Remote devices",
  status: "Status bar",
  statusbar: "Status bar",
  "status-bar": "Status bar",
  timer: "Task timer",
  tasktimer: "Task timer",
  "task-timer": "Task timer",
  doctor: "Doctor",
  rtk: "RTK setup",
  mineru: "MinerU",
  tavily: "Tavily status",
};

const DOCTOR_SCAN_EXCLUDES = new Set([".git", ".pi", "node_modules", "packages", "package-lock.json"]);
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "private key marker", pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", pattern: /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/ },
  { label: "private host/IP example", pattern: /\b(?:10\.110\.\d{1,3}\.\d{1,3}|192\.168\.41\.\d{1,3}|139\.196\.\d{1,3}\.\d{1,3}|100\.100\.\d{1,3}\.\d{1,3})\b/ },
];

function formatCommand(command: SlashCommandInfo): string {
  const desc = command.description ? ` - ${command.description}` : "";
  return `/${command.name}${desc}`;
}

function commandNameFromItem(item: string): string {
  return item.split(" - ")[0].slice(1);
}

function uniquePaths(commands: SlashCommandInfo[]): string[] {
  return [...new Set(commands.map((command) => command.sourceInfo?.path).filter((path): path is string => Boolean(path)))];
}

function getToolLabel(tool: ToolInfo, enabled: boolean): string {
  return `${enabled ? "[x]" : "[ ]"} ${tool.name}`;
}

function truncateDetail(value: string, max = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function packageRoot(): string {
  return process.cwd();
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (DOCTOR_SCAN_EXCLUDES.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(root);
  return files;
}

async function checkPackageLoads(pi: ExtensionAPI, root: string): Promise<DoctorCheck> {
  try {
    const result = await pi.exec("pi", ["-e", root, "--list-models"], { timeout: 30_000 });
    if (result.code === 0) return { severity: "pass", label: "package loads" };
    return { severity: "fail", label: "package load failed", detail: truncateDetail(result.stderr || result.stdout || `exit ${result.code}`) };
  } catch (error) {
    return { severity: "fail", label: "package load failed", detail: truncateDetail((error as Error).message) };
  }
}

function checkRegistration(pi: ExtensionAPI): DoctorCheck[] {
  const commands = pi.getCommands();
  const tools = pi.getAllTools();
  const commandNames = new Set(commands.map((command) => command.name));
  const toolNames = new Set(tools.map((tool) => tool.name));
  const checks: DoctorCheck[] = [];

  checks.push(commandNames.has("oh-my-pi")
    ? { severity: "pass", label: "/oh-my-pi command registered" }
    : { severity: "fail", label: "/oh-my-pi command missing" });

  checks.push(commandNames.has("remote-devices")
    ? { severity: "pass", label: "/remote-devices command registered" }
    : { severity: "warn", label: "/remote-devices command missing" });

  checks.push(commandNames.has("status-bar")
    ? { severity: "pass", label: "/status-bar command registered" }
    : { severity: "warn", label: "/status-bar command missing" });

  checks.push(commandNames.has("rtk-adapter")
    ? { severity: "pass", label: "/rtk-adapter command registered" }
    : { severity: "warn", label: "/rtk-adapter command missing" });

  checks.push(commandNames.has("task-timer")
    ? { severity: "pass", label: "/task-timer command registered" }
    : { severity: "warn", label: "/task-timer command missing" });

  checks.push(commandNames.has("usage")
    ? { severity: "pass", label: "/usage command registered" }
    : { severity: "warn", label: "/usage command missing" });

  checks.push(commandNames.has("mineru")
    ? { severity: "pass", label: "/mineru command registered" }
    : { severity: "warn", label: "/mineru command missing" });

  const expectedRemoteTools = ["remote_list_devices", "remote_resolve_device", "remote_write", "remote_exec", "remote_exec_batch", "remote_probe_devices", "remote_test_connection", "remote_add_device", "remote_learn_alias", "remote_install_keys"];
  const missingRemoteTools = expectedRemoteTools.filter((name) => !toolNames.has(name));
  checks.push(missingRemoteTools.length === 0
    ? { severity: "pass", label: "remote-devices tools registered" }
    : { severity: "warn", label: "remote-devices tools missing", detail: missingRemoteTools.join(", ") });

  // serial-devices extension check
  const expectedSerialTools = ["serial_exec", "serial_read"];
  const missingSerialTools = expectedSerialTools.filter((name) => !toolNames.has(name));
  checks.push(missingSerialTools.length === 0
    ? { severity: "pass", label: "serial-devices tools registered" }
    : { severity: "warn", label: "serial-devices tools missing", detail: missingSerialTools.join(", ") });

  return checks;
}

async function checkMineruHealth(pi: ExtensionAPI): Promise<DoctorCheck[]> {
  const status = await getMineruStatus();
  const checks: DoctorCheck[] = [];
  const tools = new Set(pi.getAllTools().map((tool) => tool.name));
  const mineruSkillName = "mineru-document-parsing";
  const mineruSkillPath = path.join(packageRoot(), "skills", mineruSkillName, "SKILL.md");
  const mineruSkill = fs.existsSync(mineruSkillPath)
    ? parseSkillFrontmatter(fs.readFileSync(mineruSkillPath, "utf8"))
    : undefined;
  const skillCommand = pi.getCommands().some((command) =>
    command.source === "skill" && (command.name === mineruSkillName || command.name === `skill:${mineruSkillName}`));

  checks.push(tools.has("mineru_parse")
    ? { severity: "pass", label: "MinerU parse tool registered" }
    : { severity: "warn", label: "MinerU parse tool missing" });

  checks.push(mineruSkill?.name === mineruSkillName && mineruSkill.description
    ? { severity: "pass", label: "MinerU routing skill packaged", detail: path.relative(packageRoot(), mineruSkillPath) }
    : { severity: "fail", label: "MinerU routing skill missing or invalid", detail: path.relative(packageRoot(), mineruSkillPath) });

  checks.push(skillCommand
    ? { severity: "pass", label: "MinerU routing skill command registered" }
    : { severity: "warn", label: "MinerU routing skill command unavailable", detail: "skill may still be loaded; set enableSkillCommands=true to expose /skill:mineru-document-parsing" });

  checks.push(status.disabled
    ? { severity: "warn", label: "MinerU disabled", detail: "OH_MY_PI_MINERU_DISABLED=1" }
    : { severity: "pass", label: "MinerU capability enabled" });

  checks.push(status.configured
    ? { severity: "pass", label: "MinerU token configured", detail: `${status.tokenSource}${status.tokenId ? ` (${status.tokenId})` : ""}` }
    : { severity: "warn", label: "MinerU token not configured", detail: "set MINERU_TOKEN or run /mineru setup with a Keychain token" });

  checks.push(status.authorized
    ? { severity: "pass", label: "MinerU cloud upload authorized", detail: status.authorization?.retentionDisclosure }
    : { severity: "warn", label: "MinerU cloud upload authorization missing", detail: "run /mineru setup" });

  const root = fs.realpathSync(packageRoot());
  const runtime = fs.existsSync(status.configPath) ? fs.realpathSync(status.configPath) : path.resolve(status.configPath);
  checks.push(root === runtime || isInside(root, runtime)
    ? { severity: "fail", label: "MinerU runtime config is inside package checkout", detail: runtime }
    : { severity: "pass", label: "MinerU runtime config outside repo", detail: runtime });

  return checks;
}

function checkTavilyHealth(pi: ExtensionAPI): DoctorCheck[] {
  const tools = new Set(pi.getAllTools().map((tool) => tool.name));
  const commands = new Set(pi.getCommands().map((command) => command.name));
  const expectedTools = ["tavily_search", "tavily_extract", "tavily_crawl", "tavily_research"];
  const missingTools = expectedTools.filter((name) => !tools.has(name));
  const stats = tavilyPoolStats();
  const ready = stats.keys.filter((key) => key.status === "ready").length;
  const unavailable = stats.keys.length - ready;
  const checks: DoctorCheck[] = [];

  checks.push(missingTools.length === 0
    ? { severity: "pass", label: "Tavily tools registered", detail: expectedTools.join(", ") }
    : { severity: "warn", label: "Tavily tools missing", detail: missingTools.join(", ") });

  checks.push(commands.has("tavily-pool-status")
    ? { severity: "pass", label: "/tavily-pool-status command registered" }
    : { severity: "warn", label: "/tavily-pool-status command missing" });

  if (stats.keys.length === 0) {
    checks.push({ severity: "warn", label: "Tavily keys not configured", detail: "set TAVILY_API_KEY, TAVILY_API_KEYS, or keychain services" });
  } else if (ready > 0) {
    checks.push({ severity: "pass", label: "Tavily key pool ready", detail: `${ready}/${stats.keys.length} ready${unavailable ? `, ${unavailable} unavailable` : ""}` });
  } else {
    checks.push({ severity: "warn", label: "Tavily key pool has no ready keys", detail: `${stats.keys.length} configured, 0 ready` });
  }

  return checks;
}

async function checkRtkHealth(pi: ExtensionAPI): Promise<DoctorCheck[]> {
  const commands = new Set(pi.getCommands().map((command) => command.name));
  const checks: DoctorCheck[] = [];

  checks.push(commands.has("rtk-adapter")
    ? { severity: "pass", label: "RTK adapter command registered" }
    : { severity: "warn", label: "RTK adapter command missing", detail: "extension not configured" });

  const status = await getRtkStatus(pi);
  if (status.available) {
    checks.push({ severity: "pass", label: "RTK available", detail: status.version ? truncateDetail(status.version, 80) : undefined });
  } else {
    const baseDetail = status.detail && /not found|ENOENT|command not found/i.test(status.detail)
      ? "rtk command not installed"
      : "rtk command unavailable or not configured";
    const detail = status.detail
      ? `${baseDetail}: ${truncateDetail(status.detail, 80)}`
      : baseDetail;
    checks.push({ severity: "warn", label: "RTK unavailable", detail });
  }

  return checks;
}

function checkUiExtensionHealth(pi: ExtensionAPI): DoctorCheck[] {
  const commands = new Set(pi.getCommands().map((command) => command.name));
  const checks: DoctorCheck[] = [];
  const uiExtensions = [
    { command: "status-bar", label: "status footer/detail lane/tool activity", disabled: process.env.OH_MY_PI_STATUS_BAR_DISABLED === "1" },
    { command: "workflow-card", label: "workflow milestone cards", disabled: false },
    { command: "task-timer", label: "task-timer", disabled: process.env.OH_MY_PI_TASK_TIMER_DISABLED === "1" },
    { command: "compact-tools", label: "compact tool transcript", disabled: process.env.OH_MY_PI_COMPACT_TOOLS_DISABLED === "1" },
  ];

  for (const item of uiExtensions) {
    if (!commands.has(item.command)) {
      checks.push({ severity: "warn", label: `${item.label} command missing` });
    } else if (item.disabled) {
      checks.push({ severity: "warn", label: `${item.label} registered but disabled by env` });
    } else {
      checks.push({ severity: "pass", label: `${item.label} registered` });
    }
  }

  return checks;
}

function checkRemoteSeed(root: string): DoctorCheck {
  const seedPath = path.join(root, "extensions", "remote-devices", "devices.json");
  if (!fs.existsSync(seedPath)) return { severity: "warn", label: "remote-devices seed missing" };
  try {
    const data = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    const count = Array.isArray(data.devices) ? data.devices.length : 0;
    if (count === 0) return { severity: "pass", label: "remote-devices seed has 0 devices" };
    return { severity: "fail", label: "remote-devices seed contains devices", detail: `${count} device(s)` };
  } catch (error) {
    return { severity: "fail", label: "remote-devices seed parse failed", detail: truncateDetail((error as Error).message) };
  }
}

function checkRuntimeConfigBoundary(root: string): DoctorCheck {
  const runtimePath = process.env.PI_REMOTE_DEVICES_CONFIG || path.join(os.homedir(), ".pi", "agent", "remote-devices", "devices.json");
  if (process.env.PI_REMOTE_DEVICES_CONFIG) {
    const resolvedRoot = fs.realpathSync(root);
    const resolvedRuntimeDir = fs.existsSync(runtimePath) ? fs.realpathSync(path.dirname(runtimePath)) : path.resolve(path.dirname(runtimePath));
    const resolvedRuntime = fs.existsSync(runtimePath) ? fs.realpathSync(runtimePath) : path.resolve(runtimePath);
    if (isInside(resolvedRoot, resolvedRuntimeDir) || resolvedRoot === resolvedRuntimeDir || isInside(resolvedRoot, resolvedRuntime) || resolvedRoot === resolvedRuntime) {
      return { severity: "fail", label: "remote-devices runtime config override is inside package checkout", detail: resolvedRuntime };
    }
    return { severity: fs.existsSync(runtimePath) ? "pass" : "warn", label: "remote-devices runtime config override outside repo", detail: resolvedRuntime };
  }
  if (!fs.existsSync(runtimePath)) return { severity: "warn", label: "remote-devices runtime config not found", detail: runtimePath };
  const resolvedRoot = fs.realpathSync(root);
  const resolvedRuntime = fs.realpathSync(runtimePath);
  if (isInside(resolvedRoot, resolvedRuntime) || resolvedRoot === resolvedRuntime) {
    return { severity: "fail", label: "remote-devices runtime config is inside package checkout", detail: resolvedRuntime };
  }
  return { severity: "pass", label: "remote-devices runtime config outside repo" };
}

function readRemoteDevicesSource(root: string): string | undefined {
  const file = path.join(root, "extensions", "remote-devices", "index.ts");
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf8");
}

function checkRemoteDevicesSafetySource(source: string | undefined): DoctorCheck[] {
  if (!source) return [{ severity: "warn", label: "remote-devices source missing" }];

  const checks: DoctorCheck[] = [];
  const dangerousPatterns = ["rm", "dd", "mkfs", "parted", "fdisk", "wipefs", "reboot", "shutdown", "poweroff", "halt", "chmod", "chown", "iptables", "ufw", "nft", "drop\\s+database"];
  const missingDangerousPatterns = dangerousPatterns.filter((pattern) => !new RegExp(pattern, "i").test(source));
  checks.push(source.includes("function dangerousReason") && source.includes("allowDangerous") && missingDangerousPatterns.length === 0
    ? { severity: "pass", label: "remote-devices dangerous guard covers high-risk commands" }
    : { severity: "fail", label: "remote-devices dangerous guard incomplete", detail: missingDangerousPatterns.join(", ") || "missing guard wiring" });

  const timeoutTokens = ["DEFAULT_CONNECT_TIMEOUT_MS", "DEFAULT_FIRST_BYTE_TIMEOUT_MS", "DEFAULT_IDLE_TIMEOUT_MS", "totalTimeoutMs", "killGraceMs", "ServerAliveInterval", "NumberOfPasswordPrompts=0"];
  const missingTimeoutTokens = timeoutTokens.filter((token) => !source.includes(token));
  checks.push(missingTimeoutTokens.length === 0
    ? { severity: "pass", label: "remote-devices timeout watchdog configured" }
    : { severity: "fail", label: "remote-devices timeout watchdog incomplete", detail: missingTimeoutTokens.join(", ") });

  const outputTokens = ["MAX_CAPTURE_CHARS", "BATCH_HARD_MAX_OUTPUT_BYTES", "BATCH_HARD_TOTAL_OUTPUT_BYTES", "applyTotalBatchOutputLimit", "truncateUtf8Bytes"];
  const missingOutputTokens = outputTokens.filter((token) => !source.includes(token));
  checks.push(missingOutputTokens.length === 0
    ? { severity: "pass", label: "remote-devices output caps configured" }
    : { severity: "fail", label: "remote-devices output caps incomplete", detail: missingOutputTokens.join(", ") });

  return checks;
}

function checkRemoteDevicesUiSource(source: string | undefined): DoctorCheck[] {
  if (!source) return [];
  const checks: DoctorCheck[] = [];

  const shortcutLabel = /REMOTE_LIVE_TOGGLE_SHORTCUT_LABEL\s*=\s*["']Ctrl\+Shift\+R["']/.test(source);
  const shortcutRegistration = /registerShortcut\(["']ctrl\+shift\+r["']/.test(source);
  const staleShortcut = /Alt\+\/\s+(?:expand|collapse)/.test(source);
  checks.push(shortcutLabel && shortcutRegistration && !staleShortcut
    ? { severity: "pass", label: "Remote Bash shortcut hint matches registration" }
    : { severity: "fail", label: "Remote Bash shortcut hint mismatch" });

  const fallbackActions = ["next", "prev", "toggle", "clear", "test"];
  const missingActions = fallbackActions.filter((action) => !new RegExp(`action === ["']${action}["']`).test(source));
  checks.push(missingActions.length === 0
    ? { severity: "pass", label: "/remote-devices command fallbacks registered" }
    : { severity: "fail", label: "/remote-devices command fallbacks missing", detail: missingActions.join(", ") });

  checks.push(source.includes("oh-my-pi:detail") && source.includes("publishRemoteDetail")
    ? { severity: "pass", label: "Remote detail lane integration registered" }
    : { severity: "fail", label: "Remote detail lane integration missing" });

  return checks;
}

function checkSensitiveContent(root: string): DoctorCheck {
  const maxMatches = 5;
  const maxFileSizeBytes = 1024 * 1024;
  const matches: string[] = [];

  for (const file of walkFiles(root)) {
    if (matches.length >= maxMatches) break;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }

    if (!stat.isFile() || stat.size > maxFileSizeBytes) continue;

    const relative = path.relative(root, file);
    if (!/\.(?:ts|js|json|md|yml|yaml|toml|txt|rs)$/.test(relative)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (!pattern.test(text)) continue;
      matches.push(`${relative}: ${label}`);
      if (matches.length >= maxMatches) break;
    }
  }

  if (matches.length === 0) return { severity: "pass", label: "sensitive content scan clean" };
  return { severity: "fail", label: "sensitive content scan found matches", detail: matches.join("; ") };
}

function findPiPackageRoot(start: string): string | undefined {
  let current = path.resolve(start);
  while (current !== path.dirname(current)) {
    const packageJson = path.join(current, "package.json");
    if (fs.existsSync(packageJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
        if (pkg.name === "@earendil-works/pi-coding-agent") return current;
      } catch {}
    }
    current = path.dirname(current);
  }
  return undefined;
}

function activePiPackageRoot(): string | undefined {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  let npmLocalFallback: string | undefined;
  for (const directory of String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const executable = path.join(directory, `pi${extension}`);
      if (!fs.existsSync(executable)) continue;
      const active = findPiPackageRoot(path.dirname(fs.realpathSync(executable)));
      if (!active) continue;
      if (directory.includes(`${path.sep}node_modules${path.sep}.bin`)) npmLocalFallback ??= active;
      else return active;
    }
  }
  return npmLocalFallback ?? findPiPackageRoot(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
}

function checkPiEmptyCommentsPatch(): DoctorCheck {
  try {
    const packageRoot = activePiPackageRoot();
    if (!packageRoot) return { severity: "warn", label: "Pi empty-comment patch status unknown", detail: "package root not found" };

    const target = path.join(packageRoot, "dist", "modes", "interactive", "components", "assistant-message.js");
    if (!fs.existsSync(target)) return { severity: "warn", label: "Pi empty-comment patch status unknown", detail: "assistant renderer not found" };
    const source = fs.readFileSync(target, "utf8");
    if (source.includes("function stripEmptyHtmlComments")) {
      const metadata = `${target}.oh-my-pi-empty-comments.json`;
      return { severity: "pass", label: "Pi empty assistant comments filtered", detail: fs.existsSync(metadata) ? "managed compatibility patch" : "renderer contains filter" };
    }
    if (source.includes('const hasVisibleContent = message.content.some((c) => (c.type === "text" && c.text.trim())')) {
      return { severity: "warn", label: "Pi empty assistant comments not filtered", detail: "run npm run pi-empty-comments -- apply" };
    }
    return { severity: "warn", label: "Pi empty-comment patch source mismatch", detail: "compatibility patch will refuse to apply" };
  } catch (error) {
    return { severity: "warn", label: "Pi empty-comment patch status unknown", detail: truncateDetail((error as Error).message, 100) };
  }
}

function checkAppendSystemHealth(ctx: ExtensionCommandContext): DoctorCheck {
  const status = getAppendSystemStatus({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    nativeAppendConfigured: ctx.getSystemPromptOptions().appendSystemPrompt !== undefined,
  });
  if (status.mode === "disabled") {
    return { severity: "warn", label: "APPEND_SYSTEM bundled fallback disabled", detail: status.detail };
  }
  if (status.mode === "local") {
    return { severity: "pass", label: "APPEND_SYSTEM local/native configured", detail: status.detail };
  }
  if (status.mode === "bundled") {
    return { severity: "pass", label: "APPEND_SYSTEM bundled fallback active", detail: status.detail };
  }
  return { severity: "fail", label: "APPEND_SYSTEM bundled fallback unavailable", detail: status.detail };
}

function checkSkillFrontmatter(root: string): DoctorCheck {
  const skillsDir = path.join(root, "skills");
  if (!fs.existsSync(skillsDir)) return { severity: "warn", label: "skills directory not found" };
  const failures: string[] = [];
  for (const skillName of fs.readdirSync(skillsDir)) {
    const skillPath = path.join(skillsDir, skillName, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const frontmatter = parseSkillFrontmatter(fs.readFileSync(skillPath, "utf8"));
    if (!frontmatter?.name || !frontmatter?.description) failures.push(path.relative(root, skillPath));
  }
  if (failures.length === 0) return { severity: "pass", label: "skill frontmatter valid" };
  return { severity: "fail", label: "skill frontmatter invalid", detail: failures.join(", ") };
}

// ---------------------------------------------------------------------------
// External dependency checks
// ---------------------------------------------------------------------------

type ExternalDep = {
  cmd: string;
  args?: string[];
  label: string;
  purpose: string;
  severity: DoctorSeverity;
  versionCheck?: (stdout: string, stderr: string) => DoctorCheck | null;
};

const EXTERNAL_DEPS: ExternalDep[] = [
  // fail-level: essential
  { cmd: "git", args: ["--version"], label: "git", purpose: "基础 VCS", severity: "fail" },
  { cmd: "ssh", args: ["-V"], label: "ssh", purpose: "remote-devices SSH 连接", severity: "fail" },
  {
    cmd: "node", args: ["-v"], label: "Node.js", purpose: "pi 运行时", severity: "fail",
    versionCheck: (stdout) => {
      const match = stdout.trim().match(/^v(\d+)/);
      const major = match ? parseInt(match[1], 10) : 0;
      if (major >= 22) return { severity: "pass", label: `Node.js ${stdout.trim()}`, detail: "pi 运行时" };
      return { severity: "fail", label: `Node.js ${stdout.trim()} < 22`, detail: "pi 需要 Node.js >= 22" };
    },
  },
  // warn-level: optional per feature
  { cmd: "tmux", args: ["-V"], label: "tmux", purpose: "serial-devices 共享终端", severity: "warn" },
  { cmd: "picocom", args: ["--help"], label: "picocom", purpose: "serial-devices 串口连接", severity: "warn" },
  {
    cmd: "gh", args: ["auth", "status"], label: "gh CLI", purpose: "github-workflow PR/issue 操作", severity: "warn",
    versionCheck: (stdout, stderr) => {
      const combined = `${stdout} ${stderr}`;
      if (combined.includes("Logged in") || combined.includes("Active account")) {
        return { severity: "pass", label: "gh CLI 已认证", detail: "github-workflow" };
      }
      return { severity: "warn", label: "gh CLI 未认证", detail: "github-workflow：运行 gh auth login" };
    },
  },
  { cmd: "usbip", args: ["version"], label: "usbip", purpose: "WSL2 USB 串口映射", severity: "warn" },
  { cmd: "lark-cli", args: ["--version"], label: "lark-cli", purpose: "飞书云文档 skill", severity: "warn" },
];

async function checkExternalDeps(pi: ExtensionAPI): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const TIMEOUT_MS = 3000;

  for (const dep of EXTERNAL_DEPS) {
    try {
      const result = await pi.exec(dep.cmd, dep.args ?? [], { timeout: TIMEOUT_MS });
      if (dep.versionCheck) {
        const custom = dep.versionCheck(result.stdout || "", result.stderr || "");
        if (custom) { checks.push(custom); continue; }
      }
      if (result.code === 0 || (dep.cmd === "ssh" && result.code !== 127)) {
        const version = (result.stdout || result.stderr || "").trim().split("\n")[0];
        checks.push({ severity: "pass", label: `${dep.label} 可用`, detail: version ? truncateDetail(version, 60) : dep.purpose });
      } else {
        checks.push({ severity: dep.severity, label: `${dep.label} 不可用`, detail: dep.purpose });
      }
    } catch {
      checks.push({ severity: dep.severity, label: `${dep.label} 不可用`, detail: dep.purpose });
    }
  }

  // Orca CLI: resolve executable like serial-devices does
  const orcaCli = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? "orca-dev" : "orca-ide");
  try {
    const result = await pi.exec(orcaCli, ["status", "--json"], { timeout: TIMEOUT_MS });
    checks.push(result.code === 0
      ? { severity: "pass", label: "Orca CLI 可用", detail: `${orcaCli}：Orca 分屏/worktree` }
      : { severity: "warn", label: "Orca CLI 不可用", detail: `${orcaCli}：Orca 分屏/worktree` });
  } catch {
    checks.push({ severity: "warn", label: "Orca CLI 不可用", detail: `${orcaCli}：Orca 分屏/worktree` });
  }

  // RTK is already checked by checkRtkHealth, skip here

  return checks;
}

function overallSeverity(checks: DoctorCheck[]): DoctorSeverity {
  if (checks.some((check) => check.severity === "fail")) return "fail";
  if (checks.some((check) => check.severity === "warn")) return "warn";
  return "pass";
}

function formatDoctorReport(checks: DoctorCheck[]): string {
  const status = overallSeverity(checks);
  const symbol: Record<DoctorSeverity, string> = { pass: "✓", info: "i", warn: "!", fail: "×" };
  const groups: DoctorSeverity[] = ["pass", "info", "warn", "fail"];
  const lines = [`oh-my-pi doctor: ${status}`, ""];
  for (const group of groups) {
    const items = checks.filter((check) => check.severity === group);
    if (items.length === 0) continue;
    lines.push(group);
    for (const item of items) {
      lines.push(`${symbol[group]} ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function runDoctor(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const root = packageRoot();
  const remoteDevicesSource = readRemoteDevicesSource(root);
  const checks: DoctorCheck[] = [
    await checkPackageLoads(pi, root),
    ...checkRegistration(pi),
    ...checkUsageHealth(),
    checkRemoteSeed(root),
    checkRuntimeConfigBoundary(root),
    ...checkRemoteDevicesSafetySource(remoteDevicesSource),
    ...checkRemoteDevicesUiSource(remoteDevicesSource),
    ...(await checkMineruHealth(pi)),
    ...checkTavilyHealth(pi),
    ...(await checkRtkHealth(pi)),
    ...checkUiExtensionHealth(pi),
    checkAppendSystemHealth(ctx),
    checkPiEmptyCommentsPatch(),
    checkSensitiveContent(root),
    checkSkillFrontmatter(root),
    ...(await checkExternalDeps(pi)),
  ];
  const status = overallSeverity(checks);
  ctx.ui.notify(formatDoctorReport(checks), status === "fail" ? "error" : status === "warn" ? "warning" : "info");
}

function restoreToolsFromBranch(pi: ExtensionAPI, ctx: ExtensionContext, enabledTools: Set<string>) {
  const allTools = pi.getAllTools();
  const allToolNames = allTools.map((tool) => tool.name);
  const branchEntries = ctx.sessionManager.getBranch();
  let savedTools: string[] | undefined;

  for (const entry of branchEntries) {
    if (entry.type === "custom" && entry.customType === "oh-my-pi-tools-config") {
      const data = entry.data as ToolsState | undefined;
      if (data?.enabledTools) savedTools = data.enabledTools;
    }
  }

  if (savedTools) {
    enabledTools.clear();
    for (const toolName of savedTools.filter((name) => allToolNames.includes(name))) enabledTools.add(toolName);
    pi.setActiveTools(Array.from(enabledTools));
    return;
  }

  enabledTools.clear();
  for (const toolName of pi.getActiveTools()) enabledTools.add(toolName);
}

async function showTools(pi: ExtensionAPI, ctx: ExtensionCommandContext, enabledTools: Set<string>) {
  while (true) {
    const allTools = pi.getAllTools();
    if (allTools.length === 0) {
      ctx.ui.notify("No tools registered", "info");
      return;
    }

    const selected = await ctx.ui.select("Tools", [
      ...allTools.map((tool) => getToolLabel(tool, enabledTools.has(tool.name))),
      "Done",
    ]);
    if (!selected || selected === "Done") return;

    const toolName = selected.replace(/^\[[ x]\] /, "");
    if (enabledTools.has(toolName)) enabledTools.delete(toolName);
    else enabledTools.add(toolName);

    pi.setActiveTools(Array.from(enabledTools));
    pi.appendEntry<ToolsState>("oh-my-pi-tools-config", { enabledTools: Array.from(enabledTools) });
  }
}

async function showCommands(pi: ExtensionAPI, ctx: ExtensionCommandContext, source?: "extension" | "prompt" | "skill") {
  const commands = pi.getCommands();
  const filtered = source ? commands.filter((command) => command.source === source) : commands;
  if (filtered.length === 0) {
    ctx.ui.notify(source ? `No ${source} commands found` : "No commands found", "info");
    return;
  }

  const items = filtered.map(formatCommand);
  const selected = await ctx.ui.select(source ? `${source} commands` : "Commands", items);
  if (!selected) return;

  const command = filtered.find((candidate) => candidate.name === commandNameFromItem(selected));
  if (!command) return;

  const path = command.sourceInfo?.path;
  const sourceInfo = path ? `\n\n${path}` : "";
  ctx.ui.notify(`/${command.name}\n${command.description ?? "No description"}${sourceInfo}`, "info");
}

async function showExtensions(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const extensionCommands = pi.getCommands().filter((command) => command.source === "extension");
  const paths = uniquePaths(extensionCommands);
  if (paths.length === 0) {
    ctx.ui.notify("No extension commands found", "info");
    return;
  }

  const selected = await ctx.ui.select("Extensions", paths);
  if (!selected) return;

  const commands = extensionCommands.filter((command) => command.sourceInfo?.path === selected);
  const details = commands.length > 0
    ? commands.map((command) => `/${command.name}${command.description ? ` - ${command.description}` : ""}`).join("\n")
    : "No commands registered by this extension";
  ctx.ui.notify(`${selected}\n\n${details}`, "info");
}

async function showRemoteDevices(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const remoteTools = pi.getAllTools().filter((tool) => tool.name.startsWith("remote_"));
  const remoteCommand = pi.getCommands().find((command) => command.name === "remote-devices");
  const lines = [
    remoteCommand ? `Command: /${remoteCommand.name}` : "Command: /remote-devices not loaded",
    remoteTools.length > 0 ? `Tools: ${remoteTools.map((tool) => tool.name).join(", ")}` : "Tools: none loaded",
    "Common: /remote-devices list | /remote-devices probe | /remote-devices test <device>",
  ];
  ctx.ui.notify(lines.join("\n"), remoteCommand && remoteTools.length > 0 ? "info" : "warning");
}

async function showRtkSetup(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  await showRtkAdapter(pi, ctx);
}

async function showMineru(ctx: ExtensionCommandContext, args: string) {
  await runMineruCommand(args, ctx);
}

async function showTavilyStatus(ctx: ExtensionCommandContext) {
  showTavilyPoolStatus(ctx);
}

async function runMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, item: MenuItem, args: string, enabledTools: Set<string>) {
  switch (item) {
    case "Tools":
      await showTools(pi, ctx, enabledTools);
      break;
    case "Commands":
      await showCommands(pi, ctx);
      break;
    case "Skills":
      await showCommands(pi, ctx, "skill");
      break;
    case "Extensions":
      await showExtensions(pi, ctx);
      break;
    case "Remote devices":
      await showRemoteDevices(pi, ctx);
      break;
    case "Status bar":
      showOhMyPiStatusBar(ctx);
      break;
    case "Task timer":
      showTaskTimer(ctx);
      break;
    case "Doctor":
      await runDoctor(pi, ctx);
      break;
    case "RTK setup":
      await showRtkSetup(pi, ctx);
      break;
    case "MinerU":
      await showMineru(ctx, args);
      break;
    case "Tavily status":
      await showTavilyStatus(ctx);
      break;
  }
}

export default function ohMyPiExtension(pi: ExtensionAPI) {
  const enabledTools = new Set<string>();

  pi.registerCommand("oh-my-pi", {
    description: "Open the oh-my-pi local capability console",
    getArgumentCompletions: (prefix) => {
      const values = Object.keys(ARG_ALIASES).filter((value) => value.startsWith(prefix.trim()));
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [firstArg, ...rest] = trimmed.split(/\s+/).filter(Boolean);
      const directItem = firstArg ? ARG_ALIASES[firstArg.toLowerCase()] : undefined;
      const item = directItem ?? (await ctx.ui.select("oh-my-pi", MENU_ITEMS));
      if (!item) return;

      await runMenu(pi, ctx, item, rest.join(" "), enabledTools);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreToolsFromBranch(pi, ctx, enabledTools);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreToolsFromBranch(pi, ctx, enabledTools);
  });
}
