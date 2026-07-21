import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { newRun, reduce, validateSpec } from "../src/state.js";
import { Lease, Store } from "../src/store.js";
import { WorkerAdapter, LfJsonl, roleRoute } from "../src/worker.js";
import { guardPath } from "../src/path-policy.js";
import { Controller } from "../src/controller.js";
import { Effect } from "../src/effects.js";

const spec = (overrides = {}) => ({ taskKey: "task-1", objective: "Fix scoped thing", cwd: "/task-worktree", remote: "origin", base: "main", branch: "task-1", paths: ["src"], checks: [["node", "--test"]], authorization: { edit: true, pr: true }, instructions: "Use the project convention.", ...overrides });
const event = (run, type, extra = {}) => ({ id: `${type}-${Math.random()}`, type, generation: run.generation, lease: run.lease, ...extra });

class FakeEffects {
  constructor(input) { this.spec = input.spec ?? input; this.cwd = this.spec.cwd; this.calls = []; this.current = "head-1"; }
  async assertClean() {} async head() { await new Promise((r) => setImmediate(r)); return this.current; }
  async run(kind) { this.calls.push(kind); if (kind === Effect.COMMIT) return { head: this.current, paths: ["src/x.js"] }; if (kind === Effect.REBASE) { this.current = "head-2"; return { head: this.current }; } if (kind === Effect.RECONCILE_PR) return { existing: null }; if (kind === Effect.PUBLISH_PR) return { pr: "https://pr/1" }; return { checked: 1 }; }
}
function workers(dir) {
  const spawned = []; const adapter = new WorkerAdapter({ stateDir: dir, spawnProcess: () => { const child = new EventEmitter(); Object.assign(child, { stdin: { write() {} }, stdout: new PassThrough(), stderr: new PassThrough() }); child.kill = () => child.emit("exit", 0, "SIGTERM"); return child; } });
  const original = adapter.start.bind(adapter); adapter.start = (...args) => { const worker = original(...args); spawned.push(worker); return worker; }; adapter.bindAndPrompt = async () => ({ success: true }); return { adapter, spawned };
}
async function ready(predicate) { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 2)); } throw new Error("timed out"); }
function report(ctl, worker, node, outcome, extra = {}) { worker.child.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "orchestrator_report", isError: false, result: { details: { node, generation: ctl.run.generation, token: worker.token, role: worker.role, outcome, summary: outcome, ...extra } } })}\n`); }

test("valid report followed immediately by settled is serialized and report wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-")); const { adapter, spawned } = workers(dir); const ctl = new Controller({ store: new Store(dir), workers: adapter, effectsFor: (s) => new FakeEffects(s), token: () => "abcdefgh" });
  await ctl.start({ workflow: "investigate-report", spec: spec() }); await ctl.pump(); const worker = spawned[0];
  report(ctl, worker, "investigate", "ok"); worker.child.stdout.write('{"type":"agent_settled"}\n');
  await ready(() => ctl.run.nodes.investigate?.status === "ok"); assert.equal(ctl.run.status, "running"); await ctl.close();
});

test("resume never replays interrupted writer or started write effects", async () => {
  for (const interrupted of ["writer", Effect.COMMIT, Effect.REBASE, Effect.PUBLISH_PR]) {
    const dir = await mkdtemp(join(tmpdir(), "orch-recover-")); const store = new Store(dir); let run = await store.create(newRun({ workflow: "fix-to-pr", spec: validateSpec(spec({ taskKey: `k-${interrupted}` }), "fix-to-pr") }));
    if (interrupted === "writer") run = await store.append(run, event(run, "node-started", { node: "write", role: "writer", worker: "w" }));
    else run = await store.append(run, event(run, "effect-started", { effect: interrupted, kind: interrupted }));
    const ctl = new Controller({ store, workers: workers(dir).adapter, effectsFor: (s) => new FakeEffects(s) }); await ctl.resume(run.id);
    assert.equal(ctl.run.status, "waiting-human"); assert.match(ctl.run.reason, /recovery-interrupted/); await ctl.close();
  }
});

test("resume constructs effects from persisted cwd, not CLI cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-cwd-")); const store = new Store(dir); const run = await store.create(newRun({ workflow: "investigate-report", spec: validateSpec(spec({ cwd: "/persisted-worktree" }), "investigate-report") })); let cwd;
  const ctl = new Controller({ store, workers: workers(dir).adapter, effectsFor: (stored) => { cwd = stored.cwd; return new FakeEffects(stored); } }); await ctl.resume(run.id); assert.equal(cwd, "/persisted-worktree"); await ctl.close();
});

test("task spec is required, fix checks are non-empty, task keys dedupe, and private files are private", async () => {
  assert.throws(() => validateSpec(spec({ checks: [] }), "fix-to-pr")); assert.throws(() => validateSpec(spec({ paths: ["../x"] }), "fix-to-pr"));
  const dir = await mkdtemp(join(tmpdir(), "orch-mode-")); const store = new Store(dir); const run = await store.create(newRun({ workflow: "investigate-report", spec: validateSpec(spec(), "investigate-report") }));
  await assert.rejects(() => store.create(run)); assert.equal((await stat(dir)).mode & 0o777, 0o700); assert.equal((await stat(join(dir, `${run.id}.jsonl`))).mode & 0o777, 0o600); assert.equal((await stat(join(dir, `${run.id}.json`))).mode & 0o777, 0o600);
  assert.equal((await store.activeForTask("task-1")).id, run.id); const lease = new Lease(dir, run.id); await lease.acquire(2); assert.equal((await stat(join(dir, `${run.id}.lease`))).mode & 0o777, 0o600); await lease.release();
});

test("review changes loops to the same writer and approval is exact-head", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-loop-")); const { adapter, spawned } = workers(dir); const effects = new FakeEffects(spec()); const ctl = new Controller({ store: new Store(dir), workers: adapter, effectsFor: () => effects, token: () => "abcdefgh" });
  await ctl.start({ workflow: "fix-to-pr", spec: spec() }); await ctl.pump(); const writer = spawned[0]; report(ctl, writer, "write", "ok"); await ready(() => ctl.run.nodes.review?.status === "running"); const reviewer = spawned.at(-1);
  report(ctl, reviewer, "review", "changes_requested", { feedback: "fix edge case" }); await ready(() => ctl.run.nodes.write?.status === "running"); assert.equal(spawned[0], writer); assert.match(ctl.prompt({ role: "writer" }), /fix edge case/);
  assert.equal(ctl.run.reviewRounds, 1); assert.equal(ctl.run.reviewRounds, 1); await ctl.close();
});

test("parallel read-only members both dispatch before either report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-parallel-")); const { adapter, spawned } = workers(dir); const ctl = new Controller({ store: new Store(dir), workers: adapter, effectsFor: (s) => new FakeEffects(s), token: () => "abcdefgh" });
  await ctl.start({ workflow: "read-only-verify", spec: spec({ taskKey: "parallel" }) }); await ctl.pump(); assert.equal(spawned.length, 2); assert.deepEqual(Object.keys(ctl.run.nodes).sort(), ["verify-a", "verify-b"]); await ctl.close();
});

test("LF framing preserves separators and worker path is module-relative", () => {
  const values = []; const parser = new LfJsonl((x) => values.push(x)); parser.write(Buffer.from('{"x":"a\u2028b\u2029c"}\n')); assert.equal(values[0].x, "a\u2028b\u2029c");
  const adapter = new WorkerAdapter({ stateDir: "/state", spawnProcess: () => { throw new Error("not spawned"); } }); assert.match(adapter.extension, /extensions\/orchestrator-worker\.ts$/);
});

test("unsafe effect names cannot be constructed", () => { assert.deepEqual(Object.values(Effect), ["commit", "checks", "rebase", "reconcile-pr", "publish-pr"]); for (const name of ["merge", "deploy", "prod", "data", "message", "migration", "backfill"]) assert.ok(!Object.values(Effect).includes(name)); });
