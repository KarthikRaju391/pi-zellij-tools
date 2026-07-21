import { spawn } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { idFor } from "./state.js";
import { roleTools } from "./workflows.js";

export class LfJsonl {
  constructor(onValue) { this.onValue = onValue; this.decoder = new StringDecoder("utf8"); this.buffer = ""; }
  write(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onValue(JSON.parse(line));
    }
  }
  end() {
    this.buffer += this.decoder.end();
    if (this.buffer) this.onValue(JSON.parse(this.buffer.replace(/\r$/, "")));
    this.buffer = "";
  }
}

const extensionPath = fileURLToPath(new URL("../extensions/orchestrator-worker.ts", import.meta.url));
export const roleRoute = Object.freeze({
  investigator: Object.freeze({ provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" }),
  verifier: Object.freeze({ provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" }),
  writer: Object.freeze({ provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" }),
  reviewer: Object.freeze({ provider: "openai-codex", model: "gpt-5.6-terra", thinking: "high" }),
});

export class WorkerAdapter {
  constructor({ stateDir, extension = extensionPath, spawnProcess = spawn, requestTimeout = 15000, shutdownTimeout = 5000 }) {
    if (!Number.isFinite(requestTimeout) || requestTimeout <= 0) throw new Error("requestTimeout must be positive");
    if (!Number.isFinite(shutdownTimeout) || shutdownTimeout <= 0) throw new Error("shutdownTimeout must be positive");
    this.stateDir = stateDir;
    this.extension = extension;
    this.spawnProcess = spawnProcess;
    this.requestTimeout = requestTimeout;
    this.shutdownTimeout = shutdownTimeout;
    this.workers = new Map();
  }
  sessionDir(worker) { return join(this.stateDir, "workers", worker.id); }
  argv(worker) {
    const route = roleRoute[worker.role];
    if (!route) throw new Error(`unknown worker role: ${worker.role}`);
    return ["--mode", "rpc", "--model", `${route.provider}/${route.model}`, "--thinking", route.thinking, "--session-dir", this.sessionDir(worker), "--no-extensions", "-e", this.extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", roleTools[worker.role].join(",")];
  }
  start(worker, onEvent) {
    const route = roleRoute[worker.role];
    if (!route) throw new Error(`unknown worker role: ${worker.role}`);
    mkdirSync(this.sessionDir(worker), { recursive: true, mode: 0o700 }); chmodSync(this.sessionDir(worker), 0o700);
    const child = this.spawnProcess("pi-pool", this.argv(worker), { cwd: worker.cwd, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let confirmExit;
    const record = { ...worker, route, sessionDir: this.sessionDir(worker), child, busy: false, idle: true, reports: [], pending: new Map(), requestSequence: 0, terminated: false, exited: false, exitPromise: new Promise((resolve) => { confirmExit = resolve; }) };
    const exited = (code, signal) => { if (!record.exited) { record.exited = true; confirmExit({ code, signal }); } };
    const rejectPending = (error) => {
      for (const pending of record.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      record.pending.clear();
    };
    const fail = (type, error) => {
      if (record.terminated) return;
      record.terminated = true; record.busy = false; record.idle = false;
      rejectPending(error);
      onEvent?.({ type, error: String(error), afterReport: record.reports.length > 0 }, record);
    };
    const parser = new LfJsonl((event) => {
      if (record.terminated) return;
      if (event.type === "response" && event.id && record.pending.has(event.id)) {
        const pending = record.pending.get(event.id); clearTimeout(pending.timer); record.pending.delete(event.id); pending.resolve(event); return;
      }
      if (event.type === "tool_execution_end" && event.toolName === "orchestrator_report" && !event.isError) record.reports.push(event.result?.details);
      if (event.type === "agent_settled") record.idle = true;
      onEvent?.(event, record);
    });
    child.stdout.on("data", (chunk) => {
      if (record.terminated) return;
      try { parser.write(chunk); }
      catch (error) { fail("protocol_error", error); try { child.kill("SIGTERM"); } catch {} }
    });
    child.stdout.on("end", () => {
      if (record.terminated) return;
      try { parser.end(); }
      catch (error) { fail("protocol_error", error); return; }
      fail("protocol_error", new Error("RPC stdout ended"));
    });
    child.on?.("exit", (code, signal) => { exited(code, signal); fail("process_exit", new Error(`RPC process exited (${code ?? signal ?? "unknown"})`)); });
    child.on?.("error", (error) => fail("process_error", error));
    child.stderr.on("data", (chunk) => { if (!record.terminated) onEvent?.({ type: "stderr", text: String(chunk) }, record); });
    this.workers.set(record.id, record);
    return record;
  }
  command(worker, type, fields = {}) {
    if (worker.terminated) return Promise.reject(new Error("RPC process is not available"));
    const id = idFor("command", { worker: worker.id, sequence: ++worker.requestSequence, type });
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { worker.pending.delete(id); reject(new Error(`RPC ${type} timed out`)); }, this.requestTimeout);
      worker.pending.set(id, { resolve, reject, timer });
    });
    try { worker.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); }
    catch (error) {
      const pending = worker.pending.get(id);
      if (pending) { clearTimeout(pending.timer); worker.pending.delete(id); pending.reject(error); }
    }
    return response;
  }
  async bindAndPrompt(worker, node, generation, token, prompt, spec) {
    const scope = Buffer.from(JSON.stringify({ roots: [spec.cwd], paths: spec.paths })).toString("base64url");
    const bound = await this.command(worker, "prompt", { message: `/orchestrator-bind ${node} ${generation} ${token} ${worker.role} ${scope}` });
    if (!bound.success) throw new Error("RPC binding failed");
    return this.command(worker, "prompt", { message: prompt, streamingBehavior: "followUp" });
  }
  terminate(worker) {
    if (worker.exited) return;
    try {
      if (process.platform !== "win32" && Number.isInteger(worker.child.pid) && worker.child.pid > 0) process.kill(-worker.child.pid, "SIGTERM");
      else worker.child.kill?.("SIGTERM");
    } catch { try { worker.child.kill?.("SIGTERM"); } catch {} }
  }
  async cancel(worker) {
    if (worker.exited) return;
    if (worker.shutdownPromise) return worker.shutdownPromise;
    this.terminate(worker);
    worker.shutdownPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker ${worker.id} did not exit within ${this.shutdownTimeout}ms`)), this.shutdownTimeout);
      worker.exitPromise.then((value) => { clearTimeout(timer); resolve(value); });
    });
    try { return await worker.shutdownPromise; }
    finally { if (!worker.exited) worker.shutdownPromise = undefined; }
  }
  async shutdown() { await Promise.all([...this.workers.values()].map((worker) => this.cancel(worker))); }
  reusable({ runId, role, cwd, policy, stage }) { return [...this.workers.values()].find((worker) => !worker.terminated && !worker.busy && worker.runId === runId && worker.role === role && worker.cwd === cwd && worker.policy === policy && worker.stage === stage); }
}
