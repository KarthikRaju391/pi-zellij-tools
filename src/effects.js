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
  async preflight() { const listed = (await this.command("git", ["worktree", "list", "--porcelain"])).stdout; if (!listed.split("\n").some((line) => line === `worktree ${this.cwd}`)) throw new Error("cwd is not a listed git worktree"); const root = (await this.command("git", ["rev-parse", "--show-toplevel"])).stdout.trim(); if (root !== this.cwd) throw new Error("cwd is not declared git worktree"); const branch = (await this.command("git", ["branch", "--show-current"])).stdout.trim(); if (branch !== this.spec.branch) throw new Error("declared branch is not checked out"); await this.command("git", ["remote", "get-url", this.spec.remote]); await this.command("git", ["rev-parse", "--verify", `${this.spec.remote}/${this.spec.base}`]); await this.assertClean(); }
  async prove(kind, started) { if ([Effect.COMMIT, Effect.REBASE].includes(kind)) { const head = await this.head(); if (!started?.beforeHead || head === started.beforeHead) throw new Error("head did not prove interrupted effect outcome"); return { head }; } if (kind === Effect.PUBLISH_PR) { const raw = await this.command("gh", ["pr", "list", "--head", this.spec.branch, "--state", "open", "--json", "url,headRefOid,baseRefName"]); const pr = JSON.parse(raw.stdout || "[]")[0]; const head = await this.head(); if (!pr || pr.baseRefName !== this.spec.base || pr.headRefOid !== head) throw new Error("PR proof is not exact"); return { pr: pr.url }; } throw new Error("effect cannot be proven"); }
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
    const list = await this.command("gh", ["pr", "list", "--head", this.spec.branch, "--state", "open", "--json", "url,headRefName,headRefOid,baseRefName,isDraft,mergedAt"]);
    const prs = JSON.parse(list.stdout || "[]"); const localHead = await this.head(); const exact = prs.find((pr) => pr.headRefName === this.spec.branch && pr.baseRefName === this.spec.base && pr.headRefOid === localHead && !pr.mergedAt);
    if (kind === Effect.RECONCILE_PR) return exact ? { existing: exact.url } : { existing: null };
    if (prs.length) throw new Error("existing PR does not match exact reviewed head; human reconciliation required");
    const commit = await this.head(); await this.command("git", ["push", this.spec.remote, `HEAD:refs/heads/${this.spec.branch}`]);
    const created = await this.command("gh", ["pr", "create", "--base", this.spec.base, "--head", this.spec.branch, "--title", this.spec.objective.slice(0, 120), "--body", `Task: ${this.spec.taskKey}\nCommit: ${commit}`]);
    const url = created.stdout.trim(); const viewed = await this.command("gh", ["pr", "view", url, "--json", "state,mergedAt,url,headRefName,headRefOid,baseRefName"]); const pr = JSON.parse(viewed.stdout);
    if (pr.state !== "OPEN" || pr.mergedAt || pr.headRefName !== this.spec.branch || pr.headRefOid !== commit || pr.baseRefName !== this.spec.base) throw new Error("created PR is not exact, open, and unmerged");
    return { pr: pr.url };
  }
}
