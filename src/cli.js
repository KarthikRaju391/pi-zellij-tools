#!/usr/bin/env node
import { resolve } from "node:path";
import { Store, defaultStateDir } from "./store.js";
import { WorkerAdapter } from "./worker.js";
import { GitEffects } from "./effects.js";
import { Controller } from "./controller.js";

const [command, ...args] = process.argv.slice(2);
const take = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const stateDir = take("--state-dir") ?? defaultStateDir();
const store = new Store(stateDir);
const usage = () => console.error("pi-orch run <investigate-report|read-only-verify|fix-to-pr> [--authorize-edits] [--cwd DIR]\npi-orch status <run-id> | resume <run-id> | cancel <run-id> | approve <run-id>");

if (!command) { usage(); process.exitCode = 2; }
else if (command === "status") { console.log(JSON.stringify(await store.load(args[0]), null, 2)); }
else if (["resume", "cancel", "approve"].includes(command)) {
  const ctl = new Controller({ store, workers: new WorkerAdapter({ stateDir }), effects: new GitEffects({ cwd: process.cwd() }) });
  await ctl.resume(args[0]);
  if (command === "cancel") await ctl.cancel("CLI cancel");
  if (command === "approve") await ctl.approve();
  if (command === "resume" || command === "approve") await ctl.pump();
  console.log(JSON.stringify(ctl.run, null, 2)); await ctl.close();
} else if (command === "run") {
  const name = args.shift(); const cwd = resolve(take("--cwd") ?? process.cwd());
  const authorized = args.includes("--authorize-edits");
  const ctl = new Controller({ store, workers: new WorkerAdapter({ stateDir }), effects: new GitEffects({ cwd }) });
  await ctl.start({ workflow: name, cwd, authorized }); await ctl.pump();
  console.log(JSON.stringify(ctl.run, null, 2));
  // Foreground workers keep the event loop alive; their reports continue the durable plan.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await ctl.cancel(signal); await ctl.close(); process.exit(130); });
} else { usage(); process.exitCode = 2; }
