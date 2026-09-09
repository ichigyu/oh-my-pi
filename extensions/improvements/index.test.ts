import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ImprovementStore, resetImprovementRoot, type ImprovementContext } from "./store.ts";
import { improvementsExtension, runImprovementsCommand } from "./index.ts";

function fixture() {
  return mkdtempSync(path.join(os.tmpdir(), "oh-my-pi-improvements-command-"));
}

const context: ImprovementContext = {
  goal: "读取远端配置",
  tool: "remote_exec",
  evidence: "stdout 不可见",
  gap: "tool result 缺少输出",
  recommendation: "返回 bounded stdout",
  attempts: ["remote_exec", "base64 workaround"],
};

function ui() {
  const messages: Array<{ text: string; level: string }> = [];
  return { messages, ui: { notify: (text: string, level: string) => messages.push({ text, level }) } };
}

test("registers the improvements command", () => {
  let registration: { name: string; command: { description: string } } | undefined;
  improvementsExtension({
    registerCommand(name: string, command: { description: string }) { registration = { name, command }; },
  } as never);
  assert.equal(registration?.name, "improvements");
  assert.match(registration?.command.description ?? "", /local improvement suggestions/);
});

test("lists pending suggestions and shows details", async () => {
  const root = fixture();
  try {
    const store = new ImprovementStore({ rootDir: root });
    const saved = store.save(context);
    const listed = ui();
    await runImprovementsCommand("", listed as never, store);
    assert.match(listed.messages[0]!.text, new RegExp(saved.id));
    const shown = ui();
    await runImprovementsCommand(`show ${saved.id}`, shown as never, store);
    assert.match(shown.messages[0]!.text, /Goal: 读取远端配置/);
    assert.match(shown.messages[0]!.text, /Evidence: stdout 不可见/);
  } finally {
    resetImprovementRoot(root);
  }
});

test("updates lifecycle states and handles invalid input", async () => {
  const root = fixture();
  try {
    const store = new ImprovementStore({ rootDir: root });
    const saved = store.save(context);
    const rejected = ui();
    await runImprovementsCommand(`dismiss ${saved.id}`, rejected as never, store);
    assert.equal(store.get(saved.id)?.state, "rejected");
    assert.match(rejected.messages[0]!.text, /marked rejected/);
    const invalid = ui();
    await runImprovementsCommand("resolve invalid", invalid as never, store);
    assert.equal(invalid.messages[0]!.level, "error");
    const missing = ui();
    await runImprovementsCommand("show 0000000000000000", missing as never, store);
    assert.match(missing.messages[0]!.text, /not found/);
  } finally {
    resetImprovementRoot(root);
  }
});
