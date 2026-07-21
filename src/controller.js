import { randomUUID } from "node:crypto";
import { newRun, idFor, TERMINAL } from "./state.js";
import { Lease, Store } from "./store.js";
import { Effect, canReconcile } from "./effects.js";
import { workflow } from "./workflows.js";

const flatten = (nodes) => nodes.flatMap((node) => node.type === "parallel" ? node.nodes : [node]);

export class Controller {
  constructor({ store = new Store(), workers, effects, token = () => randomUUID() }) { this.store = store; this.workers = workers; this.effects = effects; this.token = token; this.run = undefined; this.lease = undefined; }
  async start({ workflow: name, cwd, authorized = false, model }) {
    const plan = workflow(name);
    if (name === "fix-to-pr" && !authorized) throw new Error("fix-to-pr requires recorded edit authorization");
    if (name === "fix-to-pr") await this.effects.assertClean?.();
    this.run = await this.store.create(newRun({ workflow: name, cwd, authorized, model }));
    return this.acquire(plan);
  }
  async resume(id) { this.run = await this.store.load(id); return this.acquire(workflow(this.run.workflow)); }
  async acquire(plan) {
    this.plan = plan; this.lease = new Lease(this.store.dir, this.run.id);
    const lock = await this.lease.acquire(this.run.generation + 1);
    this.run = await this.event({ id: idFor("lease", lock), type: "lease-acquired", generation: lock.generation, lease: lock.lease });
    return this.run;
  }
  async close() { this.workers.shutdown?.(); await this.lease?.release(); }
  fenced(type, extra = {}) { return { id: idFor("event", { run: this.run.id, type, extra, generation: this.run.generation, lease: this.run.lease }), type, generation: this.run.generation, lease: this.run.lease, ...extra }; }
  async event(event) { this.run = await this.store.append(this.run, event); return this.run; }
  next() {
    const stages = flatten(this.plan);
    return stages.find((stage) => {
      if (stage.type === "gate") return !this.run.authorized;
      if (stage.type === "agent") return !["ok", "failed"].includes(this.run.nodes[stage.id]?.status);
      return this.run.effects[stage.id]?.status !== "ok";
    });
  }
  async pump(promptFor = () => "Work only within the approved scope. End by calling orchestrator_report.") {
    while (!TERMINAL.has(this.run.status)) {
      const stage = this.next();
      if (!stage) return this.run;
      await this.step(promptFor);
      if (stage.type === "agent") return this.run; // worker events re-enter the pump
    }
    return this.run;
  }
  async step(promptFor = () => "Work only within the approved scope. End by calling orchestrator_report.") {
    if (TERMINAL.has(this.run.status)) return this.run;
    const stage = this.next();
    if (!stage) return this.run;
    if (stage.type === "gate") return this.event(this.fenced("fail", { reason: "authorization missing" }));
    if (stage.type === "agent") return this.dispatch(stage, promptFor(stage));
    return this.effect(stage);
  }
  async dispatch(stage, prompt) {
    const existing = this.run.nodes[stage.id];
    if (existing?.status === "retry") return this.dispatch({ ...stage, retry: true }, `${prompt}\nYou settled without a report. Report now; do not repeat work.`);
    const policy = stage.role === "writer" ? "write" : "read-only";
    const head = stage.exactHeadOf ? this.run.nodes[stage.exactHeadOf]?.head ?? this.run.effects[stage.exactHeadOf]?.result?.head : undefined;
    let worker = this.workers.reusable({ runId: this.run.id, role: stage.role, cwd: this.run.cwd, policy, model: this.run.model });
    // A worker's RPC callback is bound to one node; only retry that exact node.
    if (worker?.stage !== stage.id) worker = undefined;
    if (!worker) worker = this.workers.start({ id: idFor("worker", { run: this.run.id, node: stage.id }), runId: this.run.id, role: stage.role, cwd: this.run.cwd, policy, model: this.run.model }, (event, record) => this.onWorkerEvent(stage, event, record));
    worker.stage = stage.id; worker.busy = true; worker.token = this.token();
    await this.event(this.fenced("node-started", { node: stage.id, role: stage.role, worker: worker.id, head, attempt: existing?.attempts ?? 0 }));
    this.workers.bindAndPrompt(worker, stage.id, this.run.generation, worker.token, `${prompt}${head ? `\nReview exact HEAD: ${head}` : ""}`);
    return this.run;
  }
  async onWorkerEvent(stage, event, worker) {
    if (!this.run || TERMINAL.has(this.run.status)) return;
    if (event.type === "tool_execution_end" && event.toolName === "orchestrator_report" && !event.isError) {
      const report = event.result?.details;
      // The extension adds binding identity from its private command state, not model arguments.
      if (report?.node === stage.id && report.generation === this.run.generation && report.token === worker.token && report.role === stage.role) {
        worker.busy = false;
        let actualHead;
        try { actualHead = this.effects.head ? await this.effects.head() : undefined; } catch { /* controller will not invent a head */ }
        const expectedHead = this.run.nodes[stage.id]?.head;
        const outcome = stage.role === "reviewer" && expectedHead && actualHead !== expectedHead ? "failed" : report.outcome;
        await this.event(this.fenced("report", { node: stage.id, role: stage.role, outcome, report, head: actualHead, attempt: this.run.nodes[stage.id]?.attempts ?? 0 }));
        await this.pump();
        if (TERMINAL.has(this.run.status)) await this.close();
      }
    }
    if (event.type === "agent_settled") {
      worker.busy = false;
      const node = this.run.nodes[stage.id];
      if (node?.status === "running") { await this.event(this.fenced("agent-settled", { node: stage.id, attempt: node.attempts })); await this.pump(); if (TERMINAL.has(this.run.status)) await this.close(); }
    }
  }
  async effect(stage) {
    const kind = stage.effect === "publish-pr" ? Effect.PUBLISH_PR : stage.effect === "rebase" ? Effect.REBASE : stage.effect === "commit" ? Effect.COMMIT : Effect.CHECKS;
    const attempt = (this.run.effects[stage.id]?.attempts ?? 0) + 1;
    await this.event(this.fenced("effect-started", { effect: stage.id, kind, attempt }));
    try {
      const result = await this.effects.run(kind);
      await this.event(this.fenced("effect-finished", { effect: stage.id, kind, outcome: "ok", result, attempt }));
      if (kind === Effect.PUBLISH_PR) await this.event(this.fenced("complete", { pr: result.pr, ci: "pending" }));
    } catch (error) {
      // A local/external write could have happened before the error; no replay without human reconciliation.
      const attempts = this.run.effects[stage.id]?.attempts ?? 0;
      if (kind === Effect.CHECKS && attempts < 2) await this.event(this.fenced("effect-finished", { effect: stage.id, kind, outcome: "failed", result: String(error), attempt }));
      else if (kind === Effect.CHECKS || kind === Effect.COMMIT || kind === Effect.PUBLISH_PR || kind === Effect.REBASE) await this.event(this.fenced("effect-unknown", { kind, attempt }));
      else throw error;
    }
    return this.run;
  }
  async approve() { return this.event(this.fenced("approve")); }
  async cancel(reason) { return this.event(this.fenced("cancel", { reason })); }
  async reconcile(kind, proof) { if (!canReconcile(kind, proof)) return this.event(this.fenced("effect-unknown", { kind })); return this.approve(); }
}
