import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export const Effect = Object.freeze({ COMMIT: "commit", CHECKS: "checks", REBASE: "rebase", RECONCILE_PR: "reconcile-pr", PUBLISH_PR: "publish-pr" });
const permitted = new Set(Object.values(Effect));
const scoped = (paths, allowed) => paths.length > 0 && paths.every((path) => allowed.some((root) => path === root || path.startsWith(`${root}/`)));

export class GitEffects {
  constructor({ spec, execFile = exec }) { this.spec = spec; this.cwd = spec.cwd; this.execFile = execFile; }
  async command(file, args) { return this.execFile(file, args, { cwd: this.cwd, shell: false, encoding: "utf8" }); }
  async head() { return (await this.command("git", ["rev-parse", "HEAD"])).stdout.trim(); }
  async assertClean() { if ((await this.command("git", ["status", "--porcelain"])).stdout.trim()) throw new Error("task worktree is not clean"); }
  async changed() { return (await this.command("git", ["status", "--porcelain"])).stdout.split("\n").filter(Boolean).map((line) => line.slice(3).trim()); }
  async assertScopedDiff() { const paths = (await this.command("git", ["diff", "--name-only", `${this.spec.remote}/${this.spec.base}...HEAD`])).stdout.split("\n").filter(Boolean); if (!scoped(paths, this.spec.paths)) throw new Error("PR diff is empty or outside spec scope"); return paths; }
  async run(kind) {
    if (!permitted.has(kind)) throw new Error(`effect forbidden: ${kind}`);
    if (kind === Effect.COMMIT) {
      const paths = await this.changed(); if (!scoped(paths, this.spec.paths)) throw new Error("changed paths are empty or outside spec scope");
      await this.command("git", ["add", "--", ...paths]); await this.command("git", ["commit", "-m", `pi-orch: ${this.spec.taskKey}`]);
      return { head: await this.head(), paths };
    }
    if (kind === Effect.CHECKS) { for (const [file, ...args] of this.spec.checks) await this.command(file, args); return { checked: this.spec.checks.length }; }
    if (kind === Effect.REBASE) { await this.command("git", ["fetch", this.spec.remote, this.spec.base]); await this.command("git", ["rebase", `${this.spec.remote}/${this.spec.base}`]); return { head: await this.head() }; }
    await this.assertClean(); await this.assertScopedDiff();
    const list = await this.command("gh", ["pr", "list", "--head", this.spec.branch, "--state", "open", "--json", "url,headRefName,baseRefName,isDraft,mergedAt"]);
    const prs = JSON.parse(list.stdout || "[]"); const exact = prs.find((pr) => pr.headRefName === this.spec.branch && pr.baseRefName === this.spec.base && !pr.mergedAt);
    if (kind === Effect.RECONCILE_PR) return exact ? { existing: exact.url } : { existing: null };
    if (prs.length) throw new Error("competing open PR requires human reconciliation");
    const commit = await this.head(); await this.command("git", ["push", this.spec.remote, `HEAD:refs/heads/${this.spec.branch}`]);
    const created = await this.command("gh", ["pr", "create", "--base", this.spec.base, "--head", this.spec.branch, "--title", this.spec.objective.slice(0, 120), "--body", `Task: ${this.spec.taskKey}\nCommit: ${commit}`]);
    const url = created.stdout.trim(); const viewed = await this.command("gh", ["pr", "view", url, "--json", "state,mergedAt,url,headRefName,baseRefName"]); const pr = JSON.parse(viewed.stdout);
    if (pr.state !== "OPEN" || pr.mergedAt || pr.headRefName !== this.spec.branch || pr.baseRefName !== this.spec.base) throw new Error("created PR is not exact, open, and unmerged");
    return { pr: pr.url };
  }
}
