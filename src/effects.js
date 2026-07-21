import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

/** The closed union is intentional: unsafe classes have no constructor. */
export const Effect = Object.freeze({ COMMIT: "commit", CHECKS: "checks", REBASE: "rebase", PUBLISH_PR: "publish-pr" });
const permitted = new Set(Object.values(Effect));

export class GitEffects {
  constructor({ cwd, checks = [], execFile = exec }) { this.cwd = cwd; this.checks = checks; this.execFile = execFile; }
  async command(file, args) { return this.execFile(file, args, { cwd: this.cwd, shell: false, encoding: "utf8" }); }
  async head() { return (await this.command("git", ["rev-parse", "HEAD"])).stdout.trim(); }
  async assertClean() {
    if ((await this.command("git", ["status", "--porcelain"])).stdout.trim()) throw new Error("refusing a non-clean task worktree");
  }
  async run(kind) {
    if (!permitted.has(kind)) throw new Error(`effect forbidden: ${kind}`);
    if (kind === Effect.COMMIT) {
      const dirty = (await this.command("git", ["status", "--porcelain"])).stdout;
      if (!dirty.trim()) throw new Error("writer produced no change to commit");
      await this.command("git", ["add", "--all"]);
      await this.command("git", ["commit", "-m", "pi-orch: workflow change"]);
      const paths = (await this.command("git", ["diff", "--name-only", "HEAD~1", "HEAD"])).stdout.split("\n").filter(Boolean);
      if (!paths.length) throw new Error("empty commit is out of scope");
      return { head: await this.head(), paths };
    }
    if (kind === Effect.CHECKS) {
      for (const [file, ...args] of this.checks) await this.command(file, args);
      return { checked: true };
    }
    if (kind === Effect.REBASE) {
      await this.command("git", ["fetch", "origin"]);
      await this.command("git", ["rebase", "origin/main"]);
      return { head: await this.head() };
    }
    const status = (await this.command("git", ["status", "--porcelain"])).stdout;
    if (status.trim()) throw new Error("refusing to publish unclean diff");
    await this.command("git", ["push", "origin", "HEAD"]);
    const opened = await this.command("gh", ["pr", "create", "--fill"]);
    const url = opened.stdout.trim();
    const viewed = await this.command("gh", ["pr", "view", url, "--json", "state,isDraft,mergedAt,url"]);
    const pr = JSON.parse(viewed.stdout);
    if (pr.state !== "OPEN" || pr.mergedAt) throw new Error("PR is not open and unmerged");
    return { pr: pr.url, ci: "pending" }; // CI stays pending until independently observed.
  }
}

export function canReconcile(kind, proof) {
  return (kind === Effect.CHECKS || kind === "read-only-agent") && proof === "exact";
}
