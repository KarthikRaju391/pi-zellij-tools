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
export const roleRoute = Object.freeze({ investigator: { model: "openai-codex/gpt-5.6-terra", thinking: "medium" }, verifier: { model: "openai-codex/gpt-5.6-terra", thinking: "medium" }, writer: { model: "openai-codex/gpt-5.6-terra", thinking: "medium" }, reviewer: { model: "openai-codex/gpt-5.6-terra", thinking: "high" } });
export class WorkerAdapter {
  constructor({ stateDir, extension = extensionPath, spawnProcess = spawn }) { this.stateDir = stateDir; this.extension = extension; this.spawnProcess = spawnProcess; this.workers = new Map(); }
  sessionDir(worker) { return join(this.stateDir, "workers", worker.id); }
  argv(worker) { const route = roleRoute[worker.role]; return ["--mode", "rpc", "--model", worker.model ?? route.model, "--thinking", worker.thinking ?? route.thinking, "--session-dir", this.sessionDir(worker), "--no-extensions", "-e", this.extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", roleTools[worker.role].join(",")]; }
  start(worker, onEvent) {
    mkdirSync(this.sessionDir(worker), { recursive: true, mode: 0o700 }); chmodSync(this.sessionDir(worker), 0o700);
    const child = this.spawnProcess("pi-pool", this.argv(worker), { cwd: worker.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const record = { ...worker, sessionDir: this.sessionDir(worker), child, busy: false, idle: true, reports: [], pending: new Map() };
    const parser = new LfJsonl((event) => { if (event.type === "response" && event.id && record.pending.has(event.id)) { const pending = record.pending.get(event.id); clearTimeout(pending.timer); pending.resolve(event); record.pending.delete(event.id); return; } if (event.type === "tool_execution_end" && event.toolName === "orchestrator_report" && !event.isError) record.reports.push(event.result?.details); if (event.type === "agent_settled") record.idle = true; onEvent?.(event, record); });
    child.stdout.on("data", (chunk) => { try { parser.write(chunk); } catch (error) { onEvent?.({ type: "protocol_error", error: String(error) }, record); } }); child.stdout.on("end", () => parser.end()); child.on?.("exit", () => { for (const pending of record.pending.values()) pending.reject(new Error("RPC process exited")); record.pending.clear(); onEvent?.({ type: "process_exit" }, record); }); child.stderr.on("data", (chunk) => onEvent?.({ type: "stderr", text: String(chunk) }, record)); this.workers.set(record.id, record); return record;
  }
  command(worker, type, fields = {}) { const id = idFor("command", { worker: worker.id, type, fields }); const response = new Promise((resolve, reject) => { const timer = setTimeout(() => { worker.pending.delete(id); reject(new Error(`RPC ${type} timed out`)); }, 15000); worker.pending.set(id, { resolve, reject, timer }); }); worker.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); return response; }
  async bindAndPrompt(worker, node, generation, token, prompt, spec) {
    const scope = Buffer.from(JSON.stringify({ roots: [spec.cwd], paths: spec.paths })).toString("base64url"); const bound = await this.command(worker, "prompt", { message: `/orchestrator-bind ${node} ${generation} ${token} ${worker.role} ${scope}` }); if (!bound.success) throw new Error("RPC binding failed"); return this.command(worker, "prompt", { message: prompt, streamingBehavior: "followUp" });
  }
  cancel(worker) { try { if (worker.child.pid) void this.command(worker, "abort").catch(() => {}); worker.child.kill("SIGTERM"); } catch {} }
  shutdown() { for (const worker of this.workers.values()) this.cancel(worker); }
  reusable({ runId, role, cwd, policy, model, stage }) { return [...this.workers.values()].find((w) => !w.busy && w.runId === runId && w.role === role && w.cwd === cwd && w.policy === policy && w.model === model && w.stage === stage); }
}
