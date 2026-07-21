import { createHash, randomUUID } from "node:crypto";

export const TERMINAL = new Set(["done", "cancelled", "waiting-human", "failed"]);
export const idFor = (kind, value) => `${kind}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)}`;

export function validateSpec(input, workflow) {
  const spec = structuredClone(input ?? {});
  const text = (key, value) => { if (typeof value !== "string" || !value.trim()) throw new Error(`spec.${key} is required`); return value; };
  text("taskKey", spec.taskKey); text("objective", spec.objective); text("cwd", spec.cwd);
  if (!spec.cwd.startsWith("/")) throw new Error("spec.cwd must be an absolute dedicated worktree");
  if (workflow === "fix-to-pr") { text("remote", spec.remote); text("base", spec.base); text("branch", spec.branch); }
  if (workflow === "fix-to-pr" && (!Array.isArray(spec.paths) || !spec.paths.length || spec.paths.some((p) => typeof p !== "string" || !p || p.startsWith("/") || p.split("/").includes("..")))) throw new Error("spec.paths must be non-empty relative paths");
  if (workflow === "fix-to-pr" && (!spec.authorization || spec.authorization.edit !== true || spec.authorization.pr !== true)) throw new Error("spec requires explicit edit and PR authorization");
  if (workflow === "fix-to-pr" && (!Array.isArray(spec.checks) || !spec.checks.length || spec.checks.some((check) => !Array.isArray(check) || !check.length || check.some((x) => typeof x !== "string")))) throw new Error("fix-to-pr requires a non-empty check manifest");
  if (spec.instructions !== undefined && (typeof spec.instructions !== "string" || spec.instructions.length > 8000)) throw new Error("spec.instructions must be <= 8000 characters");
  if (spec.instructionsArtifact !== undefined && (typeof spec.instructionsArtifact !== "string" || spec.instructionsArtifact.length > 1000)) throw new Error("spec.instructionsArtifact must be <= 1000 characters");
  spec.maxReviewRounds = Number.isInteger(spec.maxReviewRounds) ? spec.maxReviewRounds : 3;
  if (spec.maxReviewRounds < 1 || spec.maxReviewRounds > 3) throw new Error("spec.maxReviewRounds must be 1..3");
  spec.paths ??= []; return Object.freeze(spec);
}

export function newRun({ id = randomUUID(), workflow, spec, model = "openai-codex/gpt-5.6-terra" }) {
  return { id, workflow, spec, taskKey: spec.taskKey, cwd: spec.cwd, model, status: "running", generation: 1, lease: 1,
    nodes: {}, seen: [], effects: {}, reviewRounds: 0, createdAt: Date.now(), updatedAt: Date.now() };
}
const current = (run, event) => event.generation === run.generation && event.lease === run.lease;
const once = (run, event) => run.seen.includes(event.id) ? run : { ...run, seen: [...run.seen, event.id], updatedAt: event.at ?? Date.now() };

export function reduce(run, event) {
  if (!event?.id || run.seen.includes(event.id)) return run;
  if (event.type !== "lease-acquired" && !current(run, event)) return once(run, event);
  const next = once(run, event);
  switch (event.type) {
    case "lease-acquired": return { ...next, lease: event.lease, generation: event.generation, status: TERMINAL.has(next.status) ? next.status : "running" };
    case "node-started": {
      if (event.role === "writer" && Object.values(next.nodes).some((n) => n.role === "writer" && n.status === "running")) return { ...next, status: "waiting-human", reason: "second-writer-blocked" };
      const old = next.nodes[event.node];
      return { ...next, nodes: { ...next.nodes, [event.node]: { role: event.role, status: "running", attempts: event.attempt ?? old?.attempts ?? 0, worker: event.worker, pid: event.pid, route: event.route, policy: event.policy, sessionDir: event.sessionDir, head: event.head } } };
    }
    case "report": {
      const node = next.nodes[event.node]; if (!node || node.status !== "running" || node.role !== event.role) return next;
      return { ...next, nodes: { ...next.nodes, [event.node]: { ...node, status: event.outcome, report: event.report, head: event.head ?? node.head } } };
    }
    case "agent-settled": {
      const node = next.nodes[event.node]; if (!node || node.status !== "running") return next; // report wins when adjacent
      if (node.role !== "writer" && node.attempts === 0) return { ...next, nodes: { ...next.nodes, [event.node]: { ...node, attempts: 1, status: "retry" } } };
      return { ...next, status: "waiting-human", reason: node.role === "writer" ? "writer-interrupted" : "read-only-interrupted" };
    }
    case "effect-started": return { ...next, effects: { ...next.effects, [event.effect]: { status: "started", kind: event.kind, beforeHead: event.beforeHead, attempts: (next.effects[event.effect]?.attempts ?? 0) + 1 } } };
    case "effect-finished": return { ...next, effects: { ...next.effects, [event.effect]: { ...next.effects[event.effect], status: event.outcome, kind: event.kind, result: event.result } } };
    case "review-changes": {
      if (next.reviewRounds >= next.spec.maxReviewRounds) return { ...next, status: "waiting-human", reason: "review-round-limit" };
      const nodes = Object.fromEntries(Object.entries(next.nodes).map(([id, node]) => [id, node.role === "writer" ? { ...node, status: "retry", attempts: node.attempts + 1 } : { ...node, status: "pending", head: undefined }]));
      return { ...next, reviewRounds: next.reviewRounds + 1, feedback: event.feedback, effects: {}, nodes };
    }
    case "recovery-wait": return { ...next, status: "waiting-human", reason: event.reason };
    case "reconcile": {
      if (event.decision === "abandon") return { ...next, status: "failed", reason: `abandoned-${event.target}` };
      if (event.decision === "confirmed-not-applied") { const effects = { ...next.effects }; if (effects[event.target]) delete effects[event.target]; const nodes = { ...next.nodes }; if (nodes[event.target]) nodes[event.target] = { ...nodes[event.target], status: "retry" }; return { ...next, status: "running", effects, nodes, reason: undefined }; }
      if (event.decision === "confirmed-applied") { const effects = { ...next.effects }; const nodes = { ...next.nodes }; if (effects[event.target]) effects[event.target] = { ...effects[event.target], status: "ok", result: event.result }; if (nodes[event.target]) nodes[event.target] = { ...nodes[event.target], status: "ok", head: event.result?.head ?? nodes[event.target].head }; return { ...next, status: "running", effects, nodes, reason: undefined }; }
      return next;
    }
    case "cancel": return { ...next, status: "cancelled", reason: event.reason ?? "cancelled" };
    case "complete": return { ...next, status: "done", pr: event.pr, ci: "pending" };
    default: throw new Error(`unknown event type: ${event.type}`);
  }
}
export function assertRun(run) {
  if (Object.values(run.nodes).filter((n) => n.role === "writer" && n.status === "running").length > 1) throw new Error("invariant: one writer");
  return run;
}
