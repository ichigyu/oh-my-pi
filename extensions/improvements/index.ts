import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { IMPROVEMENT_STATES, ImprovementStore, type ImprovementState, type ImprovementSuggestion } from "./store.ts";

const ACTIONS = ["show", "resolve", "reject", "dismiss", "duplicate"] as const;

type Action = typeof ACTIONS[number];

function stateFromAction(action: Action): ImprovementState | undefined {
  if (action === "resolve") return "resolved";
  if (action === "reject" || action === "dismiss") return "rejected";
  if (action === "duplicate") return "duplicate";
  return undefined;
}

function summary(suggestion: ImprovementSuggestion): string {
  const { context } = suggestion;
  return `${suggestion.id} [${suggestion.state}] ${context.tool ?? context.skill ?? context.extension ?? "capability"}: ${context.goal}`;
}

function details(suggestion: ImprovementSuggestion): string {
  const context = suggestion.context;
  return [
    `ID: ${suggestion.id}`,
    `State: ${suggestion.state}`,
    `Created: ${suggestion.createdAt}`,
    `Updated: ${suggestion.updatedAt}`,
    `Tool: ${context.tool ?? "none"}`,
    `Skill: ${context.skill ?? "none"}`,
    `Extension: ${context.extension ?? "none"}`,
    `Goal: ${context.goal}`,
    `Evidence: ${context.evidence ?? "none"}`,
    `Attempts: ${context.attempts?.join("; ") ?? "none"}`,
    `Gap: ${context.gap ?? "none"}`,
    `Recommendation: ${context.recommendation ?? "none"}`,
  ].join("\n");
}

function usage(): string {
  return "Usage: /improvements [show <id> | resolve <id> | reject <id> | dismiss <id> | duplicate <id>]";
}

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}

export async function runImprovementsCommand(args: string, ctx: ExtensionCommandContext, store = new ImprovementStore()): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    try {
      const pending = store.list("pending");
      ctx.ui.notify(pending.length === 0 ? "No pending improvement suggestions." : pending.map(summary).join("\n"), "info");
    } catch (error) {
      notifyError(ctx, error);
    }
    return;
  }

  const action = tokens[0] as Action;
  if (!ACTIONS.includes(action) || tokens.length !== 2) {
    ctx.ui.notify(usage(), "warning");
    return;
  }

  const id = tokens[1]!;
  try {
    const suggestion = action === "show"
      ? store.get(id)
      : store.updateState(id, stateFromAction(action)!);
    if (!suggestion) {
      ctx.ui.notify(`Improvement suggestion not found: ${id}`, "warning");
      return;
    }
    ctx.ui.notify(action === "show" ? details(suggestion) : `Improvement suggestion ${id} marked ${suggestion.state}.`, "info");
  } catch (error) {
    notifyError(ctx, error);
  }
}

export function improvementsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("improvements", {
    description: "List and manage local improvement suggestions",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trim().toLowerCase();
      const matches = ACTIONS.filter((action) => action.startsWith(value));
      return matches.length ? matches.map((action) => ({ value: action, label: action })) : null;
    },
    handler: async (args, ctx) => runImprovementsCommand(args, ctx),
  });
}

export default improvementsExtension;

export { IMPROVEMENT_STATES };
