import { spawn } from "node:child_process";

const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "-e", "extensions/orchestrator-worker.ts", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "read,grep,find,ls,orchestrator_report"], { stdio: ["pipe", "pipe", "pipe"], shell: false });
let buffer = ""; const done = (error) => { child.kill("SIGTERM"); if (error) { console.error(error); process.exitCode = 1; } };
child.stdout.on("data", (chunk) => { buffer += chunk; const i = buffer.indexOf("\n"); if (i < 0) return; try { const response = JSON.parse(buffer.slice(0, i)); if (response.type !== "response" || !response.success) throw new Error("worker extension did not load"); done(); } catch (error) { done(error); } });
child.on("error", done); child.stdin.end('{"id":"check","type":"get_state"}\n');
setTimeout(() => done(new Error("worker extension check timed out")), 15000).unref();
