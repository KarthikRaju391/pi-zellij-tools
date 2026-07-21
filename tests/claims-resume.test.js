import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { newRun, validateSpec } from "../src/state.js";
import { Store } from "../src/store.js";

const taskSpec = (overrides = {}) => validateSpec({ taskKey: "claim-task", objective: "Inspect", cwd: "/work", paths: [], ...overrides }, "investigate-report");
const event = (run, type, extra = {}) => ({ id: `${type}-${Math.random()}`, type, generation: run.generation, lease: run.lease, ...extra });

const fakeOwner = (pid, startIdentity) => async () => ({ pid, startIdentity, startedAt: 1 });

test("task and canonical cwd claims conflict independently and partial acquisition rolls back only this run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claims-pair-"));
  const cwd = await mkdtemp(join(tmpdir(), "claims-cwd-"));
  const alias = `${cwd}-alias`;
  await symlink(cwd, alias);
  const store = new Store(dir);
  await store.claim("task-a", cwd, "run-a");

  await assert.rejects(store.claim("task-a", `${cwd}-other`, "run-b"), /active claim/);
  await assert.rejects(store.claim("task-b", alias, "run-b"), /active claim/);

  const [taskB] = store.claimFiles("task-b", alias);
  await assert.rejects(readFile(taskB, "utf8"), { code: "ENOENT" });
  for (const file of store.claimFiles("task-a", cwd)) {
    assert.equal(JSON.parse(await readFile(file, "utf8")).runId, "run-a");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test("an old owner cannot release claims after a newer run acquires them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claims-owner-")); const store = new Store(dir);
  await store.claim("task", "/cwd", "old");
  await store.releaseClaim("task", "/cwd", "old");
  await store.claim("task", "/cwd", "new");
  await store.releaseClaim("task", "/cwd", "old");
  for (const file of store.claimFiles("task", "/cwd")) assert.equal(JSON.parse(await readFile(file, "utf8")).runId, "new");
});

test("terminal owners stay claimed while live and are reclaimable only after verified release", async () => {
  for (const terminal of ["done", "cancelled", "failed"]) {
    const dir = await mkdtemp(join(tmpdir(), `claims-${terminal}-`)); const store = new Store(dir);
    let run = newRun({ id: `old-${terminal}`, workflow: "investigate-report", spec: taskSpec({ taskKey: `task-${terminal}` }) });
    await store.claim(run.taskKey, run.cwd, run.id); run = await store.create(run);
    run = await store.append(run, event(run, "recovery-wait", { reason: "human" }));
    await assert.rejects(store.claim(run.taskKey, run.cwd, "blocked"), /active claim/);
    const terminalEvent = terminal === "done" ? ["complete", {}] : terminal === "cancelled" ? ["cancel", {}] : ["reconcile", { target: "x", decision: "abandon" }];
    run = await store.append(run, event(run, terminalEvent[0], terminalEvent[1]));
    assert.equal(run.status, terminal); await assert.rejects(store.claim(run.taskKey, run.cwd, `new-${terminal}`), /active claim/);
    await store.releaseClaim(run.taskKey, run.cwd, run.id); await store.claim(run.taskKey, run.cwd, `new-${terminal}`);
    for (const file of store.claimFiles(run.taskKey, run.cwd)) assert.equal(JSON.parse(await readFile(file, "utf8")).runId, `new-${terminal}`);
  }
});

test("a journal-less live PID/start owner blocks, while a dead start identity is reclaimable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claims-orphan-"));
  const first = new Store(dir, { owner: fakeOwner(101, "start-a"), ownerAlive: async () => true });
  await first.claim("task", "/cwd", "orphan");
  const live = new Store(dir, { owner: fakeOwner(202, "start-b"), ownerAlive: async (owner) => owner.pid === 101 && owner.startIdentity === "start-a" });
  await assert.rejects(live.claim("task", "/cwd", "live-contender"), /active claim/);

  const replacement = new Store(dir, { owner: fakeOwner(303, "start-c"), ownerAlive: async (owner) => owner.pid === 101 && owner.startIdentity === "different-start" });
  await replacement.claim("task", "/cwd", "replacement");
  for (const file of replacement.claimFiles("task", "/cwd")) {
    const owner = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual({ runId: owner.runId, pid: owner.pid, startIdentity: owner.startIdentity }, { runId: "replacement", pid: 303, startIdentity: "start-c" });
  }
});

test("resume claim acquisition accepts its own claim and restores a missing sibling claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claims-resume-")); const store = new Store(dir);
  await store.claim("task", "/cwd", "run");
  const [, cwdClaim] = store.claimFiles("task", "/cwd"); await unlink(cwdClaim);
  await store.claim("task", "/cwd", "run");
  for (const file of store.claimFiles("task", "/cwd")) assert.equal(JSON.parse(await readFile(file, "utf8")).runId, "run");
});

test("dirty interrupted-writer resume revalidates identity then durably waits for a human", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resume-dirty-")); const store = new Store(dir);
  let run = await store.create(newRun({ workflow: "fix-to-pr", spec: validateSpec({ taskKey: "dirty", objective: "Fix", cwd: "/work", remote: "origin", base: "main", branch: "topic", paths: ["src"], checks: [["node", "--test"]], authorization: { edit: true, pr: true } }, "fix-to-pr") }));
  run = await store.append(run, event(run, "node-started", { node: "write", role: "writer", worker: "writer", route: {}, policy: "write" }));
  let preflightOptions;
  const effects = { async preflight(options) { preflightOptions = options; if (!options.allowDirty) throw new Error("dirty"); } };
  const ctl = new Controller({ store, workers: { shutdown() {} }, effectsFor: () => effects });
  await ctl.resume(run.id);
  assert.deepEqual(preflightOptions, { allowDirty: true });
  assert.equal(ctl.run.status, "waiting-human");
  assert.equal((await store.load(run.id)).reason, "recovery-interrupted-writer");
  await ctl.close();
});

test("resume rejects worktree identity mismatch before claims, lease, or journal mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resume-mismatch-")); const store = new Store(dir);
  const run = await store.create(newRun({ workflow: "fix-to-pr", spec: validateSpec({ taskKey: "mismatch", objective: "Fix", cwd: "/work", remote: "origin", base: "main", branch: "topic", paths: ["src"], checks: [["node", "--test"]], authorization: { edit: true, pr: true } }, "fix-to-pr") }));
  const beforeFiles = (await readdir(dir)).sort(); const beforeJournal = await readFile(join(dir, `${run.id}.jsonl`), "utf8");
  const ctl = new Controller({ store, workers: {}, effectsFor: () => ({ async preflight() { throw new Error("declared branch is not checked out"); } }) });
  await assert.rejects(ctl.resume(run.id), /declared branch/);
  assert.deepEqual((await readdir(dir)).sort(), beforeFiles);
  assert.equal(await readFile(join(dir, `${run.id}.jsonl`), "utf8"), beforeJournal);
});
