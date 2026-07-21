import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Controller } from "../src/controller.js";
import { Store } from "../src/store.js";
import { WorkerAdapter } from "../src/worker.js";

function fakeChild(responder) {
  const child = new EventEmitter();
  child.pid = Math.floor(Math.random() * 100000) + 100;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.writes = []; child.killed = false;
  child.stdin = { write(line) { const message = JSON.parse(line); child.writes.push(message); responder?.(message, child); return true; } };
  child.kill = () => { child.killed = true; };
  return child;
}

const startWorker = async ({ requestTimeout = 100, responder, events = [] } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "worker-rpc-")); const child = fakeChild(responder);
  const adapter = new WorkerAdapter({ stateDir: dir, requestTimeout, spawnProcess: () => child });
  const worker = adapter.start({ id: "worker", runId: "run", role: "verifier", cwd: "/work", policy: "read-only", stage: "verify" }, (event) => events.push(event));
  return { adapter, child, worker, events };
};
const material = (events) => events.filter((event) => ["protocol_error", "process_error", "process_exit"].includes(event.type));
const ready = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error("timed out"); };

test("malformed JSON and EOF each reject pending RPC exactly once and clear its timer", async () => {
  for (const failure of ["malformed", "eof"]) {
    const { adapter, child, worker, events } = await startWorker();
    const pending = adapter.command(worker, "prompt", { message: "hello" });
    if (failure === "malformed") child.stdout.write("not-json\n"); else child.stdout.end();
    await assert.rejects(pending, failure === "malformed" ? /Unexpected token|JSON/ : /stdout ended/);
    child.emit("exit", 1, null);
    assert.equal(worker.pending.size, 0);
    assert.equal(material(events).length, 1);
    assert.equal(material(events)[0].type, "protocol_error");
  }
});

test("the configured request timeout governs real bindAndPrompt response timing", async () => {
  const { adapter, worker, child } = await startWorker({ requestTimeout: 12 });
  await assert.rejects(adapter.bindAndPrompt(worker, "verify", 2, "abcdefgh", "prompt", { cwd: "/work", paths: [] }), /RPC prompt timed out/);
  assert.equal(child.writes.length, 1);
  assert.equal(worker.pending.size, 0);
});

test("child exit and child error each reject all pending requests and emit one process event", async () => {
  for (const failure of ["exit", "error"]) {
    const { adapter, child, worker, events } = await startWorker();
    const first = adapter.command(worker, "prompt"); const second = adapter.command(worker, "abort");
    if (failure === "exit") child.emit("exit", 2, null); else child.emit("error", new Error("spawn broke"));
    await assert.rejects(first); await assert.rejects(second);
    child.emit("exit", 2, null);
    assert.equal(worker.pending.size, 0);
    assert.equal(material(events).length, 1);
    assert.equal(material(events)[0].type, failure === "exit" ? "process_exit" : "process_error");
  }
});

test("stderr is harmless and bindAndPrompt sends the task only after binding succeeds", async () => {
  const events = []; let firstResponse;
  const { adapter, child, worker } = await startWorker({ events, responder(message, process) {
    if (process.writes.length === 1) firstResponse = setTimeout(() => process.stdout.write(`${JSON.stringify({ type: "response", id: message.id, success: true })}\n`), 15);
    else process.stdout.write(`${JSON.stringify({ type: "response", id: message.id, success: true })}\n`);
  } });
  const pending = adapter.bindAndPrompt(worker, "verify", 2, "abcdefgh", "task prompt", { cwd: "/work", paths: [] });
  child.stderr.write("account diagnostic\n");
  await new Promise((resolve) => setTimeout(resolve, 3));
  assert.equal(child.writes.length, 1);
  await pending; clearTimeout(firstResponse);
  assert.equal(child.writes.length, 2);
  assert.match(child.writes[0].message, /^\/orchestrator-bind /);
  assert.equal(child.writes[1].message, "task prompt");
  assert.deepEqual(events.map((event) => event.type), ["stderr"]);
});

test("report then process exit does not poison another active stage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-controller-")); const children = [];
  const adapter = new WorkerAdapter({ stateDir: dir, requestTimeout: 100, spawnProcess: () => {
    const child = fakeChild((message, process) => setImmediate(() => process.stdout.write(`${JSON.stringify({ type: "response", id: message.id, success: true })}\n`)));
    children.push(child); return child;
  } });
  const ctl = new Controller({ store: new Store(dir), workers: adapter, effectsFor: () => ({}), token: () => "abcdefgh" });
  await ctl.start({ workflow: "read-only-verify", spec: { taskKey: "protocol-report", objective: "Verify", cwd: "/work" } });
  await ctl.pump();
  const records = [...adapter.workers.values()]; assert.equal(records.length, 2);
  const report = (worker) => worker.child.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "orchestrator_report", isError: false, result: { details: { node: worker.stage, generation: ctl.run.generation, token: worker.token, role: worker.role, outcome: "ok", summary: "done" } } })}\n`);
  report(records[0]); records[0].child.emit("exit", 0, null);
  await ready(() => ctl.run.nodes[records[0].stage]?.status === "ok");
  assert.equal(ctl.run.status, "running");
  report(records[1]); await ready(() => ctl.run.status === "done");
  assert.equal(ctl.run.reason, undefined);
  await ctl.close();
});
