import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { assertRun, reduce } from "./state.js";

const home = process.env.HOME ?? ".";
export const defaultStateDir = () => process.env.PI_ORCH_STATE_DIR ?? join(home, ".pi", "orchestrator");
const files = (dir, id) => ({ journal: join(dir, `${id}.jsonl`), snapshot: join(dir, `${id}.json`), lease: join(dir, `${id}.lease`) });
const privateDir = async (dir) => { await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700); };

export class Store {
  constructor(dir = defaultStateDir()) { this.dir = dir; }
  async init() { await privateDir(this.dir); await privateDir(join(this.dir, "workers")); }
  claimFiles(taskKey, cwd) { const digest = (value) => createHash("sha256").update(value).digest("hex"); return [join(this.dir, `claim-task-${digest(taskKey)}.lock`), join(this.dir, `claim-cwd-${digest(cwd)}.lock`)]; }
  async claim(taskKey, cwd, runId) { await this.init(); const mine = { runId, pid: process.pid, startedAt: Date.now() }; const acquired = []; const acquire = async (file) => { try { const h = await open(file, "wx", 0o600); await h.writeFile(JSON.stringify(mine)); await h.sync(); await h.close(); acquired.push(file); return; } catch (error) { if (error.code !== "EEXIST") throw error; } const owner = JSON.parse(await readFile(file, "utf8")); if (owner.runId === runId) return; let terminal = false; try { terminal = ["done", "cancelled", "failed"].includes((await this.load(owner.runId)).status); } catch { try { process.kill(owner.pid, 0); } catch (error) { terminal = error.code === "ESRCH"; } } if (!terminal) throw new Error("active claim"); await unlink(file); return acquire(file); }; try { for (const file of this.claimFiles(taskKey, cwd)) await acquire(file); } catch (error) { await Promise.all(acquired.map((file) => unlink(file).catch(() => {}))); throw error; } }
  async releaseClaim(taskKey, cwd, runId) { await Promise.all(this.claimFiles(taskKey, cwd).map(async (file) => { try { if (JSON.parse(await readFile(file, "utf8")).runId === runId) await unlink(file); } catch {} })); }
  async create(run) {
    await this.init(); const { journal } = files(this.dir, run.id);
    const handle = await open(journal, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify({ type: "seed", run })}\n`); await handle.sync(); } catch (error) { await unlink(journal).catch(() => {}); throw error; } finally { await handle.close(); }
    await this.snapshot(run); return run;
  }
  async append(run, event) {
    const { journal } = files(this.dir, run.id); const handle = await open(journal, "a", 0o600);
    try { await handle.write(`${JSON.stringify(event)}\n`); await handle.sync(); } finally { await handle.close(); }
    const next = assertRun(reduce(run, event)); await this.snapshot(next); return next;
  }
  async snapshot(run) {
    const { snapshot } = files(this.dir, run.id); const temp = `${snapshot}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(run)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, snapshot); await chmod(snapshot, 0o600);
    const directory = await open(dirname(snapshot), "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
  async load(id) {
    const { journal } = files(this.dir, id); const text = await readFile(journal, "utf8"); let seed; const events = [];
    for (const line of text.split("\n")) { if (!line) continue; try { const item = JSON.parse(line); if (item.type === "seed") seed ??= item.run; else events.push(item); } catch { break; } }
    if (!seed) throw new Error(`journal has no seed for ${id}`); let run = seed; for (const event of events) run = reduce(run, event); return assertRun(run);
  }
  async list() { try { return (await readdir(this.dir)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)); } catch { return []; } }
  async activeForTask(taskKey) { for (const id of await this.list()) { const run = await this.load(id); if (run.taskKey === taskKey && !["done", "cancelled", "failed"].includes(run.status)) return run; } }
}

export class Lease {
  constructor(dir, id) { this.file = files(dir, id).lease; }
  async acquire(generation) {
    await privateDir(dirname(this.file)); const token = `${process.pid}:${generation}:${Date.now()}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const handle = await open(this.file, "wx", 0o600); await handle.writeFile(token); await handle.sync(); await handle.close(); return { token, generation, lease: generation }; }
      catch (error) {
        if (error.code !== "EEXIST" || attempt) throw new Error(`controller lease already held for ${this.file}`);
        const owner = await readFile(this.file, "utf8"); const pid = Number(owner.split(":", 1)[0]);
        if (!Number.isInteger(pid) || pid < 1) throw new Error(`invalid controller lease ${this.file}`);
        try { process.kill(pid, 0); throw new Error(`controller lease already held for ${this.file}`); }
        catch (probe) { if (probe.code !== "ESRCH") throw probe; }
        await unlink(this.file);
      }
    }
    throw new Error(`controller lease already held for ${this.file}`);
  }
  async release() { await unlink(this.file).catch(() => {}); }
}
