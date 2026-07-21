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
pi-orch run fix-to-pr --spec task.json
pi-orch status <run-id>
pi-orch resume <run-id>
pi-orch cancel <run-id>
pi-orch reconcile <run-id> <target> <decision>
```

For `fix-to-pr`, `task.json` supplies a stable task key, dedicated clean worktree, scoped paths, base/remote/branch, instructions capped at 8,000 characters, a non-empty check manifest, and explicit edit/PR authorization. Read-only workflows require only task identity, objective, and cwd. State is append-only JSONL plus an atomic snapshot in `~/.pi/orchestrator` (override with `--state-dir` or `PI_ORCH_STATE_DIR`).

Workers are `pi-pool --mode rpc` processes, not panes or transcripts. They load only `extensions/orchestrator-worker.ts`, communicate with strict LF JSONL, and must finish through its terminating `orchestrator_report` tool. Zellij is not part of control flow.

Trusted workflows are code-only: `investigate-report`, `read-only-verify`, and `fix-to-pr`. The latter permits one writer, has the controller stage only spec-scoped paths, rechecks after rebase, requires exact-HEAD reviewer approval with bounded feedback loops, reconciles existing PRs before creation, opens then reads back an unmerged PR, and never merges. Git/PR actions use fixed executable/argv operations; merge, deploy, production, data, migration, messaging, and arbitrary shell effects do not exist in the effect API. CI remains `pending` until observed separately.
