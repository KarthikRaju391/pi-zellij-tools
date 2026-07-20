import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFile = promisify(execFileCallback);
const ROOT = "/Users/karthik/code";
const STATE_DIR = "/Users/karthik/.pi/agent/state/agent-memory-monitor";
const INTERVAL_MS = 60_000;
const MAX_JSONL_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 4_000;
const MAX_TASKS = 500;
const MAX_NOTIFIED = 1_000;
const MAX_PENDING = 500;
const LOCK_STALE_MS = 5 * 60 * 1000;
const SETTLED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type TaskState = "idle" | "running" | "settled" | "failed" | "blocked" | "missing";
type Task = {
  zellijSession: string;
  tab: string;
  pane: string;
  sessionFile: string;
  cwd?: string;
  state: TaskState;
  finalAssistantId?: string;
  lastEntryId?: string;
  lastEntryTimestamp?: number;
  statusEntryId?: string;
  missingCount: number;
  missingGeneration: number;
  updatedAt: number;
};
type Event = { key: string; kind: "settled" | "failed" | "blocked" | "missing"; task: Task };
type Checkpoint = {
  version: 1;
  masterSessionId: string;
  enabled: boolean;
  initialized: boolean;
  lastSuccessfulScan: number;
  tasks: Record<string, Task>;
  notified: string[];
  pending: Event[];
};
type Pane = Record<string, unknown>;
export type ScanResult = {
  found: Map<string, Omit<Task, "missingCount" | "missingGeneration" | "updatedAt"> & Pick<Task, "state">>;
  unreadable: Set<string>;
  heartbeatKeys: Set<string>;
};

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined; }
  return undefined;
}
function entryTimestamp(entry: Record<string, any>): number | undefined { return timestamp(entry.timestamp ?? entry.message?.timestamp); }
function entryId(entry: Record<string, any>): string | undefined { return typeof entry.id === "string" ? entry.id : typeof entry.message?.id === "string" ? entry.message.id : undefined; }
function contentState(entry: Record<string, any>): string | undefined {
  const data = asRecord(entry.data) ?? asRecord(entry.details);
  return typeof data?.state === "string" ? data.state : undefined;
}
function underRoot(cwd: unknown): boolean {
  const path = typeof cwd === "string" ? resolve(cwd) : "";
  return path === ROOT || path.startsWith(`${ROOT}/`);
}
function stableTaskKey(task: Pick<Task, "zellijSession" | "pane" | "sessionFile">): string {
  return `${task.zellijSession}:${task.pane}:${basename(task.sessionFile)}`;
}

/** Metadata-only state derivation; it intentionally never inspects message content. */
export function deriveState(entries: Record<string, any>[]): Pick<Task, "state" | "finalAssistantId" | "lastEntryId" | "lastEntryTimestamp" | "statusEntryId"> {
  let state: TaskState = "idle";
  let finalAssistantId: string | undefined;
  let statusEntryId: string | undefined;
  let latest: Record<string, any> | undefined;
  for (const entry of entries) {
    const message = asRecord(entry.message);
    if (entry.type === "message" && ["user", "assistant", "toolUse", "toolResult"].includes(message?.role)) {
      latest = entry;
      if (message?.role === "assistant") {
        const stop = message.stopReason ?? entry.stopReason;
        if (["error", "aborted"].includes(stop) || message.errorMessage) { state = "failed"; finalAssistantId = undefined; statusEntryId = entryId(entry); }
        else if (["stop", "end"].includes(stop)) { state = "settled"; finalAssistantId = entryId(entry); statusEntryId = undefined; }
        else { state = "running"; finalAssistantId = undefined; statusEntryId = undefined; }
      } else { state = "running"; finalAssistantId = undefined; statusEntryId = undefined; }
    }
    if (entry.type === "custom" && ["pi-subagent-status", "agent-memory-status"].includes(entry.customType)) {
      const status = contentState(entry);
      if (["running", "settled", "failed", "blocked"].includes(status || "")) {
        latest = entry;
        state = status as TaskState;
        statusEntryId = state === "failed" || state === "blocked" ? entryId(entry) : undefined;
        if (state !== "settled") finalAssistantId = undefined;
      }
    }
  }
  const last = latest ?? entries.at(-1);
  return { state, finalAssistantId, lastEntryId: last ? entryId(last) : undefined, lastEntryTimestamp: last ? entryTimestamp(last) : undefined, statusEntryId };
}

function watcherTab(tab: string): boolean { return /(?:^|[-_\s])(?:watcher|monitor|poller)(?:$|[-_\s])/i.test(tab); }
function heartbeatText(entries: Record<string, any>[], finalAssistantId: string | undefined): string | undefined {
  if (!finalAssistantId) return undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const message = asRecord(entry.message);
    if (entryId(entry) === finalAssistantId && message?.role === "assistant" && ["stop", "end"].includes(message.stopReason ?? entry.stopReason) && typeof message.content === "string") return message.content.length <= 1024 ? message.content.replace(/\s+/g, " ").trim() : undefined;
  }
  return undefined;
}
/** Conservative, transient-only classification for watcher heartbeat finals. */
export function isHeartbeatFinal(tab: string, text: string | undefined): boolean {
  if (!watcherTab(tab) || !text) return false;
  return /^(?!.*(?:,|;)\s*but\b)no new [^.;!?]+[.;]\s*monitoring (?:continues|resumes) in \d+ (?:seconds?|minutes?|hours?)\.?$/i.test(text)
    || /^clickup retrieval failed[.;]\s*(?:checkpoint|watermark) retained[.;]\s*retry scheduled(?: in)? \d+ (?:seconds?|minutes?|hours?)\.?$/i.test(text)
    || /^checkpoint(?: (?:retained|updated))?[.;]\s*(?:watcher )?sleeping(?: until next (?:scan|poll) in \d+ (?:seconds?|minutes?|hours?))?\.?$/i.test(text);
}

function sessionPathFromCommand(command: unknown): string | undefined {
  if (typeof command !== "string" || !/(?:^|\s)(?:\S*\/)?(?:pi|pi-pool)(?:\s|$)/.test(command)) return undefined;
  const match = command.match(/--(?:session|fork)(?:=|\s+)(["']?)([^\s"']+\.jsonl)\1/);
  return match ? resolve(match[2]) : undefined;
}

export function candidateFromPane(zellijSession: string, pane: Pane): { key: string; task: Omit<Task, "state" | "missingCount" | "missingGeneration" | "updatedAt"> } | undefined {
  if (zellijSession === "agent-memory" || pane.is_plugin || pane.exited || pane.is_held || pane.is_suppressed) return undefined;
  const command = typeof pane.terminal_command === "string" ? pane.terminal_command : pane.pane_command;
  const sessionFile = sessionPathFromCommand(command);
  const rawPaneId = String(pane.id ?? "");
  const paneId = /^terminal_\d+$/.test(rawPaneId) ? rawPaneId : /^\d+$/.test(rawPaneId) ? `terminal_${rawPaneId}` : "";
  if (!sessionFile || !paneId) return undefined;
  return {
    key: `${zellijSession}:${paneId}:${basename(sessionFile)}`,
    task: { zellijSession, tab: typeof pane.tab_name === "string" ? pane.tab_name : "", pane: paneId, sessionFile, cwd: typeof pane.pane_cwd === "string" ? pane.pane_cwd : undefined, finalAssistantId: undefined, lastEntryId: undefined, lastEntryTimestamp: undefined, statusEntryId: undefined },
  };
}

/** Exact master detection deliberately does not require a Pi child-session argument. */
export function isExactMasterPane(env: Record<string, string | undefined>, pane: Pane): boolean {
  return Boolean(env.ZELLIJ_SESSION_NAME && env.ZELLIJ_PANE_ID && !pane.is_plugin && !pane.exited && !pane.is_held && !pane.is_suppressed && String(pane.id) === env.ZELLIJ_PANE_ID && pane.tab_name === "master-orchestrator" && underRoot(pane.pane_cwd));
}

async function readJsonlBounded(file: string): Promise<Record<string, any>[]> {
  const before = await stat(file);
  const size = Math.min(before.size, MAX_JSONL_BYTES);
  const handle = await open(file, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, Math.max(0, before.size - size));
    text = buffer.toString("utf8");
  } finally { await handle.close(); }
  const after = await stat(file);
  const changed = after.size !== before.size || after.mtimeMs !== before.mtimeMs;
  const cropped = before.size > size ? text.slice(text.indexOf("\n") + 1) : text;
  const lines = cropped.split(/\r?\n/);
  const trailing = lines.pop() ?? "";
  const complete = lines.filter(Boolean).slice(-MAX_ENTRIES);
  const entries = complete.map((line) => JSON.parse(line) as Record<string, any>);
  if (!trailing) return entries;
  try { entries.push(JSON.parse(trailing) as Record<string, any>); }
  catch (error) {
    // Only a record proven to be concurrently changing may be an incomplete trailing write.
    if (!changed) throw error;
  }
  return entries.slice(-MAX_ENTRIES);
}

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFile(command, args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}

export async function scanLive(): Promise<ScanResult> {
  const sessions = (await run("zellij", ["list-sessions", "--no-formatting"])).split(/\r?\n/)
    .filter((line) => line && !line.includes("(EXITED"))
    .map((line) => line.trim().split(/\s+/)[0]).filter((name) => name && name !== "agent-memory");
  const found: ScanResult["found"] = new Map();
  const unreadable = new Set<string>();
  const heartbeatKeys = new Set<string>();
  for (const session of sessions) {
    // Inventory failure is global: do not advance any checkpoint watermark.
    const panes = JSON.parse(await run("zellij", ["--session", session, "action", "list-panes", "--json", "--all"])) as Pane[];
    if (!Array.isArray(panes)) throw new Error("zellij pane inventory was not an array");
    for (const pane of panes) {
      const candidate = candidateFromPane(session, pane);
      if (!candidate) continue;
      try {
        const entries = await readJsonlBounded(candidate.task.sessionFile);
        const state = deriveState(entries);
        found.set(candidate.key, { ...candidate.task, ...state });
        if (state.state === "settled" && isHeartbeatFinal(candidate.task.tab, heartbeatText(entries, state.finalAssistantId))) heartbeatKeys.add(candidate.key);
      } catch { unreadable.add(candidate.key); }
    }
  }
  return { found, unreadable, heartbeatKeys };
}

function eventKey(kind: Event["kind"], task: Task, id: string): string { return `${kind}:${stableTaskKey(task)}:${id}`; }
export function applyScan(previous: Checkpoint, scan: ScanResult, now = Date.now()): { checkpoint: Checkpoint; events: Event[] } {
  const checkpoint: Checkpoint = JSON.parse(JSON.stringify(previous));
  checkpoint.pending ??= [];
  const events: Event[] = [];
  const known = new Set([...checkpoint.notified, ...checkpoint.pending.map((event) => event.key)]);
  const add = (kind: Event["kind"], task: Task, id: string | undefined) => {
    if (!id) return;
    const key = eventKey(kind, task, id);
    if (!known.has(key)) { known.add(key); events.push({ key, kind, task }); }
  };
  for (const [key, observed] of scan.found) {
    const old = checkpoint.tasks[key];
    const task: Task = { ...observed, missingCount: 0, missingGeneration: old?.missingGeneration ?? 0, updatedAt: now };
    checkpoint.tasks[key] = task;
    if (!checkpoint.initialized) continue;
    if (!old) {
      if (task.state === "settled" && !scan.heartbeatKeys.has(key)) add("settled", task, task.finalAssistantId);
      if (task.state === "failed") add("failed", task, task.statusEntryId ?? task.lastEntryId);
      if (task.state === "blocked") add("blocked", task, task.statusEntryId);
      continue;
    }
    if (task.state === "settled" && task.finalAssistantId !== old.finalAssistantId && !scan.heartbeatKeys.has(key)) add("settled", task, task.finalAssistantId);
    if (task.state === "failed" && (old.state !== "failed" || task.statusEntryId !== old.statusEntryId)) add("failed", task, task.statusEntryId ?? task.lastEntryId);
    if (task.state === "blocked" && (old.state !== "blocked" || task.statusEntryId !== old.statusEntryId)) add("blocked", task, task.statusEntryId);
  }
  if (checkpoint.initialized) for (const [key, task] of Object.entries(checkpoint.tasks)) {
    if (scan.found.has(key) || scan.unreadable.has(key) || task.state !== "running") continue;
    task.missingCount += 1;
    if (task.missingCount === 1) task.missingGeneration += 1;
    task.updatedAt = now;
    if (task.missingCount >= 2) { task.state = "missing"; add("missing", task, `${task.missingGeneration}`); }
  }
  checkpoint.initialized = true;
  checkpoint.lastSuccessfulScan = now;
  checkpoint.notified = checkpoint.notified.slice(-MAX_NOTIFIED);
  checkpoint.pending = checkpoint.pending.filter((event) => now - event.task.updatedAt <= MAX_RETENTION_MS).slice(-MAX_PENDING);
  checkpoint.tasks = Object.fromEntries(Object.entries(checkpoint.tasks).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_TASKS)
    .filter(([, task]) => now - task.updatedAt <= (task.state === "settled" || task.state === "missing" ? SETTLED_RETENTION_MS : MAX_RETENTION_MS)));
  return { checkpoint, events };
}

function checkpointFile(sessionId: string, stateDir = STATE_DIR): string { return join(stateDir, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`); }
function emptyCheckpoint(masterSessionId: string, enabled = false): Checkpoint {
  return { version: 1, masterSessionId, enabled, initialized: false, lastSuccessfulScan: 0, tasks: {}, notified: [], pending: [] };
}
function legacyPaneFromKey(key: string, task: Task): string | undefined {
  const prefix = `${task.zellijSession}:`;
  const suffix = `:${basename(task.sessionFile)}`;
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return undefined;
  const pane = key.slice(prefix.length, -suffix.length);
  return /^\d+$/.test(pane) ? `terminal_${pane}` : undefined;
}
function normalizedTask(task: Task, legacyPane = ""): Task {
  const pane = /^\d+$/.test(task.pane) ? `terminal_${task.pane}` : legacyPane || task.pane;
  return pane === task.pane ? task : { ...task, pane };
}
function taskFreshness(left: Task, right: Task): number {
  return left.updatedAt - right.updatedAt || (left.lastEntryTimestamp ?? 0) - (right.lastEntryTimestamp ?? 0) || (left.lastEntryId ?? "").localeCompare(right.lastEntryId ?? "");
}
function boundedUnique(values: string[], max: number): string[] {
  const unique = new Set<string>();
  for (const value of values) { unique.delete(value); unique.add(value); }
  return [...unique].slice(-max);
}
/** Metadata-only compatibility migration; its result persists only through a later normal save. */
function migrateCheckpoint(checkpoint: Checkpoint): Checkpoint {
  const mappings = new Map<string, string>();
  const selections = new Map<string, { task: Task; source: string }>();
  for (const [key, rawTask] of Object.entries(checkpoint.tasks)) {
    const task = normalizedTask(rawTask, legacyPaneFromKey(key, rawTask));
    const normalizedKey = stableTaskKey(task);
    mappings.set(key, normalizedKey);
    mappings.set(stableTaskKey(rawTask), normalizedKey);
    const existing = selections.get(normalizedKey);
    if (!existing || taskFreshness(task, existing.task) > 0 || (taskFreshness(task, existing.task) === 0 && key > existing.source)) selections.set(normalizedKey, { task, source: key });
  }
  const tasks = Object.fromEntries([...selections.entries()].map(([key, value]) => [key, value.task]));
  const migrateEvent = (event: Event): Event => {
    const task = normalizedTask(event.task);
    let key = event.key;
    for (const [oldKey, newKey] of mappings) {
      const prefix = `${event.kind}:${oldKey}:`;
      if (key.startsWith(prefix)) { key = `${event.kind}:${newKey}:${key.slice(prefix.length)}`; break; }
    }
    return { ...event, key, task: tasks[stableTaskKey(task)] ?? task };
  };
  const pending = new Map<string, Event>();
  for (const event of checkpoint.pending ?? []) {
    const migrated = migrateEvent(event);
    const existing = pending.get(migrated.key);
    if (!existing || taskFreshness(migrated.task, existing.task) >= 0) { pending.delete(migrated.key); pending.set(migrated.key, migrated); }
  }
  const notified = boundedUnique(checkpoint.notified.map((key) => {
    for (const [oldKey, newKey] of mappings) {
      const prefix = `:${oldKey}:`;
      if (key.includes(prefix)) return key.replace(prefix, `:${newKey}:`);
    }
    return key;
  }), MAX_NOTIFIED);
  return { ...checkpoint, tasks, notified, pending: [...pending.values()].slice(-MAX_PENDING) };
}
/** Existing durable control always wins; initialEnabled applies only when no valid checkpoint exists. */
async function loadCheckpoint(masterSessionId: string, stateDir = STATE_DIR, initialEnabled = false): Promise<Checkpoint> {
  try {
    const parsed = JSON.parse(await readFile(checkpointFile(masterSessionId, stateDir), "utf8")) as Checkpoint;
    return parsed.version === 1 && parsed.masterSessionId === masterSessionId ? migrateCheckpoint({ ...parsed, pending: parsed.pending ?? [] }) : emptyCheckpoint(masterSessionId, initialEnabled);
  } catch { return emptyCheckpoint(masterSessionId, initialEnabled); }
}
function loadCheckpointSync(masterSessionId: string, stateDir = STATE_DIR, initialEnabled = false): Checkpoint {
  try {
    const parsed = JSON.parse(readFileSync(checkpointFile(masterSessionId, stateDir), "utf8")) as Checkpoint;
    return parsed.version === 1 && parsed.masterSessionId === masterSessionId ? migrateCheckpoint({ ...parsed, pending: parsed.pending ?? [] }) : emptyCheckpoint(masterSessionId, initialEnabled);
  } catch { return emptyCheckpoint(masterSessionId, initialEnabled); }
}
export async function saveCheckpoint(checkpoint: Checkpoint, stateDir = STATE_DIR): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const finalPath = checkpointFile(checkpoint.masterSessionId, stateDir);
  const temporary = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, finalPath);
    await chmod(finalPath, 0o600);
  } finally { await unlink(temporary).catch(() => undefined); }
}
/** Synchronous same-directory atomic replace for the lock-held commit/deliver/ack critical section. */
function saveCheckpointSync(checkpoint: Checkpoint, stateDir = STATE_DIR): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const finalPath = checkpointFile(checkpoint.masterSessionId, stateDir);
  const temporary = `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, finalPath);
    chmodSync(finalPath, 0o600);
  } finally { try { unlinkSync(temporary); } catch { /* renamed or absent */ } }
}
function sleep(ms: number): Promise<void> { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }
async function withCheckpointLock<T>(masterSessionId: string, work: () => T | Promise<T>, stateDir = STATE_DIR): Promise<T> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const lock = `${checkpointFile(masterSessionId, stateDir)}.lock`;
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      const handle = await open(lock, "wx", 0o600);
      try { await chmod(lock, 0o600); return await work(); }
      finally { await handle.close(); await unlink(lock).catch(() => undefined); }
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await unlink(lock); }
      catch { /* another owner released or refreshed it */ }
      if (Date.now() >= deadline) throw new Error("agent-memory monitor checkpoint lock timed out");
      await sleep(50);
    }
  }
}

function isSubagent(ctx: ExtensionContext): boolean {
  return process.env.PI_SUBAGENT === "1" || ctx.sessionManager.getEntries().some((entry: any) => entry.type === "custom" && entry.customType === "pi-subagent");
}
function explicitEnabled(ctx: ExtensionContext): boolean | undefined {
  let result: boolean | undefined;
  for (const entry of ctx.sessionManager.getEntries() as any[]) if (entry.type === "custom" && entry.customType === "agent-memory-monitor-control" && typeof entry.data?.enabled === "boolean") result = entry.data.enabled;
  return result;
}
/** Explicit session control wins; only an absent durable checkpoint keeps first-install auto-start. */
export function startupAllowed(exactMaster: boolean, sessionControl: boolean | undefined, durableControl: boolean | undefined): boolean {
  return exactMaster && (sessionControl ?? durableControl ?? true);
}
async function durableEnabled(masterSessionId: string, stateDir = STATE_DIR): Promise<boolean | undefined> {
  try {
    const checkpoint = JSON.parse(await readFile(checkpointFile(masterSessionId, stateDir), "utf8")) as Checkpoint;
    return checkpoint.version === 1 && checkpoint.masterSessionId === masterSessionId && typeof checkpoint.enabled === "boolean" ? checkpoint.enabled : undefined;
  } catch { return undefined; }
}
async function currentTabIsMaster(): Promise<boolean> {
  const session = process.env.ZELLIJ_SESSION_NAME;
  if (!session || !process.env.ZELLIJ_PANE_ID) return false;
  const panes = JSON.parse(await run("zellij", ["--session", session, "action", "list-panes", "--json", "--all"])) as Pane[];
  return Array.isArray(panes) && panes.some((pane) => isExactMasterPane(process.env, pane));
}
function monitorMessage(events: Event[]): { content: string; details: Record<string, unknown> } {
  const tasks = events.map(({ key, kind, task }) => ({ event: key, kind, zellij_session: task.zellijSession, tab: task.tab, pane_id: task.pane, session_file: task.sessionFile, state: task.state, final_assistant_id: task.finalAssistantId, cwd: task.cwd, timestamp: task.lastEntryTimestamp }));
  return { content: "Agent-memory monitor found new metadata-only events. Use this agent-driving bounded state machine: (1) re-read each event metadata and changed Pi session final read-only with pi_subagent_read(session_file, mode=final); verify it is settled, failed, or blocked now. (2) When a task ID is available, recover its ClickUp task, comments, and threaded replies read-only; inspect /Users/karthik/code/.agents/MEMORY.md and only relevant settled session finals/reports for dependencies, duplicate work, shared files/branches, or root cause. (3) Deduplicate: stop if consumed, active work exists, or a PR exists. (4) If one next step is obvious, scoped, and safe, drive it: prefer pi_subagent_send to the exact zellij_session and pane_id; otherwise launch the smallest workflow in that same Zellij session with one writer and preserved constraints. Read-only investigations may proceed. (5) For a code fix, use a persistent executor then independent read-only reviewer loop. Only after approval, executor must fetch and rebase latest base, rerun relevant E2E/regression checks after rebase, ensure clean scoped diff/worktree and no competing PR, then push and create a PR for human review; report CI pending until it runs. NEVER merge the PR. (6) Never deploy, mutate production/data, run migrations/backfills, update ClickUp/Slack, or send external messages without separate authorization. On ambiguity, product/human decision, credentials, destructive action, or active-work conflict, report blocked and ask the user; retry read-only/idempotent recovery at most once and never auto-retry writes. (7) Atomically update MEMORY with evidence, then tell the user what was driven, why, exact agent/task/PR/check status, and remaining boundary. If nothing material, create no work.", details: { events: tasks } };
}

/** Scan slowly outside the lock; serialize only checkpoint mutation and delivery. */
export async function checkpointedScan(options: { masterSessionId: string; automatic: boolean; scan: () => Promise<ScanResult>; send: (message: ReturnType<typeof monitorMessage>) => void; runtimeCurrent?: () => boolean; stateDir?: string }): Promise<boolean> {
  const scan = await options.scan();
  const current = () => !options.automatic || options.runtimeCurrent?.() === true;
  if (!current()) return false; // /off or session_shutdown happened while the slow scan ran.
  return withCheckpointLock(options.masterSessionId, () => {
    // Re-read under the lock: /off from this or another master wins over an in-flight scan.
    const previous = loadCheckpointSync(options.masterSessionId, options.stateDir, options.automatic);
    if (!current() || (options.automatic && !previous.enabled)) return false;
    const { checkpoint, events } = applyScan(previous, scan);
    if (!current()) return false;
    for (const event of events) if (!checkpoint.pending.some((pending) => pending.key === event.key)) checkpoint.pending.push(event);
    checkpoint.pending = checkpoint.pending.slice(-MAX_PENDING);
    // No await below this validation: save, send, and acknowledgement are one linearizable critical section.
    saveCheckpointSync(checkpoint, options.stateDir);
    if (!checkpoint.pending.length) return true;
    const pending = [...checkpoint.pending];
    options.send(monitorMessage(pending));
    checkpoint.notified = [...checkpoint.notified, ...pending.map((event) => event.key)].slice(-MAX_NOTIFIED);
    checkpoint.pending = [];
    saveCheckpointSync(checkpoint, options.stateDir);
    return true;
  }, options.stateDir);
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanning = false;
  let active = false;
  let runtimeGeneration = 0;
  let masterSessionId = "";
  let ctxRef: ExtensionContext | undefined;
  const stop = () => { runtimeGeneration++; if (timer) clearTimeout(timer); timer = undefined; active = false; };
  const schedule = (generation: number) => { if (active && generation === runtimeGeneration && !timer) timer = setTimeout(() => void tick(generation), INTERVAL_MS); };
  const isExactMaster = async (ctx: ExtensionContext) => underRoot(ctx.cwd) && !isSubagent(ctx) && await currentTabIsMaster();
  const isEligibleMaster = async (ctx: ExtensionContext) => {
    const sessionControl = explicitEnabled(ctx);
    const exactMaster = await isExactMaster(ctx);
    return startupAllowed(exactMaster, sessionControl, sessionControl === undefined ? await durableEnabled(masterSessionId) : undefined);
  };
  const performScan = async (automatic: boolean, generation = runtimeGeneration) => checkpointedScan({
    masterSessionId,
    automatic,
    runtimeCurrent: () => !automatic || (active && generation === runtimeGeneration),
    scan: scanLive,
    send: (message) => pi.sendMessage({ customType: "agent-memory-monitor", content: message.content, details: message.details, display: true }, { deliverAs: "followUp", triggerTurn: true }),
  });
  const tick = async (generation: number) => {
    timer = undefined;
    if (!active || generation !== runtimeGeneration || scanning || !ctxRef) return;
    scanning = true;
    try {
      const committed = await performScan(true, generation);
      if (!committed && generation === runtimeGeneration) stop();
    } catch { if (generation === runtimeGeneration) ctxRef.ui.notify("Agent-memory monitor scan failed; retaining prior checkpoint.", "warning"); }
    finally { scanning = false; schedule(generation); }
  };
  const startIfEligible = async (ctx: ExtensionContext) => {
    ctxRef = ctx;
    if (!await isEligibleMaster(ctx)) return stop();
    active = true;
    const generation = ++runtimeGeneration;
    void tick(generation);
  };

  pi.on("session_start", async (_event, ctx) => { masterSessionId = ctx.sessionManager.getSessionId(); await startIfEligible(ctx); });
  pi.on("session_shutdown", () => stop());
  pi.registerCommand("agent-memory-monitor", {
    description: "Control metadata-only 60-second master-agent memory monitoring: on, off, status, scan",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (!["on", "off", "status", "scan"].includes(command)) { ctx.ui.notify("Usage: /agent-memory-monitor on|off|status|scan", "warning"); return; }
      if (!masterSessionId) masterSessionId = ctx.sessionManager.getSessionId();
      if (command === "off") {
        stop(); // Invalidate any scan before it can acquire the checkpoint lock.
        pi.appendEntry("agent-memory-monitor-control", { enabled: false, timestamp: Date.now() });
        await withCheckpointLock(masterSessionId, async () => saveCheckpoint({ ...await loadCheckpoint(masterSessionId), enabled: false }));
        ctx.ui.notify("Agent-memory monitor disabled.", "info"); return;
      }
      if (command === "on") {
        if (!await isExactMaster(ctx)) { ctx.ui.notify("Monitor requires this exact non-subagent master-orchestrator pane under /Users/karthik/code.", "warning"); return; }
        pi.appendEntry("agent-memory-monitor-control", { enabled: true, timestamp: Date.now() });
        await withCheckpointLock(masterSessionId, async () => saveCheckpoint({ ...await loadCheckpoint(masterSessionId), enabled: true }));
        await startIfEligible(ctx); ctx.ui.notify("Agent-memory monitor enabled.", "info"); return;
      }
      if (command === "scan") {
        if (!await isExactMaster(ctx) || scanning) { ctx.ui.notify(scanning ? "A monitor scan is already in progress." : "Monitor requires this exact non-subagent master-orchestrator pane under /Users/karthik/code.", "warning"); return; }
        ctxRef = ctx; scanning = true;
        try { await performScan(false); ctx.ui.notify("Agent-memory monitor scan completed.", "info"); }
        catch { ctx.ui.notify("Agent-memory monitor scan failed; retaining prior checkpoint.", "warning"); }
        finally { scanning = false; }
        return;
      }
      const checkpoint = await loadCheckpoint(masterSessionId);
      ctx.ui.notify(`Agent-memory monitor: ${active ? "on" : "off"}; baseline=${checkpoint.initialized ? "ready" : "pending"}; last_success=${checkpoint.lastSuccessfulScan || "none"}.`, "info");
    },
  });
}

async function selfTest(): Promise<void> {
  if (startupAllowed(true, undefined, false) || !startupAllowed(true, undefined, true) || !startupAllowed(true, undefined, undefined) || startupAllowed(true, false, true) || !startupAllowed(true, true, false) || startupAllowed(false, true, undefined)) throw new Error("startup gate did not preserve durable/session control precedence");
  const base = emptyCheckpoint("test", true);
  const running: ScanResult = { found: new Map([["s:terminal_1:a.jsonl", { zellijSession: "s", tab: "t", pane: "terminal_1", sessionFile: "/tmp/a.jsonl", state: "running" as const }]]), unreadable: new Set(), heartbeatKeys: new Set() };
  let result = applyScan(base, running, 1);
  if (result.events.length) throw new Error("baseline emitted an event");
  const settled: ScanResult = { found: new Map([["s:terminal_1:a.jsonl", { ...running.found.get("s:terminal_1:a.jsonl")!, state: "settled" as const, finalAssistantId: "final-1" }]]), unreadable: new Set(), heartbeatKeys: new Set() };
  result = applyScan(result.checkpoint, settled, 2);
  if (result.events.map((event) => event.key).join() !== "settled:s:terminal_1:a.jsonl:final-1") throw new Error("new settlement was not emitted");
  result = applyScan({ ...result.checkpoint, pending: [...result.events] }, settled, 3);
  if (result.events.length) throw new Error("pending settlement was not deduped");
  result = applyScan(result.checkpoint, { found: new Map([["s:terminal_1:a.jsonl", { ...settled.found.get("s:terminal_1:a.jsonl")!, finalAssistantId: "final-2" }]]), unreadable: new Set(), heartbeatKeys: new Set() }, 4);
  if (result.events.map((event) => event.key).join() !== "settled:s:terminal_1:a.jsonl:final-2") throw new Error("second settlement missing");
  const heartbeatExamples = [
    "No new Neeraj PR requests; monitoring continues in 5 minutes.",
    "No new Neeraj PR requests before the durable watermark. Monitoring resumes in 5 minutes.",
    "ClickUp retrieval failed; checkpoint retained. Retry scheduled in 5 minutes.",
    "Checkpoint retained. Watcher sleeping until next poll in 5 minutes.",
  ];
  const heartbeatKey = "s:terminal_4:watcher.jsonl";
  const heartbeatBase = applyScan(emptyCheckpoint("heartbeat", true), { found: new Map([[heartbeatKey, { zellijSession: "s", tab: "neeraj-pr-watcher", pane: "terminal_4", sessionFile: "/tmp/watcher.jsonl", state: "running" as const }]]), unreadable: new Set(), heartbeatKeys: new Set() }, 1).checkpoint;
  for (const [index, text] of heartbeatExamples.entries()) {
    if (!isHeartbeatFinal("neeraj-pr-watcher", text) || isHeartbeatFinal("worker", text)) throw new Error("heartbeat classifier scope failed");
    const heartbeat: ScanResult = { found: new Map([[heartbeatKey, { ...heartbeatBase.tasks[heartbeatKey], state: "settled" as const, finalAssistantId: `heartbeat-${index}` }]]), unreadable: new Set(), heartbeatKeys: new Set([heartbeatKey]) };
    const suppressed = applyScan(heartbeatBase, heartbeat, index + 2);
    if (suppressed.events.length || suppressed.checkpoint.tasks[heartbeatKey].finalAssistantId !== `heartbeat-${index}`) throw new Error("heartbeat was not suppressed while advancing watermark");
    if (applyScan(suppressed.checkpoint, heartbeat, index + 3).events.length) throw new Error("repeated heartbeat emitted");
  }
  const material = "PR #952 approved for human review.";
  const noNewMaterial = "No new PR requests, but PR #952 approved; monitoring continues in 5 minutes.";
  if (isHeartbeatFinal("neeraj-pr-watcher", material) || isHeartbeatFinal("neeraj-pr-watcher", noNewMaterial)) throw new Error("material watcher final was suppressed");
  const materialScan: ScanResult = { found: new Map([[heartbeatKey, { ...heartbeatBase.tasks[heartbeatKey], state: "settled" as const, finalAssistantId: "material-1" }]]), unreadable: new Set(), heartbeatKeys: new Set() };
  const materialResult = applyScan(heartbeatBase, materialScan, 10);
  if (!materialResult.events.some((event) => event.key === "settled:s:terminal_4:watcher.jsonl:material-1")) throw new Error("material watcher final missing");
  const noNewMaterialResult = applyScan(heartbeatBase, { ...materialScan, found: new Map([[heartbeatKey, { ...heartbeatBase.tasks[heartbeatKey], state: "settled" as const, finalAssistantId: "material-2" }]]) }, 11);
  if (!noNewMaterialResult.events.some((event) => event.key === "settled:s:terminal_4:watcher.jsonl:material-2")) throw new Error("material no-new watcher final missing");
  const heartbeatSerialized = JSON.stringify({ checkpoint: noNewMaterialResult.checkpoint, events: [...materialResult.events, ...noNewMaterialResult.events] });
  if ([...heartbeatExamples, material, noNewMaterial].some((text) => heartbeatSerialized.includes(text))) throw new Error("final text persisted");
  const failed: ScanResult = { found: new Map([["s:terminal_2:b.jsonl", { zellijSession: "s", tab: "t", pane: "terminal_2", sessionFile: "/tmp/b.jsonl", state: "failed" as const, statusEntryId: "failed-1" }]]), unreadable: new Set(), heartbeatKeys: new Set(["s:terminal_2:b.jsonl"]) };
  result = applyScan(result.checkpoint, failed, 5);
  if (!result.events.some((event) => event.key === "failed:s:terminal_2:b.jsonl:failed-1")) throw new Error("failed event missing");
  const blocked: ScanResult = { found: new Map([["s:terminal_3:c.jsonl", { zellijSession: "s", tab: "t", pane: "terminal_3", sessionFile: "/tmp/c.jsonl", state: "blocked" as const, statusEntryId: "blocked-1" }]]), unreadable: new Set(), heartbeatKeys: new Set(["s:terminal_3:c.jsonl"]) };
  result = applyScan(result.checkpoint, blocked, 6);
  if (!result.events.some((event) => event.key === "blocked:s:terminal_3:c.jsonl:blocked-1")) throw new Error("blocked event missing");
  const candidate = candidateFromPane("s", { id: 1, terminal_command: "pi --session /tmp/a.jsonl" });
  if (!isExactMasterPane({ ZELLIJ_SESSION_NAME: "master", ZELLIJ_PANE_ID: "9" }, { id: 9, tab_name: "master-orchestrator", pane_cwd: ROOT, pane_command: "pi-pool" }) || isExactMasterPane({ ZELLIJ_SESSION_NAME: "master", ZELLIJ_PANE_ID: "9" }, { id: 9, tab_name: "other", pane_cwd: ROOT }) || candidate?.task.pane !== "terminal_1" || candidateFromPane("agent-memory", { id: 1, terminal_command: "pi --session /tmp/a.jsonl" }) || candidateFromPane("s", { id: 1, is_held: true, terminal_command: "pi --session /tmp/a.jsonl" }) || candidateFromPane("s", { id: 1, pane_command: "zsh" }) || JSON.stringify(candidate).includes("pi --session")) throw new Error("master detection, pane exclusion, or command redaction failed");
  const missingBase = applyScan(emptyCheckpoint("missing", true), running, 1).checkpoint;
  result = applyScan(missingBase, { found: new Map(), unreadable: new Set(), heartbeatKeys: new Set() }, 2);
  if (result.events.length) throw new Error("first missing scan emitted");
  result = applyScan(result.checkpoint, { found: new Map(), unreadable: new Set(), heartbeatKeys: new Set() }, 3);
  if (!result.events.some((event) => event.key === "missing:s:terminal_1:a.jsonl:1")) throw new Error("second missing scan did not emit");
  const retained = applyScan(missingBase, { found: new Map(), unreadable: new Set(["s:terminal_1:a.jsonl"]), heartbeatKeys: new Set() }, 2);
  if (retained.checkpoint.tasks["s:terminal_1:a.jsonl"].missingCount !== 0) throw new Error("unreadable candidate counted missing");
  const fixture = [{ type: "message", id: "a", message: { role: "assistant", stopReason: "stop", content: "fixture assistant text" } }, { type: "message", id: "b", message: { role: "user", content: "fixture prompt" } }, { type: "message", id: "c", message: { role: "assistant", stopReason: "toolUse", content: "fixture tool call" } }];
  const message = monitorMessage(result.events);
  const serialized = JSON.stringify({ checkpoint: result.checkpoint, event: message });
  if (serialized.includes("fixture prompt") || serialized.includes("fixture assistant text") || serialized.includes("fixture tool call") || serialized.includes("pi --session") || !["agent-driving", "Deduplicate", "ClickUp", "executor", "rebase", "E2E/regression", "clean scoped diff/worktree", "create a PR", "NEVER merge", "Never deploy"].every((text) => message.content.includes(text)) || !JSON.stringify(message.details).includes("terminal_1") || deriveState(fixture).state !== "running") throw new Error("metadata, driving instruction, or pane details check failed");
  const stateDir = join("/tmp", `agent-memory-monitor-${process.pid}-${Date.now()}`);
  await saveCheckpoint(emptyCheckpoint("startup-disabled", false), stateDir);
  const startupDisabled = await durableEnabled("startup-disabled", stateDir);
  const startupAbsent = await durableEnabled("startup-absent", stateDir);
  if (startupAllowed(true, undefined, startupDisabled) || !startupAllowed(true, true, startupDisabled) || startupAllowed(true, false, startupDisabled) || !startupAllowed(true, undefined, startupAbsent)) throw new Error("durable startup fixture could scan before /on");
  const legacyTask: Task = { zellijSession: "legacy", tab: "legacy-watcher", pane: "3", sessionFile: "/tmp/legacy.jsonl", state: "settled", finalAssistantId: "legacy-final", lastEntryId: "legacy-final", lastEntryTimestamp: 10, missingCount: 0, missingGeneration: 0, updatedAt: 10 };
  const normalizedLegacyTask: Task = { ...legacyTask, pane: "terminal_3", finalAssistantId: "normal-final", lastEntryId: "normal-final", lastEntryTimestamp: 20, updatedAt: 20 };
  const legacyTaskKey = "legacy:3:legacy.jsonl";
  const normalizedTaskKey = "legacy:terminal_3:legacy.jsonl";
  const legacyEvent: Event = { key: "settled:legacy:3:legacy.jsonl:legacy-final", kind: "settled", task: legacyTask };
  const normalizedEvent: Event = { key: "settled:legacy:terminal_3:legacy.jsonl:normal-final", kind: "settled", task: normalizedLegacyTask };
  const fillerNotified = Array.from({ length: MAX_NOTIFIED }, (_, index) => `settled:legacy:3:legacy.jsonl:notice-${index}`);
  const fillerPending: Event[] = Array.from({ length: MAX_PENDING }, (_, index) => ({ key: `settled:legacy:3:legacy.jsonl:pending-${index}`, kind: "settled", task: legacyTask }));
  const legacyCheckpoint: Checkpoint = { ...emptyCheckpoint("legacy", true), initialized: true, tasks: { [legacyTaskKey]: legacyTask, [normalizedTaskKey]: normalizedLegacyTask }, notified: [...fillerNotified, legacyEvent.key, normalizedEvent.key], pending: [...fillerPending, legacyEvent, normalizedEvent] };
  await saveCheckpoint(legacyCheckpoint, stateDir);
  const legacyFile = checkpointFile("legacy", stateDir);
  const legacyBytes = await readFile(legacyFile, "utf8");
  const migratedLegacy = await loadCheckpoint("legacy", stateDir);
  const migratedLegacySync = loadCheckpointSync("legacy", stateDir);
  if (await readFile(legacyFile, "utf8") !== legacyBytes || migratedLegacy.tasks[normalizedTaskKey]?.pane !== "terminal_3" || migratedLegacy.tasks[normalizedTaskKey]?.finalAssistantId !== "normal-final" || Object.keys(migratedLegacy.tasks).length !== 1 || JSON.stringify(migratedLegacy) !== JSON.stringify(migratedLegacySync) || migratedLegacy.notified.length !== MAX_NOTIFIED || migratedLegacy.pending.length !== MAX_PENDING || !migratedLegacy.notified.includes(legacyEvent.key.replace(":3:", ":terminal_3:")) || !migratedLegacy.notified.includes(normalizedEvent.key) || !migratedLegacy.pending.some((event) => event.key === legacyEvent.key.replace(":3:", ":terminal_3:") && event.task.pane === "terminal_3") || JSON.stringify(migratedLegacy).includes("legacy migration semantic content")) throw new Error("legacy checkpoint migration failed");
  const migratedScan: ScanResult = { found: new Map([[normalizedTaskKey, { ...normalizedLegacyTask }]]), unreadable: new Set(), heartbeatKeys: new Set() };
  if (applyScan(migratedLegacy, migratedScan, 30).events.length) throw new Error("migrated settlement emitted a duplicate");
  await saveCheckpoint(migratedLegacy, stateDir);
  const savedMigration = await readFile(legacyFile, "utf8");
  if (savedMigration.includes(legacyTaskKey) || !savedMigration.includes(normalizedTaskKey) || savedMigration.includes("legacy migration semantic content")) throw new Error("normal save did not persist metadata-only migration");
  const persisted = { ...emptyCheckpoint("persisted", true), initialized: true, lastSuccessfulScan: 123 };
  await saveCheckpoint(persisted, stateDir);
  const file = checkpointFile("persisted", stateDir);
  const before = await readFile(file, "utf8");
  try { await checkpointedScan({ masterSessionId: "persisted", automatic: false, stateDir, scan: async () => { throw new Error("simulated scan failure"); }, send: () => undefined }); throw new Error("failed scan was accepted"); }
  catch (error: any) { if (error.message === "failed scan was accepted") throw error; }
  const after = await readFile(file, "utf8");
  if (before !== after || JSON.parse(after).lastSuccessfulScan !== 123) throw new Error("failed perform path changed persisted checkpoint");
  const delivery = applyScan(emptyCheckpoint("delivery", true), running, 1).checkpoint;
  await saveCheckpoint(delivery, stateDir);
  try { await checkpointedScan({ masterSessionId: "delivery", automatic: false, stateDir, scan: async () => settled, send: () => { throw new Error("simulated delivery failure"); } }); }
  catch { /* the pending event must survive delivery failure */ }
  if ((await loadCheckpoint("delivery", stateDir)).pending.length !== 1) throw new Error("delivery failure lost pending event");
  let delivered = 0;
  await checkpointedScan({ masterSessionId: "delivery", automatic: false, stateDir, scan: async () => settled, send: () => { delivered++; } });
  const deliveredCheckpoint = await loadCheckpoint("delivery", stateDir);
  if (delivered !== 1 || deliveredCheckpoint.pending.length || !deliveredCheckpoint.notified.length) throw new Error("pending delivery was not acknowledged once");
  let releaseOff!: () => void;
  let startedOff!: () => void;
  const offGate = new Promise<void>((resolveGate) => { releaseOff = resolveGate; });
  const offStarted = new Promise<void>((resolveStart) => { startedOff = resolveStart; });
  await saveCheckpoint(applyScan(emptyCheckpoint("off", true), running, 1).checkpoint, stateDir);
  let offRuntime = true;
  let offDelivered = 0;
  const offScan = checkpointedScan({ masterSessionId: "off", automatic: true, stateDir, runtimeCurrent: () => offRuntime, scan: async () => { startedOff(); await offGate; return settled; }, send: () => { offDelivered++; } });
  await offStarted;
  offRuntime = false; // /off and session shutdown invalidate runtime before their durable write.
  await withCheckpointLock("off", async () => saveCheckpoint({ ...await loadCheckpoint("off", stateDir), enabled: false }, stateDir), stateDir);
  const offFile = checkpointFile("off", stateDir);
  const disabledBytes = await readFile(offFile, "utf8");
  releaseOff();
  const offResult = await offScan;
  const offChanged = await readFile(offFile, "utf8") !== disabledBytes;
  const offEnabled = (await loadCheckpoint("off", stateDir)).enabled;
  if (offResult || offDelivered || offChanged || offEnabled) throw new Error(`in-flight off scan failed: result=${offResult} delivered=${offDelivered} changed=${offChanged} enabled=${offEnabled}`);
  let releaseStale!: () => void;
  let startedStale!: () => void;
  const staleGate = new Promise<void>((resolveGate) => { releaseStale = resolveGate; });
  const staleStarted = new Promise<void>((resolveStart) => { startedStale = resolveStart; });
  const staleCheckpoint = applyScan(emptyCheckpoint("stale", true), running, 1).checkpoint;
  await saveCheckpoint(staleCheckpoint, stateDir);
  const staleFile = checkpointFile("stale", stateDir);
  const staleBytes = await readFile(staleFile, "utf8");
  let staleRuntime = true;
  let staleDelivered = 0;
  const staleScan = checkpointedScan({ masterSessionId: "stale", automatic: true, stateDir, runtimeCurrent: () => staleRuntime, scan: async () => { startedStale(); await staleGate; return settled; }, send: () => { staleDelivered++; } });
  await staleStarted;
  staleRuntime = false; // session_shutdown generation changed while the scan was in flight.
  releaseStale();
  const staleResult = await staleScan;
  const staleChanged = await readFile(staleFile, "utf8") !== staleBytes;
  if (staleResult || staleDelivered || staleChanged) throw new Error(`stale runtime scan failed: result=${staleResult} delivered=${staleDelivered} changed=${staleChanged}`);
  let manualDelivered = 0;
  await checkpointedScan({ masterSessionId: "off", automatic: false, stateDir, scan: async () => settled, send: () => { manualDelivered++; } });
  if (manualDelivered !== 1 || (await loadCheckpoint("off", stateDir)).enabled) throw new Error("manual scan re-enabled disabled monitoring");
  const linear = applyScan(emptyCheckpoint("linear", true), running, 1).checkpoint;
  await saveCheckpoint(linear, stateDir);
  let linearRuntime = true;
  let linearDelivered = 0;
  let resolveDisable!: () => void;
  let rejectDisable!: (error: unknown) => void;
  const disabledAfterCommit = new Promise<void>((resolveDisablePromise, rejectDisablePromise) => { resolveDisable = resolveDisablePromise; rejectDisable = rejectDisablePromise; });
  await checkpointedScan({
    masterSessionId: "linear", automatic: true, stateDir, runtimeCurrent: () => linearRuntime, scan: async () => settled,
    send: () => {
      linearDelivered++;
      // Queued while the lock-held commit runs; it cannot interleave with sync save/send/ack.
      queueMicrotask(() => {
        linearRuntime = false;
        void withCheckpointLock("linear", () => {
          const checkpoint = loadCheckpointSync("linear", stateDir);
          saveCheckpointSync({ ...checkpoint, enabled: false }, stateDir);
        }, stateDir).then(resolveDisable, rejectDisable);
      });
    },
  });
  await disabledAfterCommit;
  const linearCheckpoint = await loadCheckpoint("linear", stateDir);
  if (linearDelivered !== 1 || linearCheckpoint.enabled || linearCheckpoint.pending.length || !linearCheckpoint.notified.length) throw new Error("queued invalidation interleaved with linear commit/delivery/ack");
  for (const id of ["startup-disabled", "legacy", "persisted", "delivery", "off", "stale", "linear"]) { const path = checkpointFile(id, stateDir); await unlink(path).catch(() => undefined); await unlink(`${path}.lock`).catch(() => undefined); }
  await (await import("node:fs/promises")).rmdir(stateDir);
  process.stdout.write("agent-memory-monitor self-test passed\n");
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === directFile && process.argv.slice(2).includes("--self-test")) void selfTest().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
