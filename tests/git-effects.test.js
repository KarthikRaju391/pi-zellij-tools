import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { Effect, GitEffects } from "../src/effects.js";
import { newRun, validateSpec } from "../src/state.js";
import { Store } from "../src/store.js";
import { workflow } from "../src/workflows.js";

const spec = () => validateSpec({ taskKey: "git-effects", objective: "Fix exact PR", cwd: "/work", remote: "origin", base: "main", branch: "topic", paths: ["src"], checks: [["node", "--test"]], authorization: { edit: true, pr: true } }, "fix-to-pr");
const exactPr = (overrides = {}) => ({ state: "OPEN", mergedAt: null, url: "https://pr/existing", headRefName: "topic", headRefOid: "approved", baseRefName: "main", isDraft: false, ...overrides });

function executor({ heads = ["approved"], prs = [], viewed = exactPr({ url: "https://pr/new" }) } = {}) {
  const calls = []; let headIndex = 0;
  const execFile = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${heads[Math.min(headIndex++, heads.length - 1)]}\n` };
    if (file === "git" && args[0] === "status") return { stdout: "" };
    if (file === "git" && args[0] === "diff") return { stdout: "src/x.js\n" };
    if (file === "git" && args[0] === "push") return { stdout: "" };
    if (file === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: JSON.stringify(prs) };
    if (file === "gh" && args[0] === "pr" && args[1] === "create") return { stdout: "https://pr/new\n" };
    if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify(viewed) };
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };
  return { calls, execFile };
}

function readyForReconcile() {
  const run = newRun({ workflow: "fix-to-pr", spec: spec() });
  run.nodes = { write: { role: "writer", status: "ok" }, review: { role: "reviewer", status: "approved", head: "commit" }, "review-head": { role: "reviewer", status: "approved", head: "approved" } };
  run.effects = { commit: { status: "ok", kind: Effect.COMMIT }, "checks-before-review": { status: "ok", kind: Effect.CHECKS }, rebase: { status: "ok", kind: Effect.REBASE }, "checks-after-rebase": { status: "ok", kind: Effect.CHECKS } };
  return run;
}

test("an exact open PR at the final reviewed local SHA is reconciled and completes the run", async () => {
  const fake = executor({ prs: [exactPr()] }); const effects = new GitEffects({ spec: spec(), execFile: fake.execFile });
  const dir = await mkdtemp(join(tmpdir(), "git-reconcile-")); const store = new Store(dir); const run = await store.create(readyForReconcile());
  const ctl = new Controller({ store, workers: { shutdown() {} } }); ctl.run = run; ctl.effects = effects; ctl.plan = workflow("fix-to-pr");
  await ctl.pump();
  assert.equal(ctl.run.status, "done"); assert.equal(ctl.run.pr, "https://pr/existing");
  assert.equal(fake.calls.some((call) => call[0] === "gh" && call[2] === "create"), false);
});

test("a stale same-branch PR is not accepted and publish never invokes gh pr create", async () => {
  const fake = executor({ prs: [exactPr({ headRefOid: "stale" })] }); const effects = new GitEffects({ spec: spec(), execFile: fake.execFile });
  assert.deepEqual(await effects.run(Effect.RECONCILE_PR, { approvedHead: "approved" }), { existing: null });
  await assert.rejects(effects.run(Effect.PUBLISH_PR, { approvedHead: "approved" }), /does not match exact reviewed head/);
  assert.equal(fake.calls.some((call) => call[0] === "gh" && call[2] === "create"), false);
});

test("new PR creation is accepted only after exact OPEN, unmerged readback", async () => {
  const valid = executor(); const created = await new GitEffects({ spec: spec(), execFile: valid.execFile }).run(Effect.PUBLISH_PR, { approvedHead: "approved" });
  assert.deepEqual(created, { pr: "https://pr/new" });
  assert.equal(valid.calls.some((call) => call[0] === "git" && call[1] === "push" && call[3] === "approved:refs/heads/topic"), true);
  assert.equal(valid.calls.some((call) => call[0] === "gh" && call[2] === "create"), true);

  for (const viewed of [
    exactPr({ url: "https://pr/new", state: "CLOSED" }), exactPr({ url: "https://pr/new", mergedAt: "today" }),
    exactPr({ url: "https://pr/new", headRefName: "other" }), exactPr({ url: "https://pr/new", headRefOid: "other" }), exactPr({ url: "https://pr/new", baseRefName: "other" }),
  ]) {
    const fake = executor({ viewed });
    await assert.rejects(new GitEffects({ spec: spec(), execFile: fake.execFile }).run(Effect.PUBLISH_PR, { approvedHead: "approved" }), /not exact, open, and unmerged/);
  }
});

test("both PR effects require the approved current HEAD before any PR command", async () => {
  for (const kind of [Effect.RECONCILE_PR, Effect.PUBLISH_PR]) {
    const fake = executor({ heads: ["different"] }); const effects = new GitEffects({ spec: spec(), execFile: fake.execFile });
    await assert.rejects(effects.run(kind, { approvedHead: "approved" }), /does not match final review/);
    assert.deepEqual(fake.calls, [["git", "rev-parse", "HEAD"]]);
  }
});

test("interrupted publish proof also requires the persisted final reviewed HEAD", async () => {
  const fake = executor({ heads: ["changed"], prs: [exactPr()] }); const effects = new GitEffects({ spec: spec(), execFile: fake.execFile });
  await assert.rejects(effects.prove(Effect.PUBLISH_PR, { approvedHead: "approved" }), /does not match final review/);
  assert.equal(fake.calls.some((call) => call[0] === "gh"), false);
});

test("resume preflight revalidates worktree identity while allowing an interrupted writer's dirty tree", async () => {
  const calls = [];
  const effects = new GitEffects({ spec: spec(), execFile: async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "worktree") return { stdout: "worktree /work\n" };
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: "/work\n" };
    if (args[0] === "branch") return { stdout: "topic\n" };
    return { stdout: "ok\n" };
  } });
  await effects.preflight({ allowDirty: true });
  assert.equal(calls.some((call) => call[1] === "status"), false);

  const mismatchCalls = [];
  const mismatch = new GitEffects({ spec: spec(), execFile: async (file, args) => {
    mismatchCalls.push([file, ...args]);
    if (args[0] === "worktree") return { stdout: "worktree /work\n" };
    if (args[0] === "rev-parse") return { stdout: "/work\n" };
    if (args[0] === "branch") return { stdout: "wrong\n" };
    return { stdout: "ok\n" };
  } });
  await assert.rejects(mismatch.preflight({ allowDirty: true }), /branch is not checked out/);
  assert.equal(mismatchCalls.some((call) => call[1] === "remote"), false);
});

test("a HEAD change during PR prechecks is caught before gh or push I/O", async () => {
  for (const kind of [Effect.RECONCILE_PR, Effect.PUBLISH_PR]) {
    const fake = executor({ heads: ["approved", "changed"] }); const effects = new GitEffects({ spec: spec(), execFile: fake.execFile });
    await assert.rejects(effects.run(kind, { approvedHead: "approved" }), /does not match final review/);
    assert.equal(fake.calls.some((call) => call[0] === "gh" || (call[0] === "git" && call[1] === "push")), false);
  }
});
