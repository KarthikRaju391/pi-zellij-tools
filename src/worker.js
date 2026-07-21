import { spawn } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { idFor } from "./state.js";
import { roleTools } from "./workflows.js";

export class LfJsonl {
  constructor(onValue) { this.onValue = onValue; this.decoder = new StringDecoder("utf8"); this.buffer = ""; }
  write(chunk) { this.buffer += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : chunk; for (;;) { const index = this.buffer.indexOf("\n"); if (index < 0) return; const line = this.buffer.slice(0, index).replace(/\r$/, ""); this.buffer = this.buffer.slice(index + 1); if (line) this.onValue(JSON.parse(line)); } }
  end() { this.buffer += this.decoder.end(); if (this.buffer) this.onValue(JSON.parse(this.buffer.replace(/\r$/, ""))); }
}
const extensionPath = fileURLToPath(new URL("../extensions/orchestrator-worker.ts", import.meta.url));
export class WorkerAdapter {
  constructor({ stateDir, extension = extensionPath, spawnProcess = spawn }) { this.stateDir = stateDir; this.extension = extension; this.spawnProcess = spawnProcess; this.workers = new Map(); }
  sessionDir(worker) { return join(this.stateDir, "workers", worker.id); }
  argv(worker) { return ["--mode", "rpc", "--model", worker.model, "--session-dir", this.sessionDir(worker), "--no-extensions", "-e", this.extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", roleTools[worker.role].join(",")]; }
  start(worker, onEvent) {
    mkdirSync(this.sessionDir(worker), { recursive: true, mode: 0o700 }); chmodSync(this.sessionDir(worker), 0o700);
    const child = this.spawnProcess("pi-pool", this.argv(worker), { cwd: worker.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const record = { ...worker, sessionDir: this.sessionDir(worker), child, busy: false, idle: true, reports: [] };
    const parser = new LfJsonl((event) => { if (event.type === "tool_execution_end" && event.toolName === "orchestrator_report" && !event.isError) record.reports.push(event.result?.details); if (event.type === "agent_settled") record.idle = true; onEvent?.(event, record); });
    child.stdout.on("data", (chunk) => parser.write(chunk)); child.stdout.on("end", () => parser.end()); child.stderr.on("data", (chunk) => onEvent?.({ type: "stderr", text: String(chunk) }, record)); this.workers.set(record.id, record); return record;
  }
  command(worker, type, fields = {}) { const id = idFor("command", { worker: worker.id, type, fields }); worker.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); return id; }
  bindAndPrompt(worker, node, generation, token, prompt, spec) {
    const scope = Buffer.from(JSON.stringify({ roots: [spec.cwd], paths: spec.paths })).toString("base64url");
    this.command(worker, "prompt", { message: `/orchestrator-bind ${node} ${generation} ${token} ${worker.role} ${scope}` });
    return this.command(worker, "prompt", { message: prompt, streamingBehavior: "followUp" });
  }
  cancel(worker) { try { this.command(worker, "abort"); worker.child.kill("SIGTERM"); } catch {} }
  shutdown() { for (const worker of this.workers.values()) this.cancel(worker); }
  reusable({ runId, role, cwd, policy, model, stage }) { return [...this.workers.values()].find((w) => !w.busy && w.runId === runId && w.role === role && w.cwd === cwd && w.policy === policy && w.model === model && w.stage === stage); }
}
