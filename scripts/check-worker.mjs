import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const sessionDir = await mkdtemp(`${tmpdir()}/pi-orch-worker-`); const scope = Buffer.from(JSON.stringify({ roots: [process.cwd()], paths: ["src"] })).toString("base64url");
const child = spawn("pi-pool", ["--mode", "rpc", "--model", "openai-codex/gpt-5.6-terra", "--thinking", "medium", "--session-dir", sessionDir, "--no-extensions", "-e", resolve("extensions/orchestrator-worker.ts"), "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "read,grep,find,ls,orchestrator_report"], { stdio: ["pipe", "pipe", "pipe"], shell: false });
let buffer = ""; let bound = false; let settled = false;
const fail = (error) => { child.kill("SIGTERM"); console.error(error); process.exitCode = 1; };
const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
child.stdout.on("data", (chunk) => { buffer += chunk; for (;;) { const i = buffer.indexOf("\n"); if (i < 0) return; const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const event = JSON.parse(line); if (event.id === "bind") { if (!event.success) throw new Error("worker bind failed"); bound = true; send({ id: "report", type: "prompt", message: "Call orchestrator_report with outcome ok and summary handshake. Do not use any other tool or prose." }); } if (event.type === "tool_execution_end" && event.toolName === "orchestrator_report" && !event.isError) { const d = event.result?.details; if (!bound || d?.node !== "handshake" || d?.role !== "verifier") throw new Error("invalid structured worker report"); settled = true; child.kill("SIGTERM"); } } catch (error) { fail(error); } } });
child.stderr.on("data", (chunk) => process.stderr.write(chunk)); child.on("error", fail); child.on("exit", (code) => { if (!settled && code !== null) fail(new Error("worker handshake exited before report")); });
send({ id: "bind", type: "prompt", message: `/orchestrator-bind handshake 1 abcdefgh verifier ${scope}` });
setTimeout(() => { if (!settled) fail(new Error("worker bind/report handshake timed out")); }, 120000).unref();
