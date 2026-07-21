const roles = new Set(["investigator", "reviewer", "writer"]);
const gates = new Set(["human", "policy"]);

export const WORKFLOWS = Object.freeze({
  "investigate-report": [{ type: "agent", id: "investigate", role: "investigator" }],
  "read-only-verify": [{ type: "parallel", nodes: [
    { type: "agent", id: "verify-a", role: "reviewer" }, { type: "agent", id: "verify-b", role: "reviewer" },
  ] }],
  "fix-to-pr": [
    { type: "gate", gate: "policy", required: "edit-authorization" },
    { type: "agent", id: "write", role: "writer" },
    { type: "effect", id: "commit", effect: "commit" },
    { type: "effect", id: "checks-before-review", effect: "checks" },
    { type: "agent", id: "review", role: "reviewer", exactHeadOf: "commit" },
    { type: "effect", id: "rebase", effect: "rebase" },
    { type: "effect", id: "checks-after-rebase", effect: "checks" },
    { type: "agent", id: "review-head", role: "reviewer", exactHeadOf: "rebase" },
    { type: "effect", id: "publish", effect: "publish-pr" },
  ],
});

export function workflow(name) { const plan = WORKFLOWS[name]; if (!plan) throw new Error(`unknown trusted workflow: ${name}`); validate(plan); return structuredClone(plan); }
export function validate(plan) {
  let writers = 0;
  const ids = new Set();
  const inspect = (node) => {
    if (node.type === "agent") {
      if (!roles.has(node.role) || !node.id || ids.has(node.id)) throw new Error("invalid agent node");
      ids.add(node.id); writers += Number(node.role === "writer");
    } else if (node.type === "parallel") {
      if (!Array.isArray(node.nodes) || node.nodes.length < 2 || node.nodes.length > 3) throw new Error("parallelism must be bounded (2..3)");
      node.nodes.forEach(inspect);
    } else if (node.type === "gate") {
      if (!gates.has(node.gate)) throw new Error("unknown gate");
    } else if (node.type !== "effect") throw new Error("unknown workflow node");
  };
  plan.forEach(inspect);
  if (writers > 1) throw new Error("workflow has more than one writer");
  return true;
}

export const roleTools = Object.freeze({
  investigator: ["read", "grep", "find", "ls", "orchestrator_report"],
  reviewer: ["read", "grep", "find", "ls", "orchestrator_report"],
  writer: ["read", "edit", "write", "grep", "find", "ls", "orchestrator_report"],
});
