const roles = new Set(["investigator", "verifier", "reviewer", "writer"]);
export const WORKFLOWS = Object.freeze({
  "investigate-report": [{ type: "agent", id: "investigate", role: "investigator" }],
  "read-only-verify": [{ type: "parallel", nodes: [{ type: "agent", id: "verify-a", role: "verifier" }, { type: "agent", id: "verify-b", role: "verifier" }] }],
  "fix-to-pr": [
    { type: "agent", id: "write", role: "writer" }, { type: "effect", id: "commit", effect: "commit" }, { type: "effect", id: "checks-before-review", effect: "checks" },
    { type: "agent", id: "review", role: "reviewer", exactHeadOf: "commit" }, { type: "effect", id: "rebase", effect: "rebase" }, { type: "effect", id: "checks-after-rebase", effect: "checks" },
    { type: "agent", id: "review-head", role: "reviewer", exactHeadOf: "rebase" }, { type: "effect", id: "pr-reconcile", effect: "reconcile-pr" }, { type: "effect", id: "publish", effect: "publish-pr" },
  ],
});
export function workflow(name) { if (!WORKFLOWS[name]) throw new Error(`unknown trusted workflow: ${name}`); const plan = structuredClone(WORKFLOWS[name]); validate(plan); return plan; }
export function validate(plan) {
  let writers = 0; const ids = new Set(); const visit = (item) => { if (item.type === "parallel") { if (!Array.isArray(item.nodes) || item.nodes.length < 2 || item.nodes.length > 3) throw new Error("invalid parallel"); item.nodes.forEach(visit); return; } if (item.type === "agent") { if (!roles.has(item.role) || !item.id || ids.has(item.id)) throw new Error("invalid agent"); ids.add(item.id); writers += item.role === "writer"; return; } if (item.type === "effect" && item.id && ["commit", "checks", "rebase", "reconcile-pr", "publish-pr"].includes(item.effect)) { if (ids.has(item.id)) throw new Error("duplicate id"); ids.add(item.id); return; } throw new Error("unknown workflow node"); }; plan.forEach(visit); if (writers > 1) throw new Error("workflow has more than one writer"); return true;
}
export const roleTools = Object.freeze({ investigator: ["read", "grep", "find", "ls", "orchestrator_report"], verifier: ["read", "grep", "find", "ls", "orchestrator_report"], reviewer: ["read", "grep", "find", "ls", "orchestrator_report"], writer: ["read", "edit", "write", "grep", "find", "ls", "orchestrator_report"] });
