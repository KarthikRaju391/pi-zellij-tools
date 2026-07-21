import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.js";
import { Controller } from "../src/controller.js";
import { Effect } from "../src/effects.js";
import { newRun, reduce, validateSpec } from "../src/state.js";
import { Lease, Store } from "../src/store.js";
import { WorkerAdapter } from "../src/worker.js";
import { workflow } from "../src/workflows.js";

const readSpec = (overrides = {}) => validateSpec({ taskKey: `read-${Math.random()}`, objective: "Inspect", cwd: "/work", ...overrides }, "investigate-report");
const fixSpec = (overrides = {}) => validateSpec({ taskKey: `fix-${Math.random()}`, objective: "Fix", cwd: "/work", remote: "origin", base: "main", branch: "topic", paths: ["src"], checks: [["node", "--test"]], authorization: { edit: true, pr: true }, ...overrides }, "fix-to-pr");
const fenced = (run, type, extra = {}) => ({ id: `${type}-${Math.random()}`, type, generation: run.generation, lease: run.lease, ...extra });
const ready = async (predicate) => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error("timed out"); };

function fakeWorkers(dir, operations = [], { autoExit = true, shutdownTimeout = 50 } = {}) {
  const started = [];
  const adapter = new WorkerAdapter({ stateDir: dir, shutdownTimeout, spawnProcess: () => {
    const child = new EventEmitter(); Object.assign(child, { pid: 7000 + started.length, stdin: { write() {} }, stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
    child.kill = () => { child.killed = true; operations.push("worker-killed"); if (autoExit) child.emit("exit", 0, "SIGTERM"); };
    return child;
  } });
  const start = adapter.start.bind(adapter); adapter.start = (...args) => { const worker = start(...args); started.push(worker); return worker; };
  adapter.bindAndPrompt = async () => ({ success: true });
  return { adapter, started };
}
const report = (ctl, worker, node, outcome = "ok") => worker.child.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "orchestrator_report", isError: false, result: { details: { node, generation: ctl.run.generation, token: worker.token, role: worker.role, outcome, summary: outcome } } })}\n`);

const effects = { async preflight() {}, async head() { return "head"; }, async assertClean() {}, async run(kind) { if (kind === Effect.COMMIT) return { head: "head" }; return { checked: 1 }; } };
const reviewPrereqs = () => ({ commit: { kind: Effect.COMMIT, status: "ok", result: { head: "head" } }, "checks-before-review": { kind: Effect.CHECKS, status: "ok" } });

test("active cancellation keeps its worktree claimed until the writer exits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cancel-active-")); const operations = [];
  class TrackingStore extends Store { async append(run, event) { const next = await super.append(run, event); if (["cancelling", "cancel"].includes(event.type)) operations.push(`${event.type}-journaled`); return next; } }
  const store = new TrackingStore(dir); const { adapter, started } = fakeWorkers(dir, operations, { autoExit: false });
  const ctl = new Controller({ store, workers: adapter, effectsFor: () => effects, cancelPollMs: 10000 });
  await ctl.start({ workflow: "fix-to-pr", spec: fixSpec({ taskKey: "active-cancel" }) }); await ctl.pump();
  const request = await store.requestCancel(ctl.run.id, "stop"); await ctl.pollCancelRequest();
  await ready(() => ctl.run.status === "cancelling" && started[0].child.killed);
  assert.deepEqual(operations, ["cancelling-journaled", "worker-killed"]);
  await assert.rejects(store.claim("replacement", ctl.run.cwd, "replacement"), /active claim/);
  assert.equal((await store.readCancel(ctl.run.id)).id, request.id);

  started[0].child.emit("exit", 0, "SIGTERM"); await ctl.pollCancelRequest();
  await ready(async () => ctl.run.status === "cancelled" && !(await store.readCancel(ctl.run.id)));
  assert.deepEqual(operations, ["cancelling-journaled", "worker-killed", "cancel-journaled"]);
  for (const file of store.claimFiles(ctl.run.taskKey, ctl.run.cwd)) await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
});

test("CLI cancel takes an idle waiting-human lease, cancels durably, and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cancel-idle-")); const store = new Store(dir); const run = newRun({ workflow: "investigate-report", spec: readSpec({ taskKey: "idle-cancel" }) });
  await store.claim(run.taskKey, run.cwd, run.id); let persisted = await store.create(run); persisted = await store.append(persisted, fenced(persisted, "recovery-wait", { reason: "investigate-failed" }));
  const { adapter, started } = fakeWorkers(dir); const output = [];
  const options = { storeFactory: () => store, workersFactory: () => adapter, write: (text) => output.push(JSON.parse(text)) };
  assert.equal(await main(["cancel", run.id, "--state-dir", dir], options), 0);
  assert.equal((await store.load(run.id)).status, "cancelled"); assert.equal(started.length, 0); assert.equal(output[0].status, "cancelled");
  for (const file of store.claimFiles(run.taskKey, run.cwd)) await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
  assert.equal(await store.readCancel(run.id), undefined);
  assert.equal(await main(["cancel", run.id, "--state-dir", dir], options), 0);
  const journal = await readFile(join(dir, `${run.id}.jsonl`), "utf8"); assert.equal(journal.split("\n").filter((line) => line.includes('"type":"cancel"')).length, 1);
});

test("a cancellation request waits for an in-flight effect before stopping workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cancel-effect-")); const { adapter, started } = fakeWorkers(dir, [], { autoExit: false }); let resolveEffect; let firstEffect = true; const effectsFor = () => ({ async preflight() {}, async head() { return "head"; }, async run() { if (firstEffect) { firstEffect = false; return new Promise((resolve) => { resolveEffect = resolve; }); } return { checked: 1 }; } });
  const store = new Store(dir); const ctl = new Controller({ store, workers: adapter, effectsFor, cancelPollMs: 10000 });
  await ctl.start({ workflow: "fix-to-pr", spec: fixSpec({ taskKey: "effect-cancel" }) }); await ctl.pump(); report(ctl, started[0], "write");
  await ready(() => Boolean(resolveEffect)); const request = await store.requestCancel(ctl.run.id, "stop after effect"); const pending = ctl.pollCancelRequest();
  await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(ctl.run.status, "running"); await assert.rejects(store.claim("replacement", ctl.run.cwd, "replacement"), /active claim/);
  resolveEffect({ head: "head" }); await pending; await ready(() => ctl.run.status === "cancelling" && started.every((worker) => worker.child.killed));
  for (const worker of started) worker.child.emit("exit", 0, "SIGTERM"); await ctl.pollCancelRequest(); await ready(async () => ctl.run.status === "cancelled" && !(await store.readCancel(ctl.run.id)));
  assert.equal(request.runId, ctl.run.id);
});

test("a shutdown timeout retains cancelling state and claims until a late exit retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cancel-timeout-")); const store = new Store(dir); const { adapter, started } = fakeWorkers(dir, [], { autoExit: false, shutdownTimeout: 10 });
  const ctl = new Controller({ store, workers: adapter, effectsFor: () => effects, cancelPollMs: 10000 }); await ctl.start({ workflow: "investigate-report", spec: readSpec({ taskKey: "timeout-cancel" }) }); await ctl.pump();
  const request = await store.requestCancel(ctl.run.id, "stop"); await ctl.pollCancelRequest();
  assert.equal(ctl.run.status, "cancelling"); await assert.rejects(store.claim("replacement", ctl.run.cwd, "replacement"), /active claim/);
  started[0].child.emit("exit", 0, "SIGTERM"); await ctl.pollCancelRequest();
  assert.equal(ctl.run.status, "cancelled"); assert.equal(await store.readCancel(ctl.run.id), undefined); assert.equal(request.runId, ctl.run.id);
});

test("completion stays closing across a controller crash until its persisted worker group exits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "done-close-")); let alive = true; const store = new Store(dir, { workerAlive: async () => alive }); const { adapter, started } = fakeWorkers(dir, [], { autoExit: false, shutdownTimeout: 10 });
  const ctl = new Controller({ store, workers: adapter, effectsFor: () => effects }); await ctl.start({ workflow: "investigate-report", spec: readSpec({ taskKey: "done-close" }) }); await ctl.pump(); report(ctl, started[0], "investigate");
  await ready(() => ctl.run.status === "closing" && started[0].child.killed); assert.equal((await store.load(ctl.run.id)).status, "closing"); await assert.rejects(store.claim("replacement", ctl.run.cwd, "replacement"), /active claim/);

  ctl.stopCancelWatcher(); await ctl.lease.release(); // Simulate the timed-out controller dying without releasing its claim.
  const resumed = new Controller({ store, workers: { async shutdown() {} }, effectsFor: () => effects }); await resumed.resume(ctl.run.id);
  assert.equal(resumed.run.status, "closing"); await assert.rejects(store.claim("replacement", resumed.run.cwd, "replacement"), /active claim/);
  alive = false; await resumed.recover(); assert.equal(resumed.run.status, "done");
  await store.claim("replacement", resumed.run.cwd, "replacement");
});

test("abandon records closing before failed and retains claims after shutdown failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abandon-close-")); let alive = true; const store = new Store(dir, { workerAlive: async () => alive });
  let run = newRun({ workflow: "investigate-report", spec: readSpec({ taskKey: "abandon-close" }) }); run.status = "waiting-human"; run.nodes.investigate = { role: "investigator", status: "failed", pid: 9911 }; await store.claim(run.taskKey, run.cwd, run.id); run = await store.create(run);
  const ctl = new Controller({ store, workers: { async shutdown() { throw new Error("timed out"); } }, effectsFor: () => effects }); ctl.run = run; ctl.plan = workflow(run.workflow);
  await ctl.reconcile("investigate", "abandon"); assert.equal(ctl.run.status, "closing"); assert.equal((await store.load(run.id)).status, "closing"); await assert.rejects(store.claim("replacement", run.cwd, "replacement"), /active claim/);
  alive = false; ctl.workers = { async shutdown() {} }; await ctl.recover(); assert.equal(ctl.run.status, "failed"); await store.claim("replacement", run.cwd, "replacement");
});

test("a failed lease contender cannot release the active owner's lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cancel-lease-")); const first = new Lease(dir, "run"); const second = new Lease(dir, "run");
  await first.acquire(1); await assert.rejects(second.acquire(2), /already held/); await second.release();
  assert.match(await readFile(join(dir, "run.lease"), "utf8"), new RegExp(`^${process.pid}:1:`)); await first.release();
});

test("SIGINT and SIGTERM journal cancellation before foreground workers close", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const dir = await mkdtemp(join(tmpdir(), "cancel-signal-")); const operations = [];
    class TrackingStore extends Store { async append(run, event) { const next = await super.append(run, event); if (["cancelling", "cancel"].includes(event.type)) operations.push(`${event.type}-journaled`); return next; } }
    const store = new TrackingStore(dir); const { adapter } = fakeWorkers(dir, operations); const ctl = new Controller({ store, workers: adapter, effectsFor: () => ({}) });
    await ctl.start({ workflow: "investigate-report", spec: readSpec({ taskKey: `signal-${signal}` }) }); await ctl.pump();
    const processLike = new EventEmitter(); processLike.exitCode = 0; ctl.installSignalHandlers(processLike); processLike.emit(signal); await ctl.signalPromise;
    assert.equal((await store.load(ctl.run.id)).status, "cancelled"); assert.deepEqual(operations.slice(0, 3), ["cancelling-journaled", "worker-killed", "cancel-journaled"]); assert.equal(processLike.exitCode, signal === "SIGINT" ? 130 : 143);
  }
});

test("approve reducer retries only complete sets of safe read-only nodes", () => {
  const allowed = newRun({ workflow: "investigate-report", spec: readSpec() }); allowed.status = "waiting-human"; allowed.reason = "investigate-failed"; allowed.nodes.investigate = { role: "investigator", status: "failed", attempts: 0 };
  const approved = reduce(allowed, fenced(allowed, "approve-read-only", { nodes: ["investigate"] })); assert.equal(approved.status, "running"); assert.equal(approved.nodes.investigate.status, "retry");

  const unsafe = [];
  const writer = newRun({ workflow: "fix-to-pr", spec: fixSpec() }); writer.status = "waiting-human"; writer.nodes = { write: { role: "writer", status: "running" }, review: { role: "reviewer", status: "failed" } }; unsafe.push(writer);
  const effect = newRun({ workflow: "fix-to-pr", spec: fixSpec() }); effect.status = "waiting-human"; effect.nodes = { write: { role: "writer", status: "ok" }, review: { role: "reviewer", status: "failed" } }; effect.effects = { commit: { kind: Effect.COMMIT, status: "started" } }; unsafe.push(effect);
  const stale = newRun({ workflow: "fix-to-pr", spec: fixSpec() }); stale.status = "waiting-human"; stale.reason = "final-review-head-stale"; stale.nodes = { write: { role: "writer", status: "ok" }, review: { role: "reviewer", status: "failed", head: "old" } }; stale.effects = reviewPrereqs(); unsafe.push(stale);
  const missingPrior = newRun({ workflow: "fix-to-pr", spec: fixSpec() }); missingPrior.status = "waiting-human"; missingPrior.nodes = { write: { role: "writer", status: "ok" }, review: { role: "reviewer", status: "failed" } }; unsafe.push(missingPrior);
  for (const run of unsafe) { const next = reduce(run, fenced(run, "approve-read-only", { nodes: ["review"] })); assert.equal(next.status, "waiting-human"); }
});

test("CLI approve dispatches an allowed read-only retry and still requires a structured report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "approve-cli-")); const store = new Store(dir); const run = newRun({ workflow: "investigate-report", spec: readSpec({ taskKey: "approve-read" }) });
  run.status = "waiting-human"; run.reason = "investigate-failed"; run.nodes.investigate = { role: "investigator", status: "failed", attempts: 0 };
  await store.claim(run.taskKey, run.cwd, run.id); await store.create(run);
  const { adapter, started } = fakeWorkers(dir); const output = [];
  const code = await main(["approve", run.id, "--state-dir", dir], { storeFactory: () => store, workersFactory: () => adapter, write: (text) => output.push(JSON.parse(text)) });
  assert.equal(code, 0); assert.equal(started.length, 1); assert.equal(started[0].role, "investigator");
  const retried = await store.load(run.id); assert.equal(retried.status, "running"); assert.equal(retried.nodes.investigate.status, "running"); assert.equal(retried.nodes.investigate.report, undefined); assert.equal(output[0].status, "running");
});

test("approve permits an exact-head reviewer retry only after all prior gates completed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "approve-reviewer-")); const store = new Store(dir); const run = newRun({ workflow: "fix-to-pr", spec: fixSpec() });
  run.status = "waiting-human"; run.reason = "reviewer-must-approve-or-request-changes"; run.nodes = { write: { role: "writer", status: "ok" }, review: { role: "reviewer", status: "failed", head: "head" } }; run.effects = reviewPrereqs();
  const ctl = new Controller({ store, workers: fakeWorkers(dir).adapter, effectsFor: () => effects }); ctl.run = await store.create(run); ctl.effects = effects; ctl.plan = workflow("fix-to-pr");
  await ctl.approve(); assert.equal(ctl.run.status, "running"); assert.equal(ctl.run.nodes.review.status, "retry"); assert.deepEqual(ctl.run.effects, reviewPrereqs());
});

test("approve rejects writer/effect uncertainty, stale heads, dirty trees, and later-gate bypass", async () => {
  const cases = [
    { name: "writer", nodes: { write: { role: "writer", status: "running" }, review: { role: "reviewer", status: "failed", head: "head" } }, effects: {}, error: /writer/ },
    { name: "missing-writer", nodes: { review: { role: "reviewer", status: "failed", head: "head" } }, effects: {}, error: /writer/ },
    ...[Effect.COMMIT, Effect.REBASE, Effect.PUBLISH_PR].map((kind) => ({ name: kind, nodes: { write: { role: "writer", status: "ok" }, review: { role: "reviewer", status: "failed", head: "head" } }, effects: { ...reviewPrereqs(), uncertain: { kind, status: "started" } }, error: /effect uncertainty/ })),
    { name: "stale", reason: "final-review-head-stale", nodes: { write: { role: "writer", status: "ok" }, "review-head": { role: "reviewer", status: "running", head: "old" } }, effects: {}, error: /final-head/ },
    { name: "unfinished-prior", nodes: { write: { role: "writer", status: "ok" }, review: { role: "reviewer", status: "failed", head: "head" } }, effects: {}, error: /unfinished prior gate/ },
    { name: "later", nodes: { write: { role: "writer", status: "ok" }, review: { role: "reviewer", status: "failed", head: "head" } }, effects: { ...reviewPrereqs(), rebase: { kind: Effect.REBASE, status: "ok" } }, error: /later gate/ },
  ];
  for (const item of cases) {
    const dir = await mkdtemp(join(tmpdir(), `approve-${item.name}-`)); const store = new Store(dir); const run = newRun({ workflow: "fix-to-pr", spec: fixSpec() });
    run.status = "waiting-human"; run.reason = item.reason ?? "review-failed"; run.nodes = item.nodes; run.effects = item.effects; await store.create(run);
    const ctl = new Controller({ store, workers: fakeWorkers(dir).adapter, effectsFor: () => effects }); ctl.run = run; ctl.effects = effects; ctl.plan = workflow("fix-to-pr");
    await assert.rejects(ctl.approve(), item.error); assert.equal((await store.load(run.id)).status, "waiting-human");
  }

  const dir = await mkdtemp(join(tmpdir(), "approve-dirty-")); const store = new Store(dir); const run = newRun({ workflow: "fix-to-pr", spec: fixSpec() });
  run.status = "waiting-human"; run.reason = "review-failed"; run.nodes = { write: { role: "writer", status: "ok" }, review: { role: "reviewer", status: "failed", head: "head" } }; run.effects = reviewPrereqs(); await store.create(run);
  const dirty = { async head() { return "head"; }, async assertClean() { throw new Error("dirty tree"); } }; const ctl = new Controller({ store, workers: fakeWorkers(dir).adapter, effectsFor: () => dirty }); ctl.run = run; ctl.effects = dirty; ctl.plan = workflow("fix-to-pr");
  await assert.rejects(ctl.approve(), /dirty tree/); assert.equal((await store.load(run.id)).status, "waiting-human");
});

test("CLI approve rejects an interrupted writer without dispatching another worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "approve-cli-writer-")); const store = new Store(dir); const run = newRun({ workflow: "fix-to-pr", spec: fixSpec() });
  run.status = "waiting-human"; run.reason = "writer-interrupted"; run.nodes.write = { role: "writer", status: "running" }; await store.create(run);
  const { adapter, started } = fakeWorkers(dir);
  await assert.rejects(main(["approve", run.id, "--state-dir", dir], { storeFactory: () => store, workersFactory: () => adapter, controllerFactory: ({ store: value, workers }) => new Controller({ store: value, workers, effectsFor: () => effects }) }), /writer/);
  assert.equal(started.length, 0); assert.equal((await store.load(run.id)).status, "waiting-human");
});
