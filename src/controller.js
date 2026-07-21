import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { newRun, idFor, TERMINAL, validateSpec } from "./state.js";
import { Lease, Store } from "./store.js";
import { roleRoute } from "./worker.js";
import { Effect, GitEffects } from "./effects.js";
import { workflow } from "./workflows.js";

export class Controller {
  constructor({ store = new Store(), workers, effectsFor = (spec) => new GitEffects({ spec }), token = () => randomUUID(), cancelPollMs = 100 }) { this.store = store; this.workers = workers; this.effectsFor = effectsFor; this.token = token; this.cancelPollMs = cancelPollMs; this.queue = Promise.resolve(); }
  enqueue(fn) { this.queue = this.queue.then(fn, fn); return this.queue; }
  async start({ workflow: name, spec, model }) {
    if (model !== undefined) throw new Error("per-run model override is not supported");
    workflow(name);
    let validated = validateSpec(spec, name); validated = Object.freeze({ ...validated, cwd: await realpath(validated.cwd).catch(() => validated.cwd) }); const active = await this.store.activeForTask(validated.taskKey); if (active) throw new Error(`active run already owns taskKey ${validated.taskKey}: ${active.id}`);
    const draft = newRun({ workflow: name, spec: validated }); await this.store.claim(validated.taskKey, validated.cwd, draft.id); let created = false;
    try { this.effects = this.effectsFor(validated); if (name === "fix-to-pr") await this.effects.preflight?.(); this.run = await this.store.create(draft); created = true; return this.acquire(); }
    catch (error) { if (!created) await this.store.releaseClaim(validated.taskKey, validated.cwd, draft.id); throw error; }
  }
  async resume(id, { recover = true } = {}) {
    const run = await this.store.load(id); const effects = this.effectsFor(run.spec);
    if (run.workflow === "fix-to-pr") await effects.preflight?.({ allowDirty: true });
    await this.store.claim(run.taskKey, run.cwd, run.id); this.run = run; this.effects = effects;
    await this.acquire(); return recover ? this.enqueue(() => this.recover()) : this.run;
  }
  async acquire({ watchCancel = true } = {}) {
    this.plan = workflow(this.run.workflow); this.lease = new Lease(this.store.dir, this.run.id); const lock = await this.lease.acquire(this.run.generation + 1);
    await this.event({ id: idFor("lease", lock), type: "lease-acquired", generation: lock.generation, lease: lock.lease });
    if (watchCancel) { this.startCancelWatcher(); await this.pollCancelRequest(); }
    return this.run;
  }
  startCancelWatcher() { if (this.cancelTimer || this.closed) return; this.cancelTimer = setInterval(() => { void this.pollCancelRequest().catch((error) => { this.cancelPollError = error; }); }, this.cancelPollMs); this.cancelTimer.unref?.(); }
  stopCancelWatcher() { if (this.cancelTimer) clearInterval(this.cancelTimer); this.cancelTimer = undefined; }
  async pollCancelRequest() {
    if (!this.run || this.closed || this.cancelPollInFlight) return this.run; this.cancelPollInFlight = true;
    try {
      const request = await this.store.readCancel(this.run.id);
      if (request) await this.enqueue(() => this.applyCancelRequest(request));
      else if (this.run.status === "cancelling") await this.enqueue(async () => { await this._cancel(this.run.reason); if (this.run.status === "cancelled") await this.close(); return this.run; });
      else if (this.run.status === "closing") await this.enqueue(() => this._finishClosing());
      return this.run;
    } finally { this.cancelPollInFlight = false; }
  }
  async applyCancelRequest(request) {
    if (request.runId !== this.run.id) return this.run;
    if (this.run.status === "closing") { await this.store.consumeCancel(this.run.id, request.id); return this._finishClosing(); }
    if (!["done", "failed", "cancelled"].includes(this.run.status)) await this._cancel(request.reason, request.id);
    if (this.run.status !== "cancelled") return this.run;
    await this.close(); await this.store.consumeCancel(this.run.id, request.id); return this.run;
  }
  async close() {
    if (this.run?.status === "closing") return this._finishClosing();
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await this.workers?.shutdown?.();
      if (this.run && await this.store.workersAlive(this.run)) return this.run;
      this.closed = true; this.stopCancelWatcher(); this.signalCleanup?.(); this.signalCleanup = undefined;
      await this.lease?.release();
      if (this.run && ["done", "cancelled", "failed"].includes(this.run.status)) await this.store.releaseClaim(this.run.taskKey, this.run.cwd, this.run.id);
      return this.run;
    })();
    try { return await this.closePromise; }
    finally { if (!this.closed) this.closePromise = undefined; }
  }
  async beginClosing(outcome) {
    if (this.run.status !== "closing") await this.event(this.fenced("closing", outcome));
    return this._finishClosing();
  }
  async _finishClosing() {
    if (this.run.status !== "closing") return this.run;
    try { await this.workers?.shutdown?.(); }
    catch (error) { this.shutdownError = error; return this.run; }
    if (await this.store.workersAlive(this.run)) return this.run;
    const pending = this.run.pending;
    if (pending?.status === "done") await this.event(this.fenced("complete", { pr: pending.pr }));
    else if (pending?.status === "failed") await this.event(this.fenced("failed", { reason: pending.reason }));
    else throw new Error("closing run has no terminal outcome");
    return this.close();
  }
  fenced(type, extra = {}) { return { id: idFor("event", { run: this.run.id, generation: this.run.generation, lease: this.run.lease, round: this.run.reviewRounds, type, extra }), type, generation: this.run.generation, lease: this.run.lease, ...extra }; }
  async event(event) { this.run = await this.store.append(this.run, event); return this.run; }
  async waitForHuman(reason) { await this.event(this.fenced("recovery-wait", { reason })); await this.close(); return this.run; }
  async recover() {
    if (this.run.status === "closing") return this._finishClosing();
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
  async pump() { return this.enqueue(() => this._pump()); }
  async _pump() {
    if (["cancelling", "closing"].includes(this.run.status)) return this.run;
    while (!TERMINAL.has(this.run.status)) { const next = this.next(); if (next.type === "wait") return this.run; if (next.type === "stop") return this.event(this.fenced("recovery-wait", { reason: next.reason })); if (next.type === "finished") { if (this.run.workflow !== "fix-to-pr") return this.beginClosing({ outcome: "done" }); return this.run; } if (next.type === "parallel-dispatch") { for (const stage of next.stage.nodes) if (this.stageState(stage) === "dispatch") await this.dispatch(stage); return this.run; } if (next.type === "agent") { await this.dispatch(next.stage); return this.run; } await this.effect(next.stage); }
    return this.run;
  }
  async dispatch(stage) {
    const old = this.run.nodes[stage.id]; const policy = stage.role === "writer" ? "write" : "read-only"; const head = stage.exactHeadOf ? this.run.nodes[stage.exactHeadOf]?.head ?? this.run.effects[stage.exactHeadOf]?.result?.head : undefined;
    let worker = this.workers.reusable({ runId: this.run.id, role: stage.role, cwd: this.run.cwd, policy, stage: stage.id });
    if (!worker) worker = this.workers.start({ id: idFor("worker", { run: this.run.id, stage: stage.id }), runId: this.run.id, role: stage.role, cwd: this.run.cwd, policy, stage: stage.id }, (event, record) => { void this.onWorkerEvent(stage, event, record); });
    worker.busy = true; worker.idle = false; worker.token = this.token(); await this.event(this.fenced("node-started", { node: stage.id, role: stage.role, worker: worker.id, sessionDir: worker.sessionDir, pid: worker.child.pid, route: worker.route ?? roleRoute[stage.role], policy, head, attempt: old?.attempts ?? 0 }));
    try { await this.workers.bindAndPrompt(worker, stage.id, this.run.generation, worker.token, this.prompt(stage), this.run.spec); } catch (error) { worker.busy = false; await this.event(this.fenced("recovery-wait", { reason: `rpc-bind-failed-${stage.id}: ${String(error).slice(0, 300)}` })); } return this.run;
  }
  onWorkerEvent(stage, event, worker) { return this.enqueue(() => this._onWorkerEvent(stage, event, worker)); }
  async _onWorkerEvent(stage, event, worker) {
    if (TERMINAL.has(this.run.status) || ["cancelling", "closing"].includes(this.run.status)) return;
    if (event.type === "stderr") return; // pi-pool emits account/status diagnostics on stderr.
    if (["process_exit", "process_error", "protocol_error"].includes(event.type) && this.run.nodes[stage.id]?.status === "running") return this.waitForHuman(`worker-${stage.id}-${event.type}`);
    if (event.type === "tool_execution_end" && event.toolName === "orchestrator_report" && !event.isError) {
      const node = this.run.nodes[stage.id]; const report = event.result?.details;
      if (node?.status !== "running" || node.role !== stage.role || report?.node !== stage.id || report.generation !== this.run.generation || report.token !== worker.token || report.role !== stage.role) return;
      worker.busy = false; let head; if (stage.role === "writer" || stage.role === "reviewer" || stage.exactHeadOf) try { head = await this.effects.head(); } catch { return this.waitForHuman("cannot-validate-head"); }
      if (stage.role === "reviewer") {
        const expected = this.run.nodes[stage.id]?.head; if (!expected || expected !== head) return this.waitForHuman("stale-review-head");
        if (report.outcome === "changes_requested") { await this.event(this.fenced("review-changes", { node: stage.id, feedback: report.feedback || report.summary })); await this._pump(); if (TERMINAL.has(this.run.status)) await this.close(); return this.run; }
        if (report.outcome !== "approved") return this.waitForHuman("reviewer-must-approve-or-request-changes");
      } else if (!["ok", "failed", "blocked"].includes(report.outcome)) return this.waitForHuman("invalid-agent-outcome");
      await this.event(this.fenced("report", { node: stage.id, role: stage.role, outcome: report.outcome, report, head, attempt: this.run.nodes[stage.id]?.attempts ?? 0 }));
      if (["failed", "blocked"].includes(report.outcome)) return this.waitForHuman(`${stage.id}-${report.outcome}`); await this._pump(); if (TERMINAL.has(this.run.status)) await this.close(); return this.run;
    }
    if (event.type === "agent_settled") { worker.busy = false; worker.idle = true; const node = this.run.nodes[stage.id]; if (node?.status === "running") { await this.event(this.fenced("agent-settled", { node: stage.id, attempt: node.attempts })); await this._pump(); if (TERMINAL.has(this.run.status)) await this.close(); return this.run; } }
  }
  async effect(stage) {
    const kind = Object.values(Effect).includes(stage.effect) ? stage.effect : Effect.CHECKS; let approvedHead;
    if ([Effect.RECONCILE_PR, Effect.PUBLISH_PR].includes(kind)) { const review = this.run.nodes["review-head"]; approvedHead = review?.status === "approved" ? review.head : undefined; let current; try { current = await this.effects.head(); } catch { return this.event(this.fenced("recovery-wait", { reason: "cannot-read-final-head" })); } if (!approvedHead || current !== approvedHead) return this.event(this.fenced("recovery-wait", { reason: "final-review-head-stale" })); } const old = this.run.effects[stage.id];
    if (old?.status === "started" && [Effect.COMMIT, Effect.REBASE, Effect.PUBLISH_PR].includes(old.kind)) return this.event(this.fenced("recovery-wait", { reason: `interrupted-${old.kind}` }));
    const attempt = (old?.attempts ?? 0) + 1; let beforeHead; try { beforeHead = await this.effects.head(); } catch {} await this.event(this.fenced("effect-started", { effect: stage.id, kind, attempt, beforeHead, approvedHead }));
    try { const result = await this.effects.run(kind, { approvedHead }); await this.event(this.fenced("effect-finished", { effect: stage.id, kind, outcome: "ok", result, attempt })); if (kind === Effect.RECONCILE_PR && result.existing) return this.beginClosing({ outcome: "done", pr: result.existing }); if (kind === Effect.PUBLISH_PR) return this.beginClosing({ outcome: "done", pr: result.pr }); }
    catch (error) { if (kind === Effect.CHECKS && attempt < 2) await this.event(this.fenced("effect-finished", { effect: stage.id, kind, outcome: "failed", result: String(error), attempt })); else if (kind === Effect.CHECKS) await this.event(this.fenced("review-changes", { node: "write", feedback: `Configured check failed twice: ${String(error).slice(0, 4000)}` })); else await this.event(this.fenced("recovery-wait", { reason: `interrupted-or-failed-${kind}` })); }
    return this.run;
  }
  async requestCancellation(id, reason = "CLI cancel") {
    const persisted = await this.store.load(id);
    if (persisted.status === "cancelled") { const request = await this.store.readCancel(id); if (request) await this.store.consumeCancel(id, request.id); return persisted; }
    if (["done", "failed", "closing"].includes(persisted.status)) throw new Error(`cannot cancel ${persisted.status} run`);
    const request = await this.store.requestCancel(id, reason);
    if (this.run?.id === id && this.lease?.token) return this.enqueue(() => this.applyCancelRequest(request));
    this.run = persisted;
    try { await this.acquire({ watchCancel: false }); }
    catch (error) { if (String(error).includes("controller lease already held")) return this.store.load(id); throw error; }
    return this.enqueue(() => this.applyCancelRequest(request));
  }
  approvalStages() {
    const stages = [];
    this.plan.forEach((item, index) => { if (item.type === "parallel") for (const stage of item.nodes) stages.push({ stage, index }); else stages.push({ stage: item, index }); });
    return stages;
  }
  async approve() {
    return this.enqueue(async () => {
      if (this.run.status !== "waiting-human") throw new Error("approve requires waiting-human state");
      if (["stale-review-head", "cannot-validate-head", "final-review-head-stale", "cannot-read-final-head"].includes(this.run.reason)) throw new Error("approval cannot override final-head validation");
      const stages = this.approvalStages(); const writerStages = stages.filter(({ stage }) => stage.type === "agent" && stage.role === "writer");
      if (Object.values(this.run.nodes).some((node) => node.role === "writer" && node.status !== "ok") || writerStages.some(({ stage }) => this.run.nodes[stage.id]?.status !== "ok")) throw new Error("approval cannot retry or bypass a writer");
      const effectIds = new Set(stages.filter(({ stage }) => stage.type === "effect").map(({ stage }) => stage.id));
      if (Object.entries(this.run.effects).some(([id, effect]) => !effectIds.has(id) || effect.status !== "ok")) throw new Error("approval cannot resolve effect uncertainty");
      const eligible = Object.entries(this.run.nodes).filter(([, node]) => node.role !== "writer" && ["running", "retry", "failed", "blocked"].includes(node.status));
      if (!eligible.length) throw new Error("no safe read-only node is eligible for approval");
      const byId = new Map(stages.filter(({ stage }) => stage.type === "agent").map((entry) => [entry.stage.id, entry]));
      const entries = eligible.map(([id]) => byId.get(id)); if (entries.some((entry) => !entry)) throw new Error("approval target is not in the trusted workflow");
      const indexes = new Set(entries.map((entry) => entry.index)); if (indexes.size !== 1) throw new Error("approval targets are ambiguous"); const index = entries[0].index;
      for (const { stage, index: earlier } of stages) if (earlier < index && ((stage.type === "agent" && !["ok", "approved"].includes(this.run.nodes[stage.id]?.status)) || (stage.type === "effect" && this.run.effects[stage.id]?.status !== "ok"))) throw new Error("approval would execute an unfinished prior gate");
      for (const { stage, index: later } of stages) if (later > index && ((stage.type === "agent" && this.run.nodes[stage.id] && this.run.nodes[stage.id].status !== "pending") || (stage.type === "effect" && this.run.effects[stage.id]))) throw new Error("approval would bypass a later gate");
      const reviewers = eligible.filter(([, node]) => node.role === "reviewer");
      if (reviewers.length) {
        let current; try { current = await this.effects.head(); } catch { throw new Error("approval cannot validate reviewer HEAD"); }
        for (const [id, node] of reviewers) { const stage = byId.get(id)?.stage; if (!stage?.exactHeadOf || !node.head || node.head !== current) throw new Error("approval cannot override final-head validation"); }
      }
      if (this.run.workflow === "fix-to-pr") await this.effects.assertClean?.();
      return this.event(this.fenced("approve-read-only", { nodes: eligible.map(([id]) => id) }));
    });
  }
  installSignalHandlers(target = process) {
    const handle = (signal) => {
      if (this.signalPromise) return;
      this.signalPromise = this.enqueue(async () => { if (this.run && !["done", "failed", "cancelled", "closing"].includes(this.run.status)) await this._cancel(`received ${signal}`); if (this.run?.status === "cancelled") { await this.close(); target.exitCode = signal === "SIGINT" ? 130 : 143; } }).catch((error) => { target.exitCode = 1; console.error(error); });
    };
    const onInt = () => handle("SIGINT"); const onTerm = () => handle("SIGTERM"); target.once("SIGINT", onInt); target.once("SIGTERM", onTerm);
    this.signalCleanup = () => { target.removeListener("SIGINT", onInt); target.removeListener("SIGTERM", onTerm); };
    return this.signalCleanup;
  }
  async reconcile(target, decision) {
    if (!Object.hasOwn(this.run.nodes, target) && !Object.hasOwn(this.run.effects, target)) throw new Error("reconciliation target is not persisted");
    if (!["abandon", "confirmed-applied", "confirmed-not-applied"].includes(decision)) throw new Error("specific reconciliation decision required");
    if (this.run.nodes[target]?.role === "writer" && decision !== "abandon") throw new Error("an interrupted writer cannot be replayed or marked applied");
    return this.enqueue(async () => { let result; let kind; if (decision === "confirmed-applied") { kind = this.run.effects[target]?.kind; if (kind !== Effect.PUBLISH_PR) throw new Error("confirmed-applied is allowed only for exact open PR proof"); const review = this.run.nodes["review-head"]; const approvedHead = review?.status === "approved" ? review.head : undefined; const current = approvedHead && await this.effects.head(); if (!approvedHead || current !== approvedHead) throw new Error("final review HEAD is no longer current"); if (!this.effects.prove) throw new Error("exact read-only proof is unavailable"); result = await this.effects.prove(kind, this.run.effects[target], { approvedHead }); if (!result?.pr) throw new Error("exact proof did not establish outcome"); } await this.event(this.fenced("reconcile", { target, decision, result })); if (this.run.status === "closing") return this._finishClosing(); if (kind === Effect.PUBLISH_PR && decision === "confirmed-applied") return this.beginClosing({ outcome: "done", pr: result.pr }); if (this.run.status === "running") await this._pump(); return this.run; });
  }
  async _cancel(reason, requestId) {
    if (this.run.status === "cancelled") return this.run;
    if (["done", "failed", "closing"].includes(this.run.status)) throw new Error(`cannot cancel ${this.run.status} run`);
    if (this.run.status !== "cancelling") await this.event(this.fenced("cancelling", { reason, requestId }));
    try { await this.workers?.shutdown?.(); }
    catch (error) { this.shutdownError = error; return this.run; }
    return this.event(this.fenced("cancel", { reason, requestId }));
  }
  async cancel(reason) { return this.requestCancellation(this.run.id, reason); }
}
