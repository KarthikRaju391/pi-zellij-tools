import { createHash, randomUUID } from "node:crypto";

export const TERMINAL = new Set(["done", "cancelled", "waiting-human", "failed"]);
export const WRITER_ROLES = new Set(["writer"]);
export const idFor = (kind, value) => `${kind}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)}`;

export function newRun({ id = randomUUID(), workflow, cwd, authorized = false, model = "openai-codex/gpt-5.6-terra" }) {
  return { id, workflow, cwd, model, authorized, status: "running", generation: 1, lease: 1,
    nodes: {}, seen: [], effects: {}, createdAt: Date.now(), updatedAt: Date.now() };
}

function current(run, event) {
  return event.generation === run.generation && event.lease === run.lease;
}
function once(run, event) {
  return run.seen.includes(event.id) ? run : { ...run, seen: [...run.seen, event.id], updatedAt: event.at ?? Date.now() };
}

/** Pure, fenced state transition. Events from prior controller generations are ignored. */
export function reduce(run, event) {
  if (!event?.id || run.seen.includes(event.id)) return run;
  if (event.type !== "lease-acquired" && !current(run, event)) return once(run, event);
  const next = once(run, event);
  switch (event.type) {
    case "lease-acquired":
      return { ...next, lease: event.lease, generation: event.generation, status: TERMINAL.has(next.status) ? next.status : "running" };
    case "node-started": {
      const old = next.nodes[event.node];
      if (Object.values(next.nodes).some((node) => node.role === "writer" && node.status === "running")) return { ...next, status: "waiting-human", reason: "second-writer-blocked" };
      return { ...next, nodes: { ...next.nodes, [event.node]: { role: event.role, status: "running", attempts: event.attempt ?? old?.attempts ?? 0, worker: event.worker, head: event.head } } };
    }
    case "report": {
      const node = next.nodes[event.node];
      if (!node || node.status !== "running" || event.role !== node.role) return next;
      return { ...next, status: event.outcome === "ok" ? next.status : "waiting-human", reason: event.outcome === "ok" ? next.reason : `${event.node}-${event.outcome}`, nodes: { ...next.nodes, [event.node]: { ...node, status: event.outcome, report: event.report, head: event.head ?? node.head } } };
    }
    case "agent-settled": {
      const node = next.nodes[event.node];
      if (!node || node.status !== "running") return next;
      if (node.role !== "writer" && node.attempts === 0) {
        return { ...next, nodes: { ...next.nodes, [event.node]: { ...node, attempts: 1, status: "retry" } } };
      }
      return { ...next, status: "waiting-human", reason: node.role === "writer" ? "writer-settled-without-report" : "read-only-settled-without-report" };
    }
    case "effect-started":
      return { ...next, effects: { ...next.effects, [event.effect]: { status: "started", kind: event.kind, attempts: (next.effects[event.effect]?.attempts ?? 0) + 1 } } };
    case "effect-finished":
      return { ...next, effects: { ...next.effects, [event.effect]: { status: event.outcome, kind: event.kind, result: event.result } } };
    case "effect-unknown":
      return { ...next, status: "waiting-human", reason: `unknown-${event.kind}` };
    case "approve": return next.status === "waiting-human" ? { ...next, status: "running", reason: undefined } : next;
    case "cancel": return { ...next, status: "cancelled", reason: event.reason ?? "cancelled" };
    case "complete": return { ...next, status: "done", pr: event.pr, ci: event.ci ?? "pending" };
    case "fail": return { ...next, status: "failed", reason: event.reason };
    default: throw new Error(`unknown event type: ${event.type}`);
  }
}

export function assertRun(run) {
  const writers = Object.values(run.nodes).filter((node) => node.role === "writer" && node.status === "running");
  if (writers.length > 1) throw new Error("invariant: only one live writer");
  for (const [name, node] of Object.entries(run.nodes)) if (!node.role || !node.status) throw new Error(`invalid node ${name}`);
  return run;
}
