#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Controller } from "./controller.js";
import { Store, defaultStateDir } from "./store.js";
import { WorkerAdapter } from "./worker.js";

const terminal = new Set(["done", "cancelled", "waiting-human", "failed"]);
const usage = "pi-orch run <workflow> --spec task.json [--state-dir DIR]\npi-orch status|resume|cancel|approve <run-id> | pi-orch reconcile <run-id> <target> <abandon|confirmed-applied|confirmed-not-applied>";

export async function main(argv = process.argv.slice(2), { storeFactory = (dir) => new Store(dir), workersFactory = (dir) => new WorkerAdapter({ stateDir: dir }), controllerFactory = (options) => new Controller(options), write = console.log, writeError = console.error } = {}) {
  const args = [...argv]; const command = args.shift();
  const take = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args.splice(index, 2)[1]; };
  const stateDir = take("--state-dir") ?? defaultStateDir(); const store = storeFactory(stateDir);
  const controller = () => controllerFactory({ store, workers: workersFactory(stateDir) });
  if (!command) { writeError(usage); return 2; }
  if (command === "status") { write(JSON.stringify(await store.load(args[0]), null, 2)); return 0; }
  if (command === "run") {
    const name = args.shift(); const specFile = take("--spec"); if (!specFile) throw new Error("run requires --spec");
    const ctl = controller(); const spec = JSON.parse(await readFile(specFile, "utf8")); await ctl.start({ workflow: name, spec }); ctl.installSignalHandlers(); await ctl.pump(); write(JSON.stringify(ctl.run, null, 2)); if (terminal.has(ctl.run.status)) await ctl.close(); return 0;
  }
  if (command === "cancel") { const ctl = controller(); write(JSON.stringify(await ctl.requestCancellation(args[0], "CLI cancel"), null, 2)); return 0; }
  if (["resume", "approve", "reconcile"].includes(command)) {
    const id = args.shift(); const ctl = controller();
    try {
      await ctl.resume(id, { recover: command !== "approve" });
      if (command === "approve") await ctl.approve();
      if (command === "reconcile") await ctl.reconcile(args.shift(), args.shift());
      if (["resume", "approve"].includes(command) && ctl.run.status === "running") await ctl.pump();
      write(JSON.stringify(ctl.run, null, 2)); if (terminal.has(ctl.run.status)) await ctl.close(); return 0;
    } catch (error) { await ctl.close(); throw error; }
  }
  writeError(usage); return 2;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 1; });
}
