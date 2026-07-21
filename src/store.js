import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { assertRun, reduce } from "./state.js";

const home = process.env.HOME ?? ".";
export const defaultStateDir = () => process.env.PI_ORCH_STATE_DIR ?? join(home, ".pi", "orchestrator");
const paths = (dir, id) => ({ journal: join(dir, `${id}.jsonl`), snapshot: join(dir, `${id}.json`) });

export class Store {
  constructor(dir = defaultStateDir()) { this.dir = dir; }
  async create(run) {
    await mkdir(this.dir, { recursive: true });
    const file = paths(this.dir, run.id).journal;
    await writeFile(file, `${JSON.stringify({ type: "seed", run })}\n`, { flag: "wx" }).catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await this.snapshot(run);
    return run;
  }
  async append(run, event) {
    await mkdir(this.dir, { recursive: true });
    const file = paths(this.dir, run.id).journal;
    const handle = await open(file, "a");
    try { await handle.write(`${JSON.stringify(event)}\n`); await handle.sync(); } finally { await handle.close(); }
    const next = assertRun(reduce(run, event));
    await this.snapshot(next);
    return next;
  }
  async snapshot(run) {
    const file = paths(this.dir, run.id).snapshot;
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(run));
    await rename(temp, file);
  }
  async load(id) {
    const { journal, snapshot } = paths(this.dir, id);
    let text = "";
    try { text = await readFile(journal, "utf8"); } catch { throw new Error(`missing journal for ${id}`); }
    let seed;
    const events = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        if (item.type === "seed") seed ??= item.run;
        else events.push(item);
      } catch { break; } // a torn tail is ignored, never interpreted
    }
    if (!seed) throw new Error(`journal has no seed for ${id}`);
    let run = seed;
    // A valid snapshot is a cache; replay still makes recovery deterministic after any torn write.
    try { JSON.parse(await readFile(snapshot, "utf8")); } catch { /* journal is the recovery source */ }
    for (const event of events) run = reduce(run, event);
    return assertRun(run);
  }
  async list() {
    const { readdir } = await import("node:fs/promises");
    try { return (await readdir(this.dir)).filter((x) => x.endsWith(".json")).map((x) => x.slice(0, -5)); } catch { return []; }
  }
}

/** Exclusive controller lease. Creation is atomic; stale owners are fenced by lease number. */
export class Lease {
  constructor(dir, id) { this.file = join(dir, `${id}.lease`); }
  async acquire(generation) {
    await mkdir(dirname(this.file), { recursive: true });
    const token = `${process.pid}:${generation}:${Date.now()}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const h = await open(this.file, "wx"); await h.writeFile(token); await h.close(); return { token, generation, lease: generation }; }
      catch (error) {
        if (error.code !== "EEXIST" || attempt) throw new Error(`controller lease already held for ${this.file}`);
        const owner = await readFile(this.file, "utf8").catch(() => "");
        const pid = Number(owner.split(":", 1)[0]);
        try { process.kill(pid, 0); throw new Error(`controller lease already held for ${this.file}`); }
        catch (probe) { if (probe.code !== "ESRCH") throw probe; }
        const { unlink } = await import("node:fs/promises"); await unlink(this.file).catch(() => {});
      }
    }
    throw new Error(`controller lease already held for ${this.file}`);
  }
  async release() { const { unlink } = await import("node:fs/promises"); await unlink(this.file).catch(() => {}); }
}
