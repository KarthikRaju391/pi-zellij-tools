import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Controller } from "../src/controller.js";
import { Effect } from "../src/effects.js";
import { newRun, validateSpec } from "../src/state.js";
import { Store } from "../src/store.js";
import { WorkerAdapter, roleRoute } from "../src/worker.js";
import { workflow } from "../src/workflows.js";

const fixSpec = (overrides = {}) => validateSpec({ taskKey: `fix-${Math.random()}`, objective: "Fix safely", cwd: "/work", remote: "origin", base: "main", branch: "topic", paths: ["src"], checks: [["node", "--test"]], authorization: { edit: true, pr: true }, ...overrides }, "fix-to-pr");
const readSpec = (overrides = {}) => ({ taskKey: `read-${Math.random()}`, objective: "Inspect", cwd: "/work", ...overrides });
const ready = async (predicate) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error("timed out"); };

function fakeWorkers(dir) {
  const started = [];
  const adapter = new WorkerAdapter({ stateDir: dir, spawnProcess: () => { const child = new EventEmitter(); Object.assign(child, { pid: 4242 + started.length, stdin: { write() {} }, stdout: new PassThrough(), stderr: new PassThrough() }); child.kill = () => child.emit("exit", 0, "SIGTERM"); return child; } });
  const start = adapter.start.bind(adapter);
  adapter.start = (...args) => { const worker = start(...args); started.push(worker); return worker; };
  adapter.bindAndPrompt = async () => ({ success: true });
  return { adapter, started };
}

function report(ctl, worker, node, outcome, extra = {}) {
  worker.child.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "orchestrator_report", isError: false, result: { details: { node, generation: ctl.run.generation, token: worker.token, role: worker.role, outcome, summary: outcome, ...extra } } })}\n`);
}

function readyForPr(run, publish) {
  run.nodes = {
    write: { role: "writer", status: "ok", head: "commit-a" },
    review: { role: "reviewer", status: "approved", head: "commit-a" },
    "review-head": { role: "reviewer", status: "approved", head: "approved-a" },
  };
  run.effects = {
    commit: { status: "ok", kind: Effect.COMMIT, result: { head: "commit-a" } },
    "checks-before-review": { status: "ok", kind: Effect.CHECKS },
    rebase: { status: "ok", kind: Effect.REBASE, result: { head: "approved-a" } },
    "checks-after-rebase": { status: "ok", kind: Effect.CHECKS },
    ...(publish ? { "pr-reconcile": { status: "ok", kind: Effect.RECONCILE_PR, result: { existing: null } } } : {}),
  };
  return run;
}

test("reconcile and publish both durably stop before their effect when final HEAD changed or cannot be read", async () => {
  for (const publish of [false, true]) for (const headFailure of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), "review-gate-")); const store = new Store(dir);
    const run = await store.create(readyForPr(newRun({ workflow: "fix-to-pr", spec: fixSpec() }), publish)); const calls = [];
    const effects = { async head() { if (headFailure) throw new Error("head unavailable"); return "changed-b"; }, async run(kind) { calls.push(kind); } };
    const ctl = new Controller({ store, workers: { shutdown() {} } }); ctl.run = run; ctl.effects = effects; ctl.plan = workflow("fix-to-pr");
    await ctl.pump();
    assert.deepEqual(calls, []);
    assert.equal(ctl.run.status, "waiting-human");
    assert.equal(ctl.run.reason, headFailure ? "cannot-read-final-head" : "final-review-head-stale");
    assert.equal((await store.load(run.id)).status, "waiting-human");
  }
});

test("post-rebase changes_requested reruns the full loop with the same writer and requires final exact-head approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-loop-")); const { adapter, started } = fakeWorkers(dir);
  const effects = {
    current: "start", cycle: 0, calls: [], async preflight() {}, async head() { await new Promise((resolve) => setImmediate(resolve)); return this.current; },
    async run(kind, options) {
      this.calls.push({ kind, approvedHead: options?.approvedHead });
      if (kind === Effect.COMMIT) { this.current = `commit-${++this.cycle}`; return { head: this.current, paths: ["src/x.js"] }; }
      if (kind === Effect.REBASE) { this.current = `rebase-${this.cycle}`; return { head: this.current }; }
      if (kind === Effect.RECONCILE_PR) return { existing: null };
      if (kind === Effect.PUBLISH_PR) return { pr: "https://pr/loop" };
      return { checked: 1 };
    },
  };
  const ctl = new Controller({ store: new Store(dir), workers: adapter, effectsFor: () => effects, token: () => "abcdefgh" });
  await ctl.start({ workflow: "fix-to-pr", spec: fixSpec({ taskKey: "full-loop" }) }); await ctl.pump();
  const writer = started[0]; report(ctl, writer, "write", "ok");
  await ready(() => ctl.run.nodes.review?.status === "running"); report(ctl, started.find((worker) => worker.stage === "review"), "review", "approved");
  await ready(() => ctl.run.nodes["review-head"]?.status === "running"); report(ctl, started.find((worker) => worker.stage === "review-head"), "review-head", "changes_requested", { feedback: "post-rebase issue" });
  await ready(() => ctl.run.nodes.write?.status === "running" && ctl.run.reviewRounds === 1);

  assert.equal(started.filter((worker) => worker.role === "writer").length, 1);
  assert.equal(started[0], writer);
  assert.deepEqual(ctl.run.effects, {});
  assert.equal(ctl.run.nodes.review.status, "pending"); assert.equal(ctl.run.nodes.review.head, undefined);
  assert.equal(ctl.run.nodes["review-head"].status, "pending");

  report(ctl, writer, "write", "ok");
  await ready(() => ctl.run.nodes.review?.status === "running"); report(ctl, started.find((worker) => worker.stage === "review"), "review", "approved");
  await ready(() => ctl.run.nodes["review-head"]?.status === "running");
  assert.equal(effects.calls.some((call) => [Effect.RECONCILE_PR, Effect.PUBLISH_PR].includes(call.kind)), false);
  const finalHead = effects.current; report(ctl, started.find((worker) => worker.stage === "review-head"), "review-head", "approved");
  await ready(() => ctl.run.status === "done");

  assert.equal(finalHead, "rebase-2");
  assert.deepEqual(effects.calls.map((call) => call.kind), [Effect.COMMIT, Effect.CHECKS, Effect.REBASE, Effect.CHECKS, Effect.COMMIT, Effect.CHECKS, Effect.REBASE, Effect.CHECKS, Effect.RECONCILE_PR, Effect.PUBLISH_PR]);
  for (const call of effects.calls.filter((entry) => [Effect.RECONCILE_PR, Effect.PUBLISH_PR].includes(entry.kind))) assert.equal(call.approvedHead, finalHead);
  assert.equal(ctl.run.pr, "https://pr/loop"); await ctl.close();
});

test("a replayed report from a completed reviewer cannot invalidate the active stage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-replay-")); const { adapter, started } = fakeWorkers(dir);
  const effects = { current: "start", async preflight() {}, async head() { return this.current; }, async run(kind) {
    if (kind === Effect.COMMIT) { this.current = "commit"; return { head: this.current }; }
    if (kind === Effect.REBASE) { this.current = "rebased"; return { head: this.current }; }
    return { checked: 1 };
  } };
  const ctl = new Controller({ store: new Store(dir), workers: adapter, effectsFor: () => effects, token: () => "abcdefgh" });
  await ctl.start({ workflow: "fix-to-pr", spec: fixSpec({ taskKey: "report-replay" }) }); await ctl.pump();
  report(ctl, started[0], "write", "ok"); await ready(() => ctl.run.nodes.review?.status === "running");
  const reviewer = started.find((worker) => worker.stage === "review"); report(ctl, reviewer, "review", "approved");
  await ready(() => ctl.run.nodes["review-head"]?.status === "running");
  report(ctl, reviewer, "review", "changes_requested", { feedback: "stale" }); await ctl.queue;
  assert.equal(ctl.run.reviewRounds, 0); assert.equal(ctl.run.nodes.review.status, "approved"); assert.equal(ctl.run.nodes["review-head"].status, "running");
  await ctl.close();
});

test("read-only workflows complete structured reports without any git HEAD capability", async () => {
  for (const workflowName of ["investigate-report", "read-only-verify"]) {
    const dir = await mkdtemp(join(tmpdir(), "read-no-git-")); const { adapter, started } = fakeWorkers(dir);
    const effects = workflowName === "investigate-report" ? { async head() { throw new Error("not a git repository"); } } : {};
    const ctl = new Controller({ store: new Store(dir), workers: adapter, effectsFor: () => effects, token: () => "abcdefgh" });
    await ctl.start({ workflow: workflowName, spec: readSpec({ taskKey: `no-git-${workflowName}` }) }); await ctl.pump();
    for (const worker of started) report(ctl, worker, worker.stage, "ok");
    await ready(() => ctl.run.status === "done");
    assert.equal(ctl.run.pr, undefined); await ctl.close();
  }
});

test("role route and worker identity are explicit in argv and durable node state; generic overrides are rejected", async () => {
  for (const field of ["model", "provider", "thinking"]) assert.throws(() => validateSpec(readSpec({ [field]: "override" }), "investigate-report"), /routing is fixed/);
  const dir = await mkdtemp(join(tmpdir(), "route-state-")); const { adapter } = fakeWorkers(dir);
  const ctl = new Controller({ store: new Store(dir), workers: adapter, effectsFor: () => ({}) });
  await assert.rejects(ctl.start({ workflow: "investigate-report", spec: readSpec(), model: "anything" }), /override is not supported/);
  await ctl.start({ workflow: "investigate-report", spec: readSpec({ taskKey: "route" }) }); await ctl.pump();
  const node = (await ctl.store.load(ctl.run.id)).nodes.investigate;
  assert.deepEqual(node.route, roleRoute.investigator);
  assert.equal(node.worker.startsWith("worker-"), true); assert.match(node.sessionDir, /workers\/worker-/); assert.equal(node.pid, 4242); assert.equal(node.policy, "read-only");
  const worker = [...adapter.workers.values()][0]; const argv = adapter.argv(worker);
  assert.equal(argv[argv.indexOf("--model") + 1], `${node.route.provider}/${node.route.model}`);
  assert.equal(argv[argv.indexOf("--thinking") + 1], node.route.thinking);
  await ctl.close();
});

test("confirmed publish recovery cannot accept a PR after the approved HEAD changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publish-reconcile-")); const store = new Store(dir);
  const run = newRun({ workflow: "fix-to-pr", spec: fixSpec() }); run.status = "waiting-human";
  run.nodes["review-head"] = { role: "reviewer", status: "approved", head: "approved" };
  run.effects.publish = { kind: Effect.PUBLISH_PR, status: "started", approvedHead: "approved" };
  const proofCalls = []; const ctl = new Controller({ store, workers: {}, effectsFor: () => ({}) }); ctl.run = await store.create(run);
  ctl.effects = { async head() { return "changed"; }, async prove() { proofCalls.push("prove"); return { pr: "https://pr/wrong" }; } };
  await assert.rejects(ctl.reconcile("publish", "confirmed-applied"), /no longer current/);
  assert.deepEqual(proofCalls, []); assert.equal((await store.load(run.id)).status, "waiting-human");
});

test("an interrupted writer cannot be replayed through manual reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "writer-reconcile-")); const store = new Store(dir);
  const run = await store.create(Object.assign(newRun({ workflow: "fix-to-pr", spec: fixSpec() }), { status: "waiting-human", nodes: { write: { role: "writer", status: "running" } } }));
  const ctl = new Controller({ store, workers: {}, effectsFor: () => ({}) }); ctl.run = run; ctl.effects = {};
  await assert.rejects(ctl.reconcile("write", "confirmed-not-applied"), /cannot be replayed/);
  await assert.rejects(ctl.reconcile("write", "confirmed-applied"), /cannot be replayed/);
});
