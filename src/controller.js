import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { newRun, idFor, TERMINAL, validateSpec } from "./state.js";
import { Lease, Store } from "./store.js";
import { roleRoute } from "./worker.js";
import { Effect, GitEffects } from "./effects.js";
import { workflow } from "./workflows.js";

const agentDone = (node) => ["ok", "approved", "changes_requested"].includes(node?.status);
export class Controller {
  constructor({ store = new Store(), workers, effectsFor = (spec) => new GitEffects({ spec }), token = () => randomUUID() }) { this.store = store; this.workers = workers; this.effectsFor = effectsFor; this.token = token; this.queue = Promise.resolve(); }
  enqueue(fn) { this.queue = this.queue.then(fn, fn); return this.queue; }
  async start({ workflow: name, spec, model }) {
    let validated = validateSpec(spec, name); validated = Object.freeze({ ...validated, cwd: await realpath(validated.cwd).catch(() => validated.cwd) }); const active = await this.store.activeForTask(validated.taskKey); if (active) throw new Error(`active run already owns taskKey ${validated.taskKey}: ${active.id}`);
    const draft = newRun({ workflow: name, spec: validated, model }); await this.store.claim(validated.taskKey, validated.cwd, draft.id); try { this.effects = this.effectsFor(validated); if (name === "fix-to-pr") await this.effects.preflight?.(); this.run = await this.store.create(draft); return this.acquire(); } catch (error) { await this.store.releaseClaim(validated.taskKey, validated.cwd); throw error; }
  }
  async resume(id) { this.run = await this.store.load(id); this.effects = this.effectsFor(this.run.spec); if (this.run.workflow === "fix-to-pr") await this.effects.preflight?.(); await this.acquire(); return this.enqueue(() => this.recover()); }
  async acquire() { this.plan = workflow(this.run.workflow); this.lease = new Lease(this.store.dir, this.run.id); const lock = await this.lease.acquire(this.run.generation + 1); return this.event({ id: idFor("lease", lock), type: "lease-acquired", generation: lock.generation, lease: lock.lease }); }
  async close() { this.workers.shutdown?.(); await this.lease?.release(); if (this.run && ["done", "cancelled", "failed"].includes(this.run.status)) await this.store.releaseClaim(this.run.taskKey, this.run.cwd); }
  fenced(type, extra = {}) { return { id: idFor("event", { run: this.run.id, generation: this.run.generation, lease: this.run.lease, type, extra }), type, generation: this.run.generation, lease: this.run.lease, ...extra }; }
  async event(event) { this.run = await this.store.append(this.run, event); return this.run; }
  async recover() {
    const writer = Object.values(this.run.nodes).find((node) => node.role === "writer" && ["running", "retry"].includes(node.status));
    const writeEffect = Object.values(this.run.effects).find((effect) => effect.status === "started" && [Effect.COMMIT, Effect.REBASE, Effect.PUBLISH_PR].includes(effect.kind));
    if (writer || writeEffect) return this.event(this.fenced("recovery-wait", { reason: writer ? "recovery-interrupted-writer" : `recovery-interrupted-${writeEffect.kind}` }));
    for (const [node, state] of Object.entries(this.run.nodes)) if (state.status === "running" && state.role !== "writer") await this.event(this.fenced("agent-settled", { node, attempt: state.attempts }));
    return this.run;
  }
  stageState(stage) { const node = this.run.nodes[stage.id]; if (!node || node.status === "retry" || node.status === "pending") return "dispatch"; if (node.status === "running") return "wait"; if (["failed", "blocked"].includes(node.status)) return "stop"; return "done"; }
  next() { for (const stage of this.plan) { if (stage.type === "parallel") { const states = stage.nodes.map((node) => this.stageState(node)); if (states.includes("stop")) return { type: "stop", reason: "parallel-agent-failed" }; if (states.includes("dispatch")) return { type: "parallel-dispatch", stage }; if (states.includes("wait")) return { type: "wait" }; continue; } if (stage.type === "agent") { const state = this.stageState(stage); if (state === "stop") return { type: "stop", reason: `${stage.id}-failed` }; if (state === "dispatch") return { type: "agent", stage }; if (state === "wait") return { type: "wait" }; continue; } const effect = this.run.effects[stage.id]; if (!effect || effect.status === "retry") return { type: "effect", stage }; if (effect.status === "started") return { type: "stop", reason: `interrupted-${effect.kind}` }; if (effect.status === "failed") return { type: "effect", stage }; } return { type: "finished" }; }
  prompt(stage) {
    const spec = this.run.spec; const feedback = this.run.feedback ? `\nReviewer feedback to address:\n${this.run.feedback}` : ""; const exact = stage.exactHeadOf ? this.run.nodes[stage.exactHeadOf]?.head ?? this.run.effects[stage.exactHeadOf]?.result?.head : undefined;
    return `Task ${spec.taskKey}: ${spec.objective}\nScope: ${spec.paths.join(", ")}\nWork only in ${spec.cwd}. ${spec.instructionsArtifact ? `Instructions artifact: ${spec.instructionsArtifact}\n` : ""}${spec.instructions ? `Applicable instructions:\n${spec.instructions.slice(0, 8000)}\n` : ""}${stage.role === "reviewer" ? `Independently review exact HEAD ${exact}; report approved or changes_requested with actionable feedback.` : "Make the smallest scoped change and report findings, changedFiles, checks, and blockers."}${feedback}`;
  }
  async pump() {
    while (!TERMINAL.has(this.run.status)) { const next = this.next(); if (next.type === "wait") return this.run; if (next.type === "stop") return this.event(this.fenced("recovery-wait", { reason: next.reason })); if (next.type === "finished") { if (this.run.workflow !== "fix-to-pr") await this.event(this.fenced("complete", { pr: undefined })); return this.run; } if (next.type === "parallel-dispatch") { for (const stage of next.stage.nodes) if (this.stageState(stage) === "dispatch") await this.dispatch(stage); return this.run; } if (next.type === "agent") { await this.dispatch(next.stage); return this.run; } await this.effect(next.stage); }
    return this.run;
  }
  async dispatch(stage) {
    const old = this.run.nodes[stage.id]; const policy = stage.role === "writer" ? "write" : "read-only"; const head = stage.exactHeadOf ? this.run.nodes[stage.exactHeadOf]?.head ?? this.run.effects[stage.exactHeadOf]?.result?.head : undefined;
    let worker = this.workers.reusable({ runId: this.run.id, role: stage.role, cwd: this.run.cwd, policy, model: this.run.model, stage: stage.id });
    if (!worker) worker = this.workers.start({ id: idFor("worker", { run: this.run.id, stage: stage.id }), runId: this.run.id, role: stage.role, cwd: this.run.cwd, policy, model: this.run.model, stage: stage.id }, (event, record) => { void this.onWorkerEvent(stage, event, record); });
    worker.busy = true; worker.idle = false; worker.token = this.token(); await this.event(this.fenced("node-started", { node: stage.id, role: stage.role, worker: worker.id, sessionDir: worker.sessionDir, pid: worker.child.pid, route: roleRoute[stage.role], policy, head, attempt: old?.attempts ?? 0 }));
    try { await this.workers.bindAndPrompt(worker, stage.id, this.run.generation, worker.token, this.prompt(stage), this.run.spec); } catch (error) { worker.busy = false; await this.event(this.fenced("recovery-wait", { reason: `rpc-bind-failed-${stage.id}: ${String(error).slice(0, 300)}` })); } return this.run;
  }
  onWorkerEvent(stage, event, worker) { return this.enqueue(() => this._onWorkerEvent(stage, event, worker)); }
  async _onWorkerEvent(stage, event, worker) {
    if (TERMINAL.has(this.run.status)) return;
    if (event.type === "stderr") return; // pi-pool emits account/status diagnostics on stderr.
    if (["process_exit", "protocol_error"].includes(event.type)) return this.event(this.fenced("recovery-wait", { reason: `worker-${stage.id}-${event.type}` }));
    if (event.type === "tool_execution_end" && event.toolName === "orchestrator_report" && !event.isError) {
      const report = event.result?.details; if (report?.node !== stage.id || report.generation !== this.run.generation || report.token !== worker.token || report.role !== stage.role) return;
      worker.busy = false; let head; try { head = await this.effects.head(); } catch { return this.event(this.fenced("recovery-wait", { reason: "cannot-validate-head" })); }
      if (stage.role === "reviewer") {
        const expected = this.run.nodes[stage.id]?.head; if (!expected || expected !== head) return this.event(this.fenced("recovery-wait", { reason: "stale-review-head" }));
        if (report.outcome === "changes_requested") { await this.event(this.fenced("review-changes", { node: stage.id, feedback: report.feedback || report.summary })); await this.pump(); return this.run; }
        if (report.outcome !== "approved") return this.event(this.fenced("recovery-wait", { reason: "reviewer-must-approve-or-request-changes" }));
      } else if (!["ok", "failed", "blocked"].includes(report.outcome)) return this.event(this.fenced("recovery-wait", { reason: "invalid-agent-outcome" }));
      await this.event(this.fenced("report", { node: stage.id, role: stage.role, outcome: report.outcome, report, head, attempt: this.run.nodes[stage.id]?.attempts ?? 0 }));
      if (["failed", "blocked"].includes(report.outcome)) return this.event(this.fenced("recovery-wait", { reason: `${stage.id}-${report.outcome}` })); await this.pump(); if (TERMINAL.has(this.run.status)) await this.close(); return this.run;
    }
    if (event.type === "agent_settled") { worker.busy = false; worker.idle = true; const node = this.run.nodes[stage.id]; if (node?.status === "running") { await this.event(this.fenced("agent-settled", { node: stage.id, attempt: node.attempts })); await this.pump(); if (TERMINAL.has(this.run.status)) await this.close(); return this.run; } }
  }
  async effect(stage) {
    const kind = Object.values(Effect).includes(stage.effect) ? stage.effect : Effect.CHECKS; if ([Effect.RECONCILE_PR, Effect.PUBLISH_PR].includes(kind)) { const approved = this.run.nodes["review-head"]?.head; const current = await this.effects.head(); if (!approved || current !== approved) return this.event(this.fenced("recovery-wait", { reason: "final-review-head-stale" })); } const old = this.run.effects[stage.id];
    if (old?.status === "started" && [Effect.COMMIT, Effect.REBASE, Effect.PUBLISH_PR].includes(old.kind)) return this.event(this.fenced("recovery-wait", { reason: `interrupted-${old.kind}` }));
    const attempt = (old?.attempts ?? 0) + 1; let beforeHead; try { beforeHead = await this.effects.head(); } catch {} await this.event(this.fenced("effect-started", { effect: stage.id, kind, attempt, beforeHead }));
    try { const result = await this.effects.run(kind); await this.event(this.fenced("effect-finished", { effect: stage.id, kind, outcome: "ok", result, attempt })); if (kind === Effect.RECONCILE_PR && result.existing) return this.event(this.fenced("complete", { pr: result.existing })); if (kind === Effect.PUBLISH_PR) await this.event(this.fenced("complete", { pr: result.pr })); }
    catch (error) { if (kind === Effect.CHECKS && attempt < 2) await this.event(this.fenced("effect-finished", { effect: stage.id, kind, outcome: "failed", result: String(error), attempt })); else if (kind === Effect.CHECKS) await this.event(this.fenced("review-changes", { node: "write", feedback: `Configured check failed twice: ${String(error).slice(0, 4000)}` })); else await this.event(this.fenced("recovery-wait", { reason: `interrupted-or-failed-${kind}` })); }
    return this.run;
  }
  async reconcile(target, decision) {
    if (!Object.hasOwn(this.run.nodes, target) && !Object.hasOwn(this.run.effects, target)) throw new Error("reconciliation target is not persisted");
    if (!["abandon", "confirmed-applied", "confirmed-not-applied"].includes(decision)) throw new Error("specific reconciliation decision required");
    return this.enqueue(async () => { let result; let kind; if (decision === "confirmed-applied") { kind = this.run.effects[target]?.kind; if (kind !== Effect.PUBLISH_PR) throw new Error("confirmed-applied is allowed only for exact open PR proof"); if (!this.effects.prove) throw new Error("exact read-only proof is unavailable"); result = await this.effects.prove(kind, this.run.effects[target]); if (!result || (kind !== Effect.PUBLISH_PR && !result.head) || (kind === Effect.PUBLISH_PR && !result.pr)) throw new Error("exact proof did not establish outcome"); } await this.event(this.fenced("reconcile", { target, decision, result })); if (kind === Effect.PUBLISH_PR && decision === "confirmed-applied") await this.event(this.fenced("complete", { pr: result.pr })); if (this.run.status === "running") await this.pump(); return this.run; });
  }
  async cancel(reason) { return this.enqueue(() => this.event(this.fenced("cancel", { reason }))); }
}
