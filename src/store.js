import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { assertRun, reduce } from "./state.js";

const exec = promisify(execFile);
const home = process.env.HOME ?? ".";
const terminalClaimOwners = new Set(["done", "cancelled", "failed"]);
export const defaultStateDir = () => process.env.PI_ORCH_STATE_DIR ?? join(home, ".pi", "orchestrator");
const files = (dir, id) => ({ journal: join(dir, `${id}.jsonl`), snapshot: join(dir, `${id}.json`), lease: join(dir, `${id}.lease`) });
const privateDir = async (dir) => { await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700); };
const canonical = (path) => { try { return realpathSync(resolve(path)); } catch { return resolve(path); } };

async function processStartIdentity(pid) {
  const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const identity = stdout.trim();
  if (!identity) throw new Error(`cannot identify process ${pid}`);
  return identity;
}

let localOwner;
async function defaultOwner() {
  localOwner ??= { pid: process.pid, startIdentity: await processStartIdentity(process.pid), startedAt: Date.now() };
  return localOwner;
}

async function defaultOwnerAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid < 1 || typeof owner.startIdentity !== "string" || !owner.startIdentity) return true;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === "ESRCH" ? false : true; }
  try { return await processStartIdentity(owner.pid) === owner.startIdentity; }
  catch { return true; }
}

function defaultWorkerAlive(pid) {
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; }
  catch (error) { return error.code === "ESRCH" ? false : true; }
}

export class Store {
  constructor(dir = defaultStateDir(), { owner = defaultOwner, ownerAlive = defaultOwnerAlive, workerAlive = defaultWorkerAlive } = {}) {
    this.dir = dir;
    this.owner = owner;
    this.ownerAlive = ownerAlive;
    this.workerAlive = workerAlive;
  }
  async init() { await privateDir(this.dir); await privateDir(join(this.dir, "workers")); }
  claimFiles(taskKey, cwd) {
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    return [join(this.dir, `claim-task-${digest(taskKey)}.lock`), join(this.dir, `claim-cwd-${digest(canonical(cwd))}.lock`)];
  }
  async ownerRecord(extra = {}) {
    const owner = await this.owner();
    if (!Number.isInteger(owner?.pid) || owner.pid < 1 || typeof owner.startIdentity !== "string" || !owner.startIdentity) throw new Error("claim owner requires PID/start identity");
    return { ...owner, startedAt: owner.startedAt ?? Date.now(), ...extra };
  }
  async withClaimLock(fn) {
    await this.init();
    const file = join(this.dir, ".claims.lock");
    let handle;
    for (let attempt = 0; attempt < 500 && !handle; attempt++) {
      try {
        handle = await open(file, "wx", 0o600);
        await handle.writeFile(JSON.stringify(await this.ownerRecord()));
        await handle.sync();
      } catch (error) {
        const created = Boolean(handle); await handle?.close().catch(() => {}); handle = undefined;
        if (created) { await unlink(file).catch(() => {}); throw error; }
        if (error.code !== "EEXIST") throw error;
        let owner;
        try { owner = JSON.parse(await readFile(file, "utf8")); }
        catch { throw new Error("claim lock is unreadable"); }
        if (await this.ownerAlive(owner)) { await sleep(10); continue; }
        const stale = `${file}.stale-${process.pid}-${randomUUID()}`;
        try { await rename(file, stale); await unlink(stale); }
        catch (moveError) { if (moveError.code !== "ENOENT") throw moveError; }
      }
    }
    if (!handle) throw new Error("claim operation lock is busy");
    try { return await fn(); }
    finally { await handle.close(); await unlink(file).catch(() => {}); }
  }
  async claimIsActive(owner) {
    if (!owner?.runId) return await this.ownerAlive(owner);
    try { return !terminalClaimOwners.has((await this.load(owner.runId)).status) || await this.ownerAlive(owner); }
    catch { return await this.ownerAlive(owner); }
  }
  async workersAlive(run) {
    const pids = [...new Set(Object.values(run.nodes).map((node) => node.pid).filter((pid) => Number.isInteger(pid) && pid > 0))];
    return (await Promise.all(pids.map((pid) => this.workerAlive(pid)))).some(Boolean);
  }
  async removeIfOwned(file, runId) {
    try {
      const owner = JSON.parse(await readFile(file, "utf8"));
      if (owner.runId === runId) await unlink(file);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  async acquireClaim(file, mine) {
    for (;;) {
      let handle;
      try {
        handle = await open(file, "wx", 0o600);
        await handle.writeFile(JSON.stringify(mine));
        await handle.sync();
        await handle.close();
        return true;
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error.code !== "EEXIST") { if (handle) await unlink(file).catch(() => {}); throw error; }
      }
      let owner;
      try { owner = JSON.parse(await readFile(file, "utf8")); }
      catch { throw new Error("claim is unreadable"); }
      if (owner.runId === mine.runId) return false;
      if (await this.claimIsActive(owner)) throw new Error(`active claim owned by ${owner.runId}`);
      await unlink(file);
    }
  }
  async claim(taskKey, cwd, runId) {
    if (typeof runId !== "string" || !runId) throw new Error("runId is required for claim");
    return this.withClaimLock(async () => {
      const mine = await this.ownerRecord({ runId });
      const acquired = [];
      try {
        for (const file of this.claimFiles(taskKey, cwd)) if (await this.acquireClaim(file, mine)) acquired.push(file);
      } catch (error) {
        for (const file of acquired) await this.removeIfOwned(file, runId);
        throw error;
      }
    });
  }
  async releaseClaim(taskKey, cwd, runId) {
    if (typeof runId !== "string" || !runId) throw new Error("runId is required to release claim");
    return this.withClaimLock(async () => {
      for (const file of this.claimFiles(taskKey, cwd)) await this.removeIfOwned(file, runId);
    });
  }
  cancelFile(runId) { return join(this.dir, `cancel-${createHash("sha256").update(runId).digest("hex")}.json`); }
  async requestCancel(runId, reason = "CLI cancel", requestId = randomUUID()) {
    if (typeof runId !== "string" || !runId || typeof requestId !== "string" || !requestId) throw new Error("runId and requestId are required");
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500) throw new Error("cancel reason must be 1..500 characters");
    await this.init(); const file = this.cancelFile(runId); const request = { id: requestId, runId, reason, requestedAt: Date.now() }; let handle;
    try { handle = await open(file, "wx", 0o600); await handle.writeFile(JSON.stringify(request)); await handle.sync(); await handle.close(); }
    catch (error) {
      await handle?.close().catch(() => {});
      if (handle) await unlink(file).catch(() => {});
      if (error.code !== "EEXIST") throw error;
      return this.readCancel(runId);
    }
    const directory = await open(this.dir, "r"); try { await directory.sync(); } finally { await directory.close(); }
    return request;
  }
  async readCancel(runId) {
    try { const request = JSON.parse(await readFile(this.cancelFile(runId), "utf8")); if (request.runId !== runId || typeof request.id !== "string" || !request.id) throw new Error("invalid cancel request"); return request; }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  }
  async consumeCancel(runId, requestId) {
    const request = await this.readCancel(runId); if (!request || request.id !== requestId) return false;
    const file = this.cancelFile(runId); const consumed = `${file}.consumed-${createHash("sha256").update(requestId).digest("hex")}`;
    try { await rename(file, consumed); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    const moved = JSON.parse(await readFile(consumed, "utf8"));
    if (moved.runId !== runId || moved.id !== requestId) throw new Error("cancel request changed while consuming");
    await unlink(consumed); const directory = await open(this.dir, "r"); try { await directory.sync(); } finally { await directory.close(); }
    return true;
  }
  async create(run) {
    await this.init(); const { journal } = files(this.dir, run.id);
    const handle = await open(journal, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify({ type: "seed", run })}\n`); await handle.sync(); }
    catch (error) { await unlink(journal).catch(() => {}); throw error; }
    finally { await handle.close(); }
    await this.snapshot(run); return run;
  }
  async append(run, event) {
    const { journal } = files(this.dir, run.id); const handle = await open(journal, "a", 0o600);
    try { await handle.write(`${JSON.stringify(event)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    const next = assertRun(reduce(run, event)); await this.snapshot(next); return next;
  }
  async snapshot(run) {
    const { snapshot } = files(this.dir, run.id); const temp = `${snapshot}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(run)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, snapshot); await chmod(snapshot, 0o600);
    const directory = await open(dirname(snapshot), "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
  async load(id) {
    const { journal } = files(this.dir, id); const text = await readFile(journal, "utf8"); let seed; const events = [];
    for (const line of text.split("\n")) { if (!line) continue; try { const item = JSON.parse(line); if (item.type === "seed") seed ??= item.run; else events.push(item); } catch { break; } }
    if (!seed) throw new Error(`journal has no seed for ${id}`); let run = seed; for (const event of events) run = reduce(run, event); return assertRun(run);
  }
  async list() { try { return (await readdir(this.dir)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)); } catch { return []; } }
  async activeForTask(taskKey) { for (const id of await this.list()) { const run = await this.load(id); if (run.taskKey === taskKey && !terminalClaimOwners.has(run.status)) return run; } }
}

export class Lease {
  constructor(dir, id) { this.file = files(dir, id).lease; }
  async acquire(generation) {
    await privateDir(dirname(this.file)); const token = `${process.pid}:${generation}:${Date.now()}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const handle = await open(this.file, "wx", 0o600); await handle.writeFile(token); await handle.sync(); await handle.close(); this.token = token; return { token, generation, lease: generation }; }
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
  async release() { try { if (this.token && await readFile(this.file, "utf8") === this.token) await unlink(this.file); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}
