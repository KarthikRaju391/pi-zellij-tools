import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { idFor } from "./state.js";
import { roleTools } from "./workflows.js";

/** LF-only JSONL decoder: unlike readline it preserves U+2028/U+2029 inside JSON strings. */
export class LfJsonl {
  constructor(onValue) { this.onValue = onValue; this.decoder = new StringDecoder("utf8"); this.buffer = ""; }
  write(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : chunk;
    for (;;) { const index = this.buffer.indexOf("\n"); if (index < 0) return; const line = this.buffer.slice(0, index).replace(/\r$/, ""); this.buffer = this.buffer.slice(index + 1); if (line) this.onValue(JSON.parse(line)); }
  }
  end() { this.buffer += this.decoder.end(); if (this.buffer) this.onValue(JSON.parse(this.buffer.replace(/\r$/, ""))); this.buffer = ""; }
}

export class WorkerAdapter {
  constructor({ stateDir, extension = join(process.cwd(), "extensions", "orchestrator-worker.ts"), spawnProcess = spawn }) { this.stateDir = stateDir; this.extension = extension; this.spawnProcess = spawnProcess; this.workers = new Map(); }
  argv(worker) {
    return ["--mode", "rpc", "--model", worker.model, "--session-dir", join(this.stateDir, "workers", worker.id), "--no-extensions", "-e", this.extension,
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", roleTools[worker.role].join(",")];
  }
  start(worker, onEvent) {
    const child = this.spawnProcess("pi-pool", this.argv(worker), { cwd: worker.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const record = { ...worker, child, reports: [], busy: false, settled: false };
    const parser = new LfJsonl((event) => { if (event.type === "tool_execution_end" && event.toolName === "orchestrator_report" && !event.isError) record.reports.push(event.result?.details); if (event.type === "agent_settled") record.settled = true; onEvent?.(event, record); });
    child.stdout.on("data", (chunk) => parser.write(chunk)); child.stdout.on("end", () => parser.end());
    child.stderr.on("data", (chunk) => onEvent?.({ type: "stderr", text: String(chunk) }, record));
    this.workers.set(worker.id, record); return record;
  }
  command(worker, type, fields = {}) { const id = idFor("command", { worker: worker.id, type, fields }); worker.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); return id; }
  bindAndPrompt(worker, node, generation, token, prompt) {
    this.command(worker, "prompt", { message: `/orchestrator-bind ${node} ${generation} ${token} ${worker.role}` });
    return this.command(worker, "prompt", { message: prompt, streamingBehavior: "followUp" });
  }
  cancel(worker) { try { this.command(worker, "abort"); worker.child.kill("SIGTERM"); } catch { /* already exited */ } }
  shutdown() { for (const worker of this.workers.values()) this.cancel(worker); }
  reusable({ runId, role, cwd, policy, model }) { return [...this.workers.values()].find((w) => !w.busy && !w.settled && w.runId === runId && w.role === role && w.cwd === cwd && w.policy === policy && w.model === model); }
}
