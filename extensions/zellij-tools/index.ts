import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const S = {
  string: (description: string) => ({ type: "string", description }),
  number: (description: string) => ({ type: "number", description }),
  boolean: (description: string) => ({ type: "boolean", description }),
};

const DEFAULT_SESSION = "agent-observer";
const DEFAULT_SCROLLBACK = 100;
const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "state");
const STATE_FILE = path.join(STATE_DIR, "zellij-tasks.json");
const EVENTS_DIR = path.join(STATE_DIR, "zellij-events");

type TaskStatus = "starting" | "running" | "ready" | "failed" | "exited" | "closed" | "unknown";
type ZellijTask = {
  id: string;
  session?: string;
  pane_id: string;
  name: string;
  cwd: string;
  command: string;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
  last_snapshot?: string;
  last_exit_code?: number | null;
  notify_agent_on_exit?: boolean;
  trigger_agent_on_exit?: boolean;
  caller_session_file?: string;
  caller_session_id?: string;
  event_emitted_at?: number;
};

type ZellijEvent = {
  task_id: string;
  status: "exited" | "failed";
  exit_code: number;
  completed_at: number;
};
type ZellijState = { version: 1; tasks: ZellijTask[] };

const RunParams = {
  type: "object",
  properties: {
    command: S.string("Command to run in the Zellij pane"),
    name: S.string("Human-readable pane name"),
    cwd: S.string("Working directory for the pane"),
    session: S.string("Zellij session name. Defaults to agent-observer"),
    detached: S.boolean("Use/create a detached background session. Default true"),
    direction: S.string("Split direction for attached sessions: right or down. Default right"),
    placement: S.string("Where to open the task: tab or pane. Default tab for detached sessions, pane for attached sessions"),
    subscribe: S.boolean("Return subscribe command. Default true"),
    notify_agent_on_exit: S.boolean("Write a zellij-task-event message when the command exits. Default true"),
    trigger_agent_on_exit: S.boolean("Automatically wake/continue the agent when the command exits. Default true"),
  },
  required: ["command"],
  additionalProperties: false,
} as const;

const PaneParams = {
  type: "object",
  properties: {
    pane_id: S.string("Pane ID, eg terminal_1"),
    session: S.string("Zellij session name"),
  },
  required: ["pane_id"],
  additionalProperties: false,
} as const;

const SubscribeParams = {
  type: "object",
  properties: {
    pane_id: S.string("Pane ID, eg terminal_1"),
    session: S.string("Zellij session name"),
    scrollback: S.number("Scrollback lines for initial delivery. Default 100"),
    format: S.string("raw or json. Default json"),
    seconds: S.number("Optional max seconds to collect before returning. Default 3"),
  },
  required: ["pane_id"],
  additionalProperties: false,
} as const;

const WaitParams = {
  type: "object",
  properties: {
    pane_id: S.string("Pane ID, eg terminal_1"),
    session: S.string("Zellij session name"),
    pattern: S.string("Regex pattern to wait for in pane output"),
    timeout_seconds: S.number("Max seconds to wait. Default 60"),
    fail_pattern: S.string("Optional regex that fails early if seen"),
  },
  required: ["pane_id", "pattern"],
  additionalProperties: false,
} as const;

const ListParams = {
  type: "object",
  properties: {
    session: S.string("Zellij session name"),
  },
  required: [],
  additionalProperties: false,
} as const;

const TasksParams = {
  type: "object",
  properties: {
    refresh: S.boolean("Refresh statuses from Zellij before returning. Default true"),
  },
  required: [],
  additionalProperties: false,
} as const;


function readState(): ZellijState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { version: 1, tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return { version: 1, tasks: [] };
  }
}

function writeState(state: ZellijState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

function newTaskId(): string {
  const now = Date.now();
  return `zt_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function upsertTask(patch: Partial<ZellijTask> & { pane_id: string }): ZellijTask {
  const state = readState();
  const now = Date.now();
  const existing = state.tasks.find((t) => t.pane_id === patch.pane_id && (patch.session === undefined || t.session === patch.session));
  const task: ZellijTask = existing
    ? { ...existing, ...patch, updated_at: now }
    : {
        id: patch.id || newTaskId(),
        session: patch.session,
        pane_id: patch.pane_id,
        name: patch.name || patch.pane_id,
        cwd: patch.cwd || "",
        command: patch.command || "",
        status: patch.status || "running",
        created_at: now,
        updated_at: now,
        last_exit_code: null,
      };
  if (existing) state.tasks[state.tasks.indexOf(existing)] = task;
  else state.tasks.unshift(task);
  state.tasks = state.tasks.slice(0, 50);
  writeState(state);
  return task;
}

function updateTaskById(taskId: string, patch: Partial<ZellijTask>): ZellijTask | undefined {
  const state = readState();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return undefined;
  const updated = { ...task, ...patch, updated_at: Date.now() };
  state.tasks[state.tasks.indexOf(task)] = updated;
  writeState(state);
  return updated;
}

function writeEventCommand(taskId: string): string {
  const nodeCode = `
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = process.argv[1];
    const taskId = process.argv[2];
    const code = Number(process.argv[3] || 0);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ev = { task_id: taskId, status: code === 0 ? "exited" : "failed", exit_code: code, completed_at: Date.now() };
    const file = path.join(dir, taskId + "." + Date.now() + ".json");
    fs.writeFileSync(file, JSON.stringify(ev) + "\\n", { mode: 0o600 });
  `.replace(/\s+/g, " ");
  return `node -e ${q(nodeCode)} ${q(EVENTS_DIR)} ${q(taskId)} "$__pi_zellij_code"`;
}

function wrapCommandForEvent(command: string, taskId: string): string {
  return `__pi_zellij_emit() { __pi_zellij_code=$?; trap - EXIT; ${writeEventCommand(taskId)}; exit "$__pi_zellij_code"; }; trap __pi_zellij_emit EXIT;\n${command}`;
}

function statusIcon(status: TaskStatus): string {
  return ({ starting: "⏳", running: "▶", ready: "✅", failed: "❌", exited: "■", closed: "×", unknown: "?" } as Record<TaskStatus, string>)[status] || "?";
}

function age(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function pad(s: string, n: number): string { return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n); }

function renderTaskLines(expanded = false): string[] {
  const tasks = readState().tasks;
  const activeStatuses = new Set<TaskStatus>(["starting", "running", "ready", "unknown"]);
  const active = tasks.filter((t) => activeStatuses.has(t.status));

  if (expanded) {
    if (tasks.length === 0) return ["🧩 zellij tasks: none"];
    const rows = tasks.slice(0, 12).map((t) => `${statusIcon(t.status)} ${pad(t.status, 8)} ${pad(t.name, 24)} ${pad(`${t.session || "current"}:${t.pane_id}`, 32)} ${pad(age(t.created_at), 7)} exit:${t.last_exit_code ?? "-"}`);
    return [
      `─── 🧩 zellij tasks · ${active.length} active / ${tasks.length} tracked · alt+z collapse ───`,
      `  ${pad("status", 8)} ${pad("name", 24)} ${pad("pane", 32)} ${pad("age", 7)} exit`,
      ...rows,
    ];
  }

  if (active.length === 0) return [];
  const counts = active.reduce<Record<string, number>>((acc, t) => ((acc[t.status] = (acc[t.status] || 0) + 1), acc), {});
  const summary = `🧩 zellij ${active.length} active` + Object.entries(counts).map(([k, v]) => ` · ${k}:${v}`).join("") + " · alt+z expand";
  const recent = active.slice(0, 3).map((t) => `${statusIcon(t.status)} ${t.name} ${t.session ? `${t.session}:` : ""}${t.pane_id}`);
  return [summary, ...recent];
}

function updateWidget(ctx: any, expanded = false) {
  if (!ctx?.hasUI) return;
  const lines = renderTaskLines(expanded);
  if (!lines.length) return ctx.ui.setWidget("zellij-tasks", undefined);
  ctx.ui.setWidget("zellij-tasks", (_tui: any, theme: any) => ({
    render(width: number): string[] {
      return lines.map((line) => theme.fg("dim", line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line));
    },
    invalidate(): void {},
  }));
}

async function handleZellijEvent(pi: ExtensionAPI, ctx: any, event: ZellijEvent, file?: string): Promise<boolean> {
  const existing = readState().tasks.find((t) => t.id === event.task_id);
  const currentSessionFile = ctx?.sessionManager?.getSessionFile?.();
  const currentSessionId = ctx?.sessionManager?.getSessionId?.();
  if (existing?.caller_session_file && currentSessionFile && existing.caller_session_file !== currentSessionFile) return false;
  if (!existing?.caller_session_file && existing?.caller_session_id && currentSessionId && existing.caller_session_id !== currentSessionId) return false;

  const status: TaskStatus = event.exit_code === 0 ? "exited" : "failed";
  const task = updateTaskById(event.task_id, {
    status,
    last_exit_code: event.exit_code,
    event_emitted_at: Date.now(),
  });
  updateWidget(ctx);
  if (!task) return false;

  const text = `Background Zellij task "${task.name}" ${status} with exit code ${event.exit_code}. Pane: ${task.session || "current"}:${task.pane_id}. Inspect with zellij_snapshot if needed.`;
  if (ctx?.hasUI) ctx.ui.notify(text, event.exit_code === 0 ? "info" : "error");
  if (task.notify_agent_on_exit !== false) {
    pi.sendMessage({
      customType: "zellij-task-event",
      content: text,
      display: true,
      details: { ...task, status, exit_code: event.exit_code, event_file: file },
    }, {
      deliverAs: "followUp",
      triggerTurn: task.trigger_agent_on_exit !== false,
    });
  }
  return true;
}

function startEventWatcher(pi: ExtensionAPI, ctx: any): fs.FSWatcher | undefined {
  fs.mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o700 });
  const seen = new Set<string>();
  const processFile = (name: string) => {
    if (!name.endsWith(".json")) return;
    const file = path.join(EVENTS_DIR, name);
    if (seen.has(file)) return;
    setTimeout(async () => {
      try {
        if (seen.has(file)) return;
        const event = JSON.parse(fs.readFileSync(file, "utf8")) as ZellijEvent;
        seen.add(file);
        const handled = await handleZellijEvent(pi, ctx, event, file);
        if (handled) fs.renameSync(file, `${file}.processed`);
        else seen.delete(file);
      } catch {
        // File may still be being written, or may have been removed. Next fs event/manual refresh can retry.
      }
    }, 100);
  };
  for (const name of fs.readdirSync(EVENTS_DIR)) processFile(name);
  return fs.watch(EVENTS_DIR, (_event, filename) => filename && processFile(String(filename)));
}

function q(s: string): string {
  return JSON.stringify(s);
}

function sessionArgs(session?: string): string[] {
  return session ? ["--session", session] : [];
}

async function exec(pi: ExtensionAPI, args: string[], timeout = 30_000) {
  return pi.exec("zellij", args, { timeout });
}

function makeSubscribeCommand(session: string | undefined, paneId: string, scrollback = DEFAULT_SCROLLBACK) {
  const prefix = session ? `zellij --session ${q(session)}` : "zellij";
  return `${prefix} subscribe --pane-id ${q(paneId)} --format json --scrollback ${scrollback}`;
}

async function findPaneIdForTab(pi: ExtensionAPI, session: string | undefined, tabId: string, name: string): Promise<string | undefined> {
  for (let i = 0; i < 10; i++) {
    const result = await exec(pi, [...sessionArgs(session), "action", "list-panes", "--json", "--all"], 10_000);
    try {
      const panes = JSON.parse(result.stdout || "[]");
      const pane = panes.find((p: any) => !p.is_plugin && String(p.tab_id) === String(tabId) && !p.exited)
        || panes.find((p: any) => !p.is_plugin && p.tab_name === name && !p.exited);
      if (pane) return `terminal_${pane.id}`;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}

function looksLongRunning(command: string): boolean {
  const c = command.trim();
  return [
    /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?dev\b/i,
    /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?start\b/i,
    /\b(next|vite|astro|nuxt|storybook)\s+(dev|--host|start)\b/i,
    /\b(tsc|jest|vitest|pytest|cargo)\b.*\s(-w|--watch|watch)\b/i,
    /\btail\s+-f\b/i,
    /^watch\s+/i,
    /\b(rails\s+s|rails\s+server|python\s+-m\s+http\.server|uvicorn|gunicorn|nodemon)\b/i,
    /\b(docker\s+compose\s+up|docker-compose\s+up)\b/i,
  ].some((r) => r.test(c));
}

export default function (pi: ExtensionAPI) {
  let eventWatcher: fs.FSWatcher | undefined;
  let dashboardExpanded = false;
  const refreshWidget = (ctx: any) => updateWidget(ctx, dashboardExpanded);

  pi.registerTool({
    name: "zellij_run",
    label: "Zellij Run",
    description: "Run a long-lived or interactive command in a Zellij pane and return its pane ID. Prefer this over bash for dev servers, watchers, REPLs, tail -f, and other long-running commands.",
    parameters: RunParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const session = params.detached === false ? params.session : (params.session || DEFAULT_SESSION);
      const detached = params.detached !== false;
      const name = params.name || "pi-task";
      const direction = params.direction || "right";
      const placement = params.placement || (detached ? "tab" : "pane");
      const cwd = params.cwd || ctx.cwd;
      const taskId = newTaskId();
      const notifyAgentOnExit = params.notify_agent_on_exit !== false;
      const triggerAgentOnExit = params.trigger_agent_on_exit !== false;
      const command = wrapCommandForEvent(params.command, taskId);

      if (detached) {
        await exec(pi, ["attach", "--create-background", session, "options", "--web-sharing", "on", "--web-server", "true"], 20_000);
      }

      let result: Awaited<ReturnType<typeof exec>>;
      let paneId: string | undefined;
      let tabId: string | undefined;
      if (placement === "tab") {
        const args = [
          ...sessionArgs(session),
          "action", "new-tab",
          "-n", name,
          "--cwd", cwd,
          "--", "zsh", "-ic", command,
        ];
        result = await exec(pi, args, 30_000);
        tabId = result.stdout.trim().split(/\s+/).find((x) => /^\d+$/.test(x)) || result.stdout.trim();
        if (result.code === 0) paneId = await findPaneIdForTab(pi, session, tabId, name);
      } else {
        const args = [
          ...sessionArgs(session),
          "action", "new-pane",
          "-n", name,
          "--cwd", cwd,
        ];
        if (!detached) args.push("-d", direction);
        args.push("--", "zsh", "-ic", command);
        result = await exec(pi, args, 30_000);
        paneId = result.stdout.trim().split(/\s+/).find((x) => x.startsWith("terminal_") || x.startsWith("plugin_")) || result.stdout.trim();
      }
      if (result.code !== 0 || !paneId) {
        return { content: [{ type: "text", text: `Failed to create Zellij ${placement}:\n${result.stderr || result.stdout}` }], isError: true, details: { exitCode: result.code, tab_id: tabId } };
      }
      // The wrapped command is intentionally verbose; rename the visible pane back to the task name.
      await exec(pi, [...sessionArgs(session), "action", "rename-pane", "--pane-id", paneId, name], 10_000).catch(() => undefined);
      const task = upsertTask({ id: taskId, session, pane_id: paneId, name, cwd, command: params.command, status: "running", notify_agent_on_exit: notifyAgentOnExit, trigger_agent_on_exit: triggerAgentOnExit, caller_session_file: ctx.sessionManager?.getSessionFile?.(), caller_session_id: ctx.sessionManager?.getSessionId?.() });
      refreshWidget(ctx);
      const subscribeCommand = makeSubscribeCommand(session, paneId);
      return {
        content: [{ type: "text", text: `Started ${q(params.command)} in ${session}:${paneId}\nMonitor with:\n${subscribeCommand}` }],
        details: { task_id: task.id, session, pane_id: paneId, tab_id: tabId, placement, name, cwd, command: params.command, subscribe_command: subscribeCommand },
      };
    },
  });

  pi.registerTool({
    name: "zellij_subscribe",
    label: "Zellij Subscribe",
    description: "Collect live rendered output from a Zellij pane for a few seconds using zellij subscribe.",
    parameters: SubscribeParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const seconds = params.seconds ?? 3;
      const format = params.format || "json";
      const scrollback = params.scrollback ?? DEFAULT_SCROLLBACK;
      const shell = `${makeSubscribeCommand(params.session, params.pane_id, scrollback).replace("--format json", `--format ${format}`)} & pid=$!; sleep ${seconds}; kill $pid 2>/dev/null; wait $pid 2>/dev/null || true`;
      const result = await pi.exec("bash", ["-lc", shell], { timeout: (seconds + 5) * 1000 });
      upsertTask({ session: params.session, pane_id: params.pane_id, status: result.code === 0 ? "running" : "unknown", last_snapshot: (result.stdout || result.stderr || "").slice(-4000) });
      refreshWidget(ctx);
      return { content: [{ type: "text", text: result.stdout || result.stderr || "" }], details: { exitCode: result.code } };
    },
  });

  pi.registerTool({
    name: "zellij_wait",
    label: "Zellij Wait",
    description: "Wait until a regex appears in a Zellij pane's subscribed output; optionally fail early on another regex.",
    parameters: WaitParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const timeout = params.timeout_seconds ?? 60;
      const cmd = `zellij ${params.session ? `--session ${q(params.session)} ` : ""}subscribe --pane-id ${q(params.pane_id)} --format raw --scrollback ${DEFAULT_SCROLLBACK}`;
      const failCheck = params.fail_pattern
        ? `if grep -Eiq -- ${q(params.fail_pattern)} "$out"; then status=2; break; fi`
        : "";
      const script = `
        out=$(mktemp /tmp/pi-zellij-wait.XXXXXX)
        ${cmd} > "$out" 2>&1 & subpid=$!
        status=1
        for _ in $(seq 1 ${Math.max(1, Math.ceil(timeout * 2))}); do
          if grep -Eiq -- ${q(params.pattern)} "$out"; then status=0; break; fi
          ${failCheck}
          sleep 0.5
        done
        kill "$subpid" 2>/dev/null || true
        wait "$subpid" 2>/dev/null || true
        cat "$out"
        rm -f "$out"
        exit "$status"
      `;
      const result = await pi.exec("bash", ["-lc", script], { timeout: (timeout + 5) * 1000 });
      const ok = result.code === 0;
      const failed = result.code === 2;
      upsertTask({ session: params.session, pane_id: params.pane_id, status: ok ? "ready" : failed ? "failed" : "unknown", last_snapshot: (result.stdout || result.stderr || "").slice(-4000) });
      refreshWidget(ctx);
      return { content: [{ type: "text", text: ok ? `Matched ${params.pattern}\n${result.stdout}` : `${failed ? "Fail pattern matched" : `Did not match ${params.pattern}`} (exit ${result.code})\n${result.stdout || result.stderr}` }], isError: !ok, details: { exitCode: result.code } };
    },
  });

  pi.registerTool({
    name: "zellij_list",
    label: "Zellij List Panes",
    description: "List Zellij panes as JSON.",
    parameters: ListParams,
    async execute(_id, params) {
      const result = await exec(pi, [...sessionArgs(params.session), "action", "list-panes", "--json", "--all"], 20_000);
      return { content: [{ type: "text", text: result.stdout || result.stderr }], isError: result.code !== 0, details: { exitCode: result.code } };
    },
  });

  pi.registerTool({
    name: "zellij_snapshot",
    label: "Zellij Snapshot",
    description: "Dump the current rendered pane contents, including scrollback.",
    parameters: PaneParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await exec(pi, [...sessionArgs(params.session), "action", "dump-screen", "--pane-id", params.pane_id, "--full"], 20_000);
      upsertTask({ session: params.session, pane_id: params.pane_id, status: result.code === 0 ? "running" : "unknown", last_snapshot: (result.stdout || result.stderr || "").slice(-4000) });
      refreshWidget(ctx);
      return { content: [{ type: "text", text: result.stdout || result.stderr }], isError: result.code !== 0, details: { exitCode: result.code } };
    },
  });

  pi.registerTool({
    name: "zellij_close",
    label: "Zellij Close Pane",
    description: "Close a Zellij pane by ID.",
    parameters: PaneParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await exec(pi, [...sessionArgs(params.session), "action", "close-pane", "--pane-id", params.pane_id], 20_000);
      upsertTask({ session: params.session, pane_id: params.pane_id, status: result.code === 0 ? "closed" : "unknown" });
      refreshWidget(ctx);
      return { content: [{ type: "text", text: result.code === 0 ? `Closed ${params.pane_id}` : (result.stderr || result.stdout) }], isError: result.code !== 0, details: { exitCode: result.code } };
    },
  });

  pi.registerTool({
    name: "zellij_tasks",
    label: "Zellij Tasks",
    description: "Show Pi-tracked Zellij background tasks and their statuses.",
    parameters: TasksParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      refreshWidget(ctx);
      const state = readState();
      const lines = renderTaskLines(true);
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : "No tracked Zellij tasks." }],
        details: { state_file: STATE_FILE, tasks: state.tasks },
      };
    },
  });

  pi.registerCommand("zellij-cleanup", {
    description: "Close/clear tracked Zellij tasks. Usage: /zellij-cleanup [active|stopped|all]. Default active",
    handler: async (args, ctx) => {
      const mode = (args || "active").trim() || "active";
      const state = readState();
      const activeStatuses = new Set<TaskStatus>(["starting", "running", "ready", "unknown"]);
      const shouldClose = (t: ZellijTask) => mode === "all" ? true : mode === "active" ? activeStatuses.has(t.status) : false;
      let closed = 0;
      for (const task of state.tasks) {
        if (!shouldClose(task)) continue;
        const result = await exec(pi, [...sessionArgs(task.session), "action", "close-pane", "--pane-id", task.pane_id], 10_000);
        if (result.code === 0) {
          task.status = "closed";
          task.updated_at = Date.now();
          closed++;
        }
      }
      let kept = state.tasks;
      if (mode === "active") kept = state.tasks.filter((t) => !activeStatuses.has(t.status));
      else if (mode === "stopped") kept = state.tasks.filter((t) => activeStatuses.has(t.status));
      else if (mode === "all") kept = [];
      writeState({ version: 1, tasks: kept });
      refreshWidget(ctx);
      ctx.ui.notify(`zellij cleanup ${mode}: closed ${closed}, cleared ${state.tasks.length - kept.length}, tracking ${kept.length}`, "info");
    },
  });

  pi.registerCommand("zellij-dashboard", {
    description: "Toggle or control the Zellij task dashboard. Usage: /zellij-dashboard [toggle|expand|collapse]",
    handler: async (args, ctx) => {
      const action = (args || "toggle").trim();
      if (action === "expand") dashboardExpanded = true;
      else if (action === "collapse") dashboardExpanded = false;
      else dashboardExpanded = !dashboardExpanded;
      refreshWidget(ctx);
      ctx.ui.notify(`zellij dashboard ${dashboardExpanded ? "expanded" : "collapsed"}`, "info");
    },
  });

  pi.registerShortcut("alt+z", {
    description: "Toggle Zellij task dashboard",
    handler: async (ctx) => {
      dashboardExpanded = !dashboardExpanded;
      refreshWidget(ctx);
      ctx.ui.notify(`zellij dashboard ${dashboardExpanded ? "expanded" : "collapsed"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    eventWatcher?.close();
    eventWatcher = startEventWatcher(pi, ctx);
    refreshWidget(ctx);
  });
  pi.on("session_shutdown", async () => {
    eventWatcher?.close();
    eventWatcher = undefined;
  });
  pi.on("before_agent_start", async (_event, ctx) => refreshWidget(ctx));

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = String((event.input as any).command || "");
    if (looksLongRunning(command)) {
      return {
        block: true,
        reason: `This looks long-running. Use zellij_run instead so Pi can monitor it with zellij_subscribe. Command: ${command}`,
      };
    }
  });
}
