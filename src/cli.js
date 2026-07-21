#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Store, defaultStateDir } from "./store.js";
import { WorkerAdapter } from "./worker.js";
import { Controller } from "./controller.js";

const [command, ...args] = process.argv.slice(2); const take = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const stateDir = take("--state-dir") ?? defaultStateDir(); const store = new Store(stateDir);
const usage = () => console.error("pi-orch run <workflow> --spec task.json [--state-dir DIR]\npi-orch status|resume|cancel <run-id> | pi-orch reconcile <run-id> <target> <abandon|confirmed-applied|confirmed-not-applied>");
if (!command) { usage(); process.exitCode = 2; }
else if (command === "status") console.log(JSON.stringify(await store.load(args[0]), null, 2));
else if (command === "run") { const name = args.shift(); const specFile = take("--spec"); if (!specFile) throw new Error("run requires --spec"); const spec = JSON.parse(await readFile(specFile, "utf8")); const ctl = new Controller({ store, workers: new WorkerAdapter({ stateDir }) }); await ctl.start({ workflow: name, spec }); await ctl.pump(); console.log(JSON.stringify(ctl.run, null, 2)); }
else if (["resume", "cancel", "reconcile"].includes(command)) { const id = args.shift(); const ctl = new Controller({ store, workers: new WorkerAdapter({ stateDir }) }); await ctl.resume(id); if (command === "cancel") await ctl.cancel("CLI cancel"); if (command === "reconcile") await ctl.reconcile(args.shift(), args.shift()); if (command === "resume") await ctl.pump(); console.log(JSON.stringify(ctl.run, null, 2)); if (["done", "cancelled", "waiting-human", "failed"].includes(ctl.run.status)) await ctl.close(); }
else { usage(); process.exitCode = 2; }
