import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ImprovementStore,
  IMPROVEMENT_SCHEMA_VERSION,
  resetImprovementRoot,
  suggestionFileMode,
  type ImprovementContext,
} from "./store.ts";

function fixture() {
  return mkdtempSync(path.join(os.tmpdir(), "oh-my-pi-improvements-"));
}

function context(): ImprovementContext {
  return {
    goal: "读取远端配置并继续任务",
    tool: "remote_exec",
    parameters: { command: "cat config", token: "secret-value", host: "192.168.1.20" },
    evidence: "stdout 不可见，重复执行 cat",
    attempts: ["remote_exec", "base64 workaround"],
    gap: "tool result 没有把输出提供给 model",
    recommendation: "让 tool 返回 bounded stdout",
    projectPath: "/home/user/project",
  };
}

test("saves versioned, private, redacted suggestions", () => {
  const root = fixture();
  try {
    const store = new ImprovementStore({ rootDir: root, now: () => new Date("2026-09-09T00:00:00.000Z") });
    const saved = store.save(context());
    assert.equal(saved.schemaVersion, IMPROVEMENT_SCHEMA_VERSION);
    assert.equal(saved.state, "pending");
    assert.equal(saved.context.parameters && (saved.context.parameters as Record<string, unknown>).token, "[REDACTED]");
    assert.equal(saved.context.parameters && (saved.context.parameters as Record<string, unknown>).host, "[PRIVATE_HOST]");
    const file = path.join(root, `${saved.id}.json`);
    assert.equal(suggestionFileMode(file), 0o600);
    assert.equal((JSON.parse(readFileSync(file, "utf8")) as { context: { parameters: { token: string } } }).context.parameters.token, "[REDACTED]");
  } finally {
    resetImprovementRoot(root);
  }
});

test("lists suggestions and updates lifecycle state", () => {
  const root = fixture();
  try {
    const store = new ImprovementStore({ rootDir: root, now: () => new Date("2026-09-09T00:00:00.000Z") });
    const saved = store.save(context());
    assert.equal(store.list("pending").length, 1);
    const updated = store.updateState(saved.id, "resolved");
    assert.equal(updated.state, "resolved");
    assert.equal(store.list("pending").length, 0);
    assert.equal(store.get(saved.id)?.state, "resolved");
  } finally {
    resetImprovementRoot(root);
  }
});

test("list skips malformed records while get reports the corruption", () => {
  const root = fixture();
  try {
    const store = new ImprovementStore({ rootDir: root });
    writeFileSync(path.join(root, "aaaaaaaaaaaaaaaa.json"), "not json");
    assert.deepEqual(store.list(), []);
    assert.throws(() => store.get("aaaaaaaaaaaaaaaa"), /Invalid improvement suggestion/);
  } finally {
    resetImprovementRoot(root);
  }
});

test("does not create the state directory until a suggestion is saved", () => {
  const root = path.join(fixture(), "nested");
  const store = new ImprovementStore({ rootDir: root });
  assert.deepEqual(store.list(), []);
  assert.equal(store.rootDir, root);
  resetImprovementRoot(path.dirname(root));
});

test("rejects malformed and missing suggestions", () => {
  const root = fixture();
  try {
    const store = new ImprovementStore({ rootDir: root });
    assert.throws(() => store.save({ goal: "" }), /non-empty goal/);
    assert.equal(store.get("0000000000000000"), undefined);
    writeFileSync(path.join(root, "aaaaaaaaaaaaaaaa.json"), "not json");
    assert.throws(() => store.get("aaaaaaaaaaaaaaaa"), /Invalid improvement suggestion/);
  } finally {
    resetImprovementRoot(root);
  }
});
