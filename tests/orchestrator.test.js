import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { newRun, reduce } from "../src/state.js";
import { Store } from "../src/store.js";
import { validate } from "../src/workflows.js";
import { LfJsonl, WorkerAdapter } from "../src/worker.js";
import { Controller } from "../src/controller.js";
import { Effect, GitEffects } from "../src/effects.js";

const fenced = (run, type, extra = {}) => ({ id: `${type}-${Math.random()}`, type, generation: run.generation, lease: run.lease, ...extra });

test("dedupes commands/events, fences stale controllers, and blocks a second writer", () => {
  let run = newRun({ workflow: "fix-to-pr", cwd: "/x", authorized: true });
  const writer = fenced(run, "node-started", { node: "write", role: "writer", worker: "w1" });
  run = reduce(run, writer); assert.equal(reduce(run, writer), run);
  run = reduce(run, { ...fenced(run, "report", { node: "write", role: "writer", outcome: "ok", report: {} }), generation: 0 });
  assert.equal(run.nodes.write.status, "running");
  run = reduce(run, fenced(run, "node-started", { node: "other", role: "writer", worker: "w2" }));
  assert.equal(run.status, "waiting-human");
});

test("settled without report retries read-only once and never replays a writer", () => {
  let run = newRun({ workflow: "investigate-report", cwd: "/x" });
  run = reduce(run, fenced(run, "node-started", { node: "r", role: "reviewer", worker: "r" }));
  run = reduce(run, fenced(run, "agent-settled", { node: "r" })); assert.equal(run.nodes.r.status, "retry");
  run = reduce(run, fenced(run, "node-started", { node: "w", role: "writer", worker: "w" }));
  run = reduce(run, fenced(run, "agent-settled", { node: "w" })); assert.equal(run.status, "waiting-human");
});

test("journal replay survives a corrupt snapshot and truncated journal tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-")); const store = new Store(dir);
  let run = await store.create(newRun({ id: "run", workflow: "investigate-report", cwd: "/x" }));
  run = await store.append(run, fenced(run, "node-started", { node: "i", role: "investigator", worker: "w" }));
  await writeFile(join(dir, "run.json"), "{");
  await writeFile(join(dir, "run.jsonl"), `${await readFile(join(dir, "run.jsonl"), "utf8")}{broken`, "utf8");
  assert.equal((await store.load("run")).nodes.i.status, "running");
});

test("LF JSONL preserves U+2028/U+2029", () => {
  const got = []; const parser = new LfJsonl((x) => got.push(x));
  parser.write(Buffer.from('{"text":"a\u2028b\u2029c"}\n')); parser.end();
  assert.equal(got[0].text, "a\u2028b\u2029c");
});

test("worker has constrained argv, accepts reports, and cancels fake RPC", () => {
  let child; const events = [];
  const fakeSpawn = (_file, _args, options) => (child = Object.assign(new PassThrough(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: (signal) => { child.killed = signal; }, options }));
  const adapter = new WorkerAdapter({ stateDir: "/state", extension: "/worker.ts", spawnProcess: fakeSpawn });
  const worker = adapter.start({ id: "w", runId: "r", role: "reviewer", cwd: "/repo", policy: "read-only", model: "m" }, (e) => events.push(e));
  assert.deepEqual(adapter.argv(worker).includes("--no-extensions"), true); const tools = adapter.argv(worker).at(-1).split(","); assert.ok(tools.includes("orchestrator_report")); assert.ok(!tools.includes("write"));
  const writerTools = adapter.argv({ ...worker, role: "writer" }).at(-1).split(","); assert.ok(writerTools.includes("edit")); assert.ok(!writerTools.includes("bash"));
  child.stdout.write('{"type":"tool_execution_end","toolName":"orchestrator_report","isError":false,"result":{"details":{"node":"n"}}}\n');
  assert.equal(worker.reports.length, 1); adapter.cancel(worker); assert.equal(child.killed, "SIGTERM");
});

test("workflow validation rejects second writers, unknown gates, and unbounded parallelism", () => {
  assert.throws(() => validate([{ type: "agent", id: "a", role: "writer" }, { type: "agent", id: "b", role: "writer" }]));
  assert.throws(() => validate([{ type: "gate", gate: "unknown" }]));
  assert.throws(() => validate([{ type: "parallel", nodes: Array.from({ length: 4 }, (_, i) => ({ type: "agent", id: String(i), role: "reviewer" })) }]));
});

class FakeEffects {
  constructor() { this.calls = []; this.current = "write-head"; }
  async head() { return this.current; }
  async run(kind) {
    this.calls.push(kind);
    if (kind === Effect.COMMIT) return { head: this.current, paths: ["src/change.js"] };
    if (kind === Effect.REBASE) { this.current = "rebased-head"; return { head: this.current }; }
    if (kind === Effect.PUBLISH_PR) return { pr: "https://example.test/pr/1", ci: "pending" };
    return { checked: true };
  }
}
function fakeWorkers(stateDir) {
  let n = 0; const spawned = [];
  const spawn = () => { const child = { stdin: { write() {} }, stdout: new PassThrough(), stderr: new PassThrough(), kill() {} }; return child; };
  const adapter = new WorkerAdapter({ stateDir, spawnProcess: spawn });
  const original = adapter.start.bind(adapter); adapter.start = (...args) => { const w = original(...args); w.id = `w${++n}`; spawned.push(w); return w; };
  return { adapter, spawned };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("timed out waiting for controller");
}

test("fake-repo fix flow enforces checks/rebase/exact-head review then publishes unmerged PR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-e2e-")); const effects = new FakeEffects(); const { adapter, spawned } = fakeWorkers(dir);
  const ctl = new Controller({ store: new Store(dir), workers: adapter, effects, token: () => "abcdefgh" });
  await ctl.start({ workflow: "fix-to-pr", cwd: "/fake", authorized: true }); await ctl.pump();
  for (const expected of ["writer", "reviewer", "reviewer"]) {
    const worker = spawned.at(-1); assert.equal(worker.role, expected);
    const node = Object.entries(ctl.run.nodes).find(([, value]) => value.worker === worker.id && value.status === "running")?.[0];
    assert.ok(node);
    worker.child.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "orchestrator_report", isError: false, result: { details: { node, generation: ctl.run.generation, token: worker.token, role: worker.role, outcome: "ok", summary: "done" } } })}\n`);
    await until(() => ctl.run.status !== "running" || Object.entries(ctl.run.nodes).some(([key, value]) => key !== node && value.status === "running"));
  }
  assert.equal(ctl.run.status, "done"); assert.equal(ctl.run.ci, "pending");
  assert.deepEqual(effects.calls, [Effect.COMMIT, Effect.CHECKS, Effect.REBASE, Effect.CHECKS, Effect.PUBLISH_PR]);
  assert.equal(ctl.run.nodes.review.head, "write-head"); assert.equal(ctl.run.nodes["review-head"].head, "rebased-head"); await ctl.close();
});

test("unknown push/PR is never auto-replayed and unsafe effects are unconstructable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-unknown-"));
  const effects = { async run() { throw new Error("lost response after push"); } };
  const ctl = new Controller({ store: new Store(dir), workers: fakeWorkers(dir).adapter, effects });
  await ctl.start({ workflow: "fix-to-pr", cwd: "/fake", authorized: true });
  await ctl.event(ctl.fenced("effect-started", { effect: "publish", kind: Effect.PUBLISH_PR })); await ctl.effect({ id: "publish", effect: "publish-pr" });
  assert.equal(ctl.run.status, "waiting-human"); assert.deepEqual(Object.values(Effect), ["commit", "checks", "rebase", "publish-pr"]);
  for (const forbidden of ["merge", "deploy", "prod", "data", "message", "migration", "backfill"]) {
    assert.ok(!Object.values(Effect).includes(forbidden));
    assert.equal(typeof GitEffects.prototype[forbidden], "undefined");
  }
  await ctl.close();
});
