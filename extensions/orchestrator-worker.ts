import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Bound only by the controller's RPC /orchestrator-bind command. Model-supplied report
// arguments never choose identity, generation, token, or role.
type Binding = { node: string; generation: number; token: string; role: "investigator" | "reviewer" | "writer" };
const token = /^[A-Za-z0-9_-]{8,128}$/;
const node = /^[A-Za-z0-9._-]{1,100}$/;

export default function orchestratorWorker(pi: ExtensionAPI) {
  let binding: Binding | undefined;
  pi.registerCommand("orchestrator-bind", {
    description: "Controller-only worker binding",
    handler: async (args, ctx) => {
      const [id, generation, secret, role, ...rest] = args.trim().split(/\s+/);
      if (!id || !node.test(id) || !/^\d+$/.test(generation ?? "") || !secret || !token.test(secret) || !["investigator", "reviewer", "writer"].includes(role) || rest.length) {
        ctx.ui.notify("Invalid orchestrator binding", "error"); return;
      }
      binding = { node: id, generation: Number(generation), token: secret, role: role as Binding["role"] };
    },
  });
  pi.registerTool({
    name: "orchestrator_report",
    label: "Orchestrator Report",
    description: "Required final action: report only the outcome and concise summary to the controller.",
    promptGuidelines: ["Call orchestrator_report as the final action. Do not claim completion only in prose."],
    parameters: Type.Object({
      outcome: StringEnum(["ok", "failed", "blocked"] as const),
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (!binding) throw new Error("worker is not controller-bound");
      return {
        content: [{ type: "text", text: "Structured orchestration report recorded." }],
        details: { ...binding, outcome: params.outcome, summary: params.summary },
        terminate: true,
      };
    },
  });
}
