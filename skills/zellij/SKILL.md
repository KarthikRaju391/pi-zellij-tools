---
name: zellij
description: Instructions for using Zellij to spawn multiple processes, inspect them, and capture their output. Useful for running servers or long-running tasks in the background.
allowed-tools:
  - Bash
---

# Zellij Skill

This skill is the policy map for Pi's Zellij tools. Prefer the custom Pi tools (`zellij_run`, `zellij_subscribe`, `zellij_wait`, `zellij_list`, `zellij_snapshot`, `zellij_close`, `zellij_tasks`) when available. Fall back to raw `zellij` shell commands only if the tools are unavailable or you need an unsupported option.

Use Zellij for multiple concurrent processes (servers, watchers, REPLs, long builds) without blocking the main communication channel.

## 1. Verify Environment & Check Status

First, verify Zellij is available and recent enough for pane subscriptions:

```bash
zellij --version
zellij subscribe --help >/dev/null
zellij action list-panes --help >/dev/null
```

Inside an attached Zellij client, `echo $ZELLIJ` returns a value (usually `0`). Most session-scoped commands also work from outside an attached client when you pass `--session <NAME>`.

## 2. Shell Environment

**Important:** `zellij action new-pane` / `zellij run` do NOT start a login/interactive shell, so `~/.zshrc` (plugins, mise, PATH additions, aliases) won't be loaded by default. **Always wrap commands through `zsh -ic`** so that the full user environment (mise shims, zoxide, zsh plugins, custom PATH, etc.) is available in the new pane.

## 3. Tool-First Policy

Use `zellij_run` instead of `bash` for long-running commands:

- dev servers: `npm run dev`, `pnpm dev`, `next dev`, `vite`, `rails s`
- watchers: `tsc -w`, `cargo watch`, `npm test -- --watch`, `vitest --watch`
- REPLs and interactive CLIs
- log streams: `tail -f`, `docker compose logs -f`
- local services: Storybook, DB consoles, browser-test servers
- anything likely to keep running or needing live observation

Use normal `bash` for short, one-shot commands: `ls`, `rg`, `find`, `git status`, non-watch tests, formatters, short builds, and file operations.

Typical tool flow:

1. `zellij_run` starts the command and returns `session` + `pane_id`. By default detached tasks open in their own tab; use `placement: "pane"` only when a split is desired.
2. `zellij_subscribe` streams recent output.
3. `zellij_wait` waits for readiness/failure patterns.
4. `zellij_snapshot` captures final screen state if needed.
5. `zellij_close` stops the pane when done.

## 3.5 Task State & Toolbar

The custom Zellij extension tracks panes launched by `zellij_run` in `~/.pi/agent/state/zellij-tasks.json` and shows a compact `zellij-tasks` widget in the Pi UI. Use `zellij_tasks` when you need to answer “what background work is already running?” before starting a duplicate server/watcher.

Status updates happen when tools are used:

- `zellij_run` records a new running task
- `zellij_wait` marks it `ready`, `failed`, or `unknown`
- `zellij_subscribe` / `zellij_snapshot` refresh the last observed output
- `zellij_close` marks it `closed`

Prefer checking `zellij_tasks` before spawning long-running work if there may already be related panes.

Default layout policy: open background observer tasks as tabs (`placement: "tab"`) so each task has a visible full pane. Use pane splits only for tightly related subtasks, and keep at most two panes per tab.

The collapsed widget and expanded dashboard are session-scoped by default. Use `/zellij-dashboard all` to show all sessions, `/zellij-dashboard session` to return to current-session view, or `/zellij-dashboard scope` to toggle scope. The collapsed widget only shows active/actionable tasks. Use `/zellij-dashboard toggle` or `alt+z` to expand/collapse the full task-history table. Use `/zellij-cleanup active` to close active tracked panes and remove them from the dashboard, `/zellij-cleanup stopped` to clear stopped history, or `/zellij-cleanup all` to close tracked panes and clear all history.

### Automatic completion events

`zellij_run` wraps commands so that when the pane command exits, it writes a completion event under `~/.pi/agent/state/zellij-events/`. The extension watches that directory, updates task state, refreshes the widget, and injects a custom Pi message with `customType: "zellij-task-event"`. By default, completion events use `triggerTurn: true`, so the agent can continue automatically when a background task finishes or fails instead of waiting for the user to mention it.

Use `notify_agent_on_exit: false` or `trigger_agent_on_exit: false` only when the task is intentionally noisy or irrelevant to the current agent flow.

## 4. Choose the Right Raw Zellij Mode

### Mode A: Non-Interactive (background processes, builds, servers)

Use when the command does NOT need user input. Prefer `zellij action new-pane` over `zellij run` because it returns the created pane ID, which lets you monitor the pane with `zellij subscribe`.

```bash
PANE_ID=$(zellij action new-pane -d right -n "server-log" -- zsh -ic 'npm start')
zellij action focus-previous-pane
zellij subscribe --pane-id "$PANE_ID" --format json --scrollback 100
```

For detached/background sessions:

```bash
PANE_ID=$(zellij --session agent-observer action new-pane -d right -n "server-log" -- zsh -ic 'npm start')
zellij --session agent-observer subscribe --pane-id "$PANE_ID" --format json --scrollback 100
```

Use `tee` only when you also need a durable file artifact. `subscribe` is the default way to monitor pane output.

### Mode B: Interactive (passwords, confirmations, prompts)

Use when the command needs user input (e.g., `sudo`, `ssh`, `git push` with credentials, deploy scripts). Runs the command with a proper TTY so the user can type passwords and respond to prompts in the Zellij pane.

```bash
zellij run -d right -n "deploy" -- zsh -ic "npm run deploy"
```

On macOS, use `script` to log output while preserving interactivity:

```bash
zellij run -d right -n "deploy" -- zsh -ic 'script -q /tmp/zellij-deploy.txt npm run deploy'
```

On Linux:

```bash
zellij run -d right -n "deploy" -- zsh -ic 'script -q -c "npm run deploy" /tmp/zellij-deploy.txt'
```

After spawning an interactive pane, **tell the user to switch to that pane** to enter their password or respond to prompts.

### Special use case: background Pi testing in a separate Zellij session

For **interactive Pi testing**, do **not** use `pi -p` as a substitute for opening Pi in a pane.
`pi -p` runs non-interactively and exits, so it does not leave behind a live Pi TUI session for follow-up manual testing.

Also, for routine background testing, **do not run Pi in the user's active Zellij session**. That interferes with their focus/cursor placement and makes them babysit the test tab.

**Preferred pattern:** create a **separate detached Zellij session** for agent testing, then target all actions at that session.

#### Create a detached observer session

```bash
zellij attach -b agent-observer >/tmp/zellij-agent-observer-create.txt 2>&1 &
sleep 1
```

#### Open a dedicated Pi tab inside that session

```bash
zellij --session agent-observer action new-tab -n "pi-local" -c /path/to/repo
```

#### Preferred for pure-observer automated tests: run Pi under `expect` in that session

Detached sessions are great for isolation, but interactive follow-up input can still be awkward without an attached client. For repeatable command testing, prefer running Pi under `expect` and logging the transcript.

```bash
cat >/tmp/pi-test.exp <<'EOF'
#!/usr/bin/expect -f
set timeout 120
log_user 1
set env(OLIV_ENVIRONMENT) local
cd /path/to/repo
spawn pi
expect -re {Loaded Oliv operator extension}
send "/oliv-login my@oliv.ai\r"
expect -re {Logged in as}
send "/agent-updates\r"
expect {
  -re {Pending agent updates:}
  -re {No pending agent updates for scope}
}
after 1500
send "\003"
expect eof
EOF
chmod +x /tmp/pi-test.exp
PANE_ID=$(zellij --session agent-observer action new-pane -n "pi-test" -- zsh -ic '/tmp/pi-test.exp')
zellij --session agent-observer subscribe --pane-id "$PANE_ID" --format json --scrollback 100
```

#### Observe output without interrupting the user

Prefer live pane subscription:

```bash
zellij --session agent-observer subscribe --pane-id "$PANE_ID" --format json --scrollback 100
```

For a one-shot snapshot:

```bash
zellij --session agent-observer action dump-screen --pane-id "$PANE_ID" --full --path /tmp/zellij-pi-screen.txt
```

Notes:
- `zellij --session <NAME> action new-pane ...` launches work in the detached observer session and returns a pane ID
- this keeps the user's active session untouched
- `expect` is preferred when the commands are known ahead of time and you want a deterministic transcript
- use `script` or `tee` only when you need a durable file transcript in addition to `subscribe`

Use this pattern when you want:
- repeatable background Pi tests
- zero interference with the user's current tabs and cursor
- a transcript you can inspect afterward

### Fallback only: sending commands to an already-running Pi pane in the current session

Only use same-session Pi injection if the user explicitly wants testing to happen in their current Zellij session.

Useful actions:

```bash
zellij action dump-layout
zellij action list-panes --json
zellij action go-to-tab-name "Tab #6"
zellij action focus-next-pane
zellij action write-chars --pane-id terminal_1 "/agent-updates"
zellij action write --pane-id terminal_1 13
zellij subscribe --pane-id terminal_1 --format json --scrollback 100
zellij action dump-screen --pane-id terminal_1 --full --path /tmp/zellij-pi-screen.txt
```

Notes:
- same-session actions are focus-sensitive
- the user's own tab/pane changes can interfere with targeting
- avoid this mode for routine background tests

**Keeping focus on the current pane:**

Opening a pane switches focus to it by default. **Always use `-d right`** so the new pane opens as a vertical split beside the current one (both remain visible), then **run `zellij action focus-previous-pane` immediately after** to return the cursor to the original pane:

```bash
PANE_ID=$(zellij action new-pane -d right -n "server-log" -- zsh -ic 'npm start')
zellij action focus-previous-pane
zellij subscribe --pane-id "$PANE_ID" --format json --scrollback 100
```

The pane creation and focus restoration must be ordered; do not run them concurrently.

**Options (both modes):**

- `-c` — auto-close the pane when the command exits. **Omit by default** so the user can always inspect the final output, exit code, and errors. Only use `-c` for fire-and-forget tasks where the user does not need to see the result
- `-d right` — **always include this** — open as a vertical split so both panes stay visible
- `-n "NAME"` — give the pane a name (shown in the UI)
- `-f` — open as a floating overlay instead of a split (use sparingly)
- `-s` — start the command suspended (waits for Enter before running)

## 5. Inspect Output (Subscribe to Pane Output)

Always prefer `zellij subscribe` for monitoring pane output. It streams the rendered viewport immediately and then emits updates whenever the pane changes. Use JSON for machine-readable monitoring.

**Live monitor one pane:**

```bash
zellij subscribe --pane-id "$PANE_ID" --format json --scrollback 100
```

**Monitor a pane in another session:**

```bash
zellij --session agent-observer subscribe --pane-id "$PANE_ID" --format json --scrollback 100
```

**Filter for errors:**

```bash
zellij subscribe --pane-id "$PANE_ID" --format json \
  | jq --unbuffered 'select(.event == "pane_update") | .viewport[] | select(test("ERROR|WARN|FAIL"; "i"))'
```

**Raw stream:**

```bash
zellij subscribe --pane-id "$PANE_ID" --scrollback 100
```

**One-shot snapshot / fallback:**

```bash
zellij action dump-screen --pane-id "$PANE_ID" --full --path /tmp/zellij-pane.txt
```

Use `tee`, `script`, and `tail` only when a durable log file is explicitly useful; `subscribe` should be the default observation mechanism.

## 6. Wait for Completion

Prefer pane metadata or `subscribe` closure over `pgrep`:

```bash
zellij action list-panes --json | jq '.[] | {id, title, exited, exit_status}'
```

For commands launched directly in panes, use blocking flags when you need synchronization:

```bash
zellij action new-pane --block-until-exit-success -n "tests" -- zsh -ic 'npm test'
```

Or keep a subscription open; it exits when all subscribed panes close.

## 7. Stop the Process & Clean Up

Prefer closing the pane by ID:

```bash
zellij action close-pane --pane-id "$PANE_ID"
```

For a detached session:

```bash
zellij --session agent-observer action close-pane --pane-id "$PANE_ID"
```

Use `pkill -f "CMD"` only when you intentionally want to kill all matching processes. Clean up durable log files only if you created them with `tee` or `script`.

## Summary

| Scenario | Pattern |
|----------|---------|
| Background | `PANE_ID=$(zellij action new-pane -d right -n "ID" -- zsh -ic 'CMD')` → `zellij subscribe --pane-id "$PANE_ID" --format json --scrollback 100` |
| Detached background | `PANE_ID=$(zellij --session agent-observer action new-pane -n "ID" -- zsh -ic 'CMD')` → `zellij --session agent-observer subscribe --pane-id "$PANE_ID" --format json` |
| Interactive (macOS + durable log) | `PANE_ID=$(zellij action new-pane -d right -n "ID" -- zsh -ic 'script -q /tmp/zellij-ID.txt CMD')` |
| Interactive (Linux + durable log) | `PANE_ID=$(zellij action new-pane -d right -n "ID" -- zsh -ic 'script -q -c "CMD" /tmp/zellij-ID.txt')` |
| Interactive (no log) | `PANE_ID=$(zellij action new-pane -d right -n "ID" -- zsh -ic "CMD")` |
| Preferred Pi background test | `zellij attach -b agent-observer` → `zellij --session agent-observer action new-pane ...` → `subscribe` |
| List panes | `zellij [--session NAME] action list-panes --json` |
| Send command to pane | `zellij [--session NAME] action write-chars --pane-id "$PANE_ID" "/command"` → `zellij [--session NAME] action write --pane-id "$PANE_ID" 13` |
| Same-session Pi injection (fallback) | `zellij action go-to-tab-name "TAB"` → identify pane with `list-panes --json` → write to `--pane-id` |
| Return focus | `zellij action focus-previous-pane` (run immediately after spawn) |
| Inspect | `zellij [--session NAME] subscribe --pane-id "$PANE_ID" --format json --scrollback 100` or `dump-screen --pane-id "$PANE_ID" --full` |
| Stop + auto-close | `zellij action close-pane --pane-id "$PANE_ID"` |
