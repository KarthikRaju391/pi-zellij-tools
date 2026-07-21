const roles = new Set(["investigator", "reviewer", "writer"]);
export const WORKFLOWS = Object.freeze({
  "investigate-report": [{ type: "agent", id: "investigate", role: "investigator" }],
  "read-only-verify": [{ type: "parallel", nodes: [{ type: "agent", id: "verify-a", role: "reviewer" }, { type: "agent", id: "verify-b", role: "reviewer" }] }],
  "fix-to-pr": [
    { type: "agent", id: "write", role: "writer" }, { type: "effect", id: "commit", effect: "commit" }, { type: "effect", id: "checks-before-review", effect: "checks" },
    { type: "agent", id: "review", role: "reviewer", exactHeadOf: "commit" }, { type: "effect", id: "rebase", effect: "rebase" }, { type: "effect", id: "checks-after-rebase", effect: "checks" },
    { type: "agent", id: "review-head", role: "reviewer", exactHeadOf: "rebase" }, { type: "effect", id: "pr-reconcile", effect: "reconcile-pr" }, { type: "effect", id: "publish", effect: "publish-pr" },
  ],
});
export function workflow(name) { if (!WORKFLOWS[name]) throw new Error(`unknown trusted workflow: ${name}`); return structuredClone(WORKFLOWS[name]); }
export function validate(plan) {
  let writers = 0; const ids = new Set();
  for (const item of plan.flatMap((x) => x.type === "parallel" ? x.nodes : [x])) { if (item.type !== "agent") continue; if (!roles.has(item.role) || ids.has(item.id)) throw new Error("invalid agent"); ids.add(item.id); writers += item.role === "writer"; }
  if (writers > 1) throw new Error("workflow has more than one writer"); return true;
}
export const roleTools = Object.freeze({ investigator: ["read", "grep", "find", "ls", "orchestrator_report"], reviewer: ["read", "grep", "find", "ls", "orchestrator_report"], writer: ["read", "edit", "write", "grep", "find", "ls", "orchestrator_report"] });
