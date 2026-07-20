# pi-zellij-tools

Pi package for running and tracking long-lived Zellij background tasks.

Includes:

- `zellij_run`, `zellij_subscribe`, `zellij_wait`, `zellij_list`, `zellij_snapshot`, `zellij_close`, `zellij_tasks`
- Persistent task state in `~/.pi/agent/state/zellij-tasks.json`
- Completion events via `customType: "zellij-task-event"`
- Auto-triggered agent continuation when background tasks exit
- Collapsed/expanded Zellij task dashboard (`alt+z` or `/zellij-dashboard`)
- Cleanup command (`/zellij-cleanup active|stopped|all`)
- Zellij skill instructions for Pi

## Install

```bash
pi install git:github.com/KarthikRaju391/pi-zellij-tools
```

Or try without installing:

```bash
pi -e git:github.com/KarthikRaju391/pi-zellij-tools
```

Then restart Pi or run `/reload`.

### Agent-memory monitor

Install the trusted canonical extension with a symlink or copy at `~/.pi/agent/extensions/agent-memory-monitor.ts`, then run `/reload`.

```text
/agent-memory-monitor on|off|status|scan
```

## Usage

```ts
zellij_run({
  command: "npm run dev",
  name: "dev-server"
})
```

Detached tasks open in their own Zellij tab by default. When a command exits, Pi receives a `zellij-task-event` and the agent can continue automatically.

Dashboard:

```text
/zellij-dashboard toggle
/zellij-dashboard expand
/zellij-dashboard collapse
```

Cleanup:

```text
/zellij-cleanup active
/zellij-cleanup stopped
/zellij-cleanup all
```
