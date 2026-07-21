import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { relative, resolve } from "node:path";

type Binding = { node: string; generation: number; token: string; role: "investigator" | "reviewer" | "writer"; roots: string[]; paths: string[] };
let bound: Binding | undefined;
const inside = (file: string, root: string) => { const rel = relative(root, resolve(root, file)); return rel === "" || (!rel.startsWith("..") && !rel.includes("/../")); };
const writable = (file: string) => bound!.paths.some((path) => inside(file, resolve(bound!.roots[0], path)));
const pathFrom = (input: unknown) => typeof (input as { path?: unknown })?.path === "string" ? (input as { path: string }).path : undefined;

export default function orchestratorWorker(pi: ExtensionAPI) {
  pi.registerCommand("orchestrator-bind", { description: "Controller-only binding", handler: async (args, ctx) => {
    const [node, generation, token, role, encoded, ...extra] = args.trim().split(/\s+/);
    try {
      const scope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (extra.length || !/^[\w.-]{1,100}$/.test(node) || !/^\d+$/.test(generation) || !/^[\w-]{8,128}$/.test(token) || !["investigator", "reviewer", "writer"].includes(role) || !Array.isArray(scope.roots) || !scope.roots.every((x) => typeof x === "string" && inside(x, ctx.cwd)) || !Array.isArray(scope.paths) || !scope.paths.every((x) => typeof x === "string" && x && !x.startsWith("/") && !x.split("/").includes(".."))) throw new Error("invalid binding");
      bound = { node, generation: Number(generation), token, role: role as Binding["role"], roots: scope.roots.map(resolve), paths: scope.paths };
    } catch { ctx.ui.notify("Invalid orchestrator binding", "error"); }
  } });
  pi.on("tool_call", (event) => {
    if (!bound) return { block: true, reason: "worker is not bound" };
    const path = pathFrom(event.input); if (!path) return;
    if (!bound.roots.some((root) => inside(path, root))) return { block: true, reason: "path outside allowed root" };
    if (["edit", "write"].includes(event.toolName) && (bound.role !== "writer" || !writable(path))) return { block: true, reason: "write outside approved scope" };
  });
  pi.registerTool({ name: "orchestrator_report", label: "Orchestrator Report", description: "Required structured final report.", promptGuidelines: ["Call orchestrator_report as the final action; prose is not a report."], parameters: Type.Object({
    outcome: StringEnum(["ok", "failed", "blocked", "approved", "changes_requested"] as const), summary: Type.String({ minLength: 1, maxLength: 4000 }),
    findings: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 })), changedFiles: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 100 })), checks: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })), blockers: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 })), feedback: Type.Optional(Type.String({ maxLength: 4000 }),
  ) }, { additionalProperties: false }), async execute(_id, params) {
    if (!bound) throw new Error("worker is not controller-bound");
    const changedFiles = (params.changedFiles ?? []).filter((file) => !file.startsWith("/") && !file.split("/").includes("..") && writable(file));
    return { content: [{ type: "text", text: "Structured orchestration report recorded." }], details: { node: bound.node, generation: bound.generation, token: bound.token, role: bound.role, ...params, changedFiles }, terminate: true };
  } });
}
