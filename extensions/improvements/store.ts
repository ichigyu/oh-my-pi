import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const IMPROVEMENT_SCHEMA_VERSION = 1;
export const IMPROVEMENT_STATES = ["pending", "resolved", "rejected", "duplicate"] as const;
export type ImprovementState = typeof IMPROVEMENT_STATES[number];

export type ImprovementContext = {
  goal: string;
  capability?: string;
  tool?: string;
  skill?: string;
  extension?: string;
  parameters?: unknown;
  evidence?: string;
  attempts?: string[];
  gap?: string;
  recommendation?: string;
  sessionId?: string;
  taskId?: string;
  projectPath?: string;
};

export type ImprovementSuggestion = {
  schemaVersion: typeof IMPROVEMENT_SCHEMA_VERSION;
  id: string;
  state: ImprovementState;
  createdAt: string;
  updatedAt: string;
  context: ImprovementContext;
};

export type ImprovementStoreOptions = {
  rootDir?: string;
  now?: () => Date;
};

const DEFAULT_ROOT_DIR = path.join(os.homedir(), ".pi", "agent", "improvement-suggestions");
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|credential|private[-_]?key|authorization|cookie)/i;
const SECRET_VALUE = /(bearer\s+|gh[opsu]_|sk-[a-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|-----BEGIN [^-]+ PRIVATE KEY-----)/i;
const PRIVATE_HOST = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/g;

export function improvementRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OH_MY_PI_IMPROVEMENT_STATE_DIR || DEFAULT_ROOT_DIR;
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) return "[REDACTED]";
    return value.replace(PRIVATE_HOST, "[PRIVATE_HOST]");
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]));
  }
  return value;
}

export function redactImprovementContext(context: ImprovementContext): ImprovementContext {
  return redactValue(context) as ImprovementContext;
}

function validateContext(value: unknown): value is ImprovementContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return typeof context.goal === "string" && context.goal.trim().length > 0
    && (!context.attempts || (Array.isArray(context.attempts) && context.attempts.every((item) => typeof item === "string")));
}

export function validateSuggestion(value: unknown): value is ImprovementSuggestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const suggestion = value as Record<string, unknown>;
  return suggestion.schemaVersion === IMPROVEMENT_SCHEMA_VERSION
    && typeof suggestion.id === "string" && /^[a-f0-9]{16}$/.test(suggestion.id)
    && typeof suggestion.createdAt === "string" && !Number.isNaN(Date.parse(suggestion.createdAt))
    && typeof suggestion.updatedAt === "string" && !Number.isNaN(Date.parse(suggestion.updatedAt))
    && typeof suggestion.state === "string" && (IMPROVEMENT_STATES as readonly string[]).includes(suggestion.state)
    && validateContext(suggestion.context);
}

function suggestionId(context: ImprovementContext, createdAt: string): string {
  return createHash("sha256").update(JSON.stringify({ context, createdAt })).digest("hex").slice(0, 16);
}

function ensureRoot(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  chmodSync(rootDir, 0o700);
}

function filePath(rootDir: string, id: string): string {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error(`Invalid improvement suggestion id: ${id}`);
  return path.join(rootDir, `${id}.json`);
}

export class ImprovementStore {
  readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: ImprovementStoreOptions = {}) {
    this.rootDir = options.rootDir ?? improvementRootDir();
    this.now = options.now ?? (() => new Date());
  }

  save(context: ImprovementContext): ImprovementSuggestion {
    if (!validateContext(context)) throw new Error("Improvement suggestion requires a non-empty goal");
    const createdAt = this.now().toISOString();
    const safeContext = redactImprovementContext(context);
    const suggestion: ImprovementSuggestion = {
      schemaVersion: IMPROVEMENT_SCHEMA_VERSION,
      id: suggestionId(safeContext, createdAt),
      state: "pending",
      createdAt,
      updatedAt: createdAt,
      context: safeContext,
    };
    ensureRoot(this.rootDir);
    this.write(suggestion);
    return suggestion;
  }

  get(id: string): ImprovementSuggestion | undefined {
    const target = filePath(this.rootDir, id);
    if (!existsSync(target)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(target, "utf8"));
    } catch (error) {
      throw new Error(`Invalid improvement suggestion ${id}: ${(error as Error).message}`);
    }
    if (!validateSuggestion(parsed)) throw new Error(`Invalid improvement suggestion ${id}: schema validation failed`);
    return parsed;
  }

  list(state?: ImprovementState): ImprovementSuggestion[] {
    if (!existsSync(this.rootDir)) return [];
    const suggestions = readdirSync(this.rootDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .flatMap((id) => {
        try {
          const suggestion = this.get(id);
          return suggestion ? [suggestion] : [];
        } catch {
          return [];
        }
      });
    return suggestions
      .filter((suggestion) => !state || suggestion.state === state)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  updateState(id: string, state: ImprovementState): ImprovementSuggestion {
    if (!(IMPROVEMENT_STATES as readonly string[]).includes(state)) throw new Error(`Invalid improvement suggestion state: ${state}`);
    const suggestion = this.get(id);
    if (!suggestion) throw new Error(`Improvement suggestion not found: ${id}`);
    const updated = { ...suggestion, state, updatedAt: this.now().toISOString() };
    this.write(updated);
    return updated;
  }

  remove(id: string): void {
    rmSync(filePath(this.rootDir, id), { force: true });
  }

  private write(suggestion: ImprovementSuggestion): void {
    ensureRoot(this.rootDir);
    const target = filePath(this.rootDir, suggestion.id);
    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(suggestion, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, target);
      chmodSync(target, 0o600);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* preserve the original write error */ }
      throw new Error(`Failed to persist improvement suggestion ${suggestion.id}: ${(error as Error).message}`);
    }
  }
}

export function suggestionFileMode(file: string): number {
  return statSync(file).mode & 0o777;
}

export function resetImprovementRoot(rootDir: string): void {
  rmSync(rootDir, { recursive: true, force: true });
}
