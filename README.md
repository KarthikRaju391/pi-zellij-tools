# pi-zellij-tools

Pi package for running and tracking long-lived Zellij background tasks, plus a small durable control plane for new Pi runs.

Includes:

- `zellij_run`, `zellij_subscribe`, `zellij_wait`, `zellij_list`, `zellij_snapshot`, `zellij_close`, `zellij_tasks`
- Persistent task state in `~/.pi/agent/state/zellij-tasks.json`
- Completion events, dashboard, cleanup commands, and Zellij skill instructions
- `pi-orch`: append-only, controller-owned Pi orchestration

## Install

```bash
pi install git:github.com/KarthikRaju391/pi-zellij-tools
```

Or try without installing:

```bash
pi -e git:github.com/KarthikRaju391/pi-zellij-tools
```

Then restart Pi or run `/reload`.

## Zellij usage

```ts
zellij_run({ command: "npm run dev", name: "dev-server" })
```

Dashboard: `/zellij-dashboard toggle|expand|collapse`. Cleanup: `/zellij-cleanup active|stopped|all`.

## Orchestration

```sh
pi-orch run investigate-report
pi-orch run fix-to-pr --authorize-edits --cwd /repo
pi-orch status <run-id>
pi-orch resume <run-id>
pi-orch cancel <run-id>
pi-orch approve <run-id>
```

State is append-only JSONL plus an atomic snapshot in `~/.pi/orchestrator` (override with `--state-dir` or `PI_ORCH_STATE_DIR`). One controller lease and fenced generation/lease event IDs prevent stale controllers from changing a run. The controller only owns runs it creates.

Workers are `pi-pool --mode rpc` processes, not panes or transcripts. They load only `extensions/orchestrator-worker.ts`, communicate with strict LF JSONL, and must finish through its terminating `orchestrator_report` tool. Zellij is not part of control flow.

Trusted workflows are code-only: `investigate-report`, `read-only-verify`, and `fix-to-pr`. The latter needs `--authorize-edits`, permits one writer, has the controller commit the clean task worktree, rechecks after rebase, requires an exact-HEAD independent reviewer, opens then reads back an unmerged PR, and never merges. Git/PR actions use fixed executable/argv operations; merge, deploy, production, data, migration, messaging, and arbitrary shell effects do not exist in the effect API. CI remains `pending` until observed separately.
