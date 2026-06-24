## Runtime data (`~/.c3`)

All runtime state is anchored under the c3 home dir (default `~/.c3`, overridable via `--settings` / `C3_DIR`):

- `settings.json` / `state.json` — config + workspace registry
- `c3.db` — single SQLite (intents, discussions, …)
- `worktrees/` — intent worktrees (HOME-anchored so Docker can bind-mount)
- `doc/` — centralized doc per project dir
- `log/` — runtime logs: live file `c3.log` (console output teed to disk); rotated daily into `c3-YYYY-MM-DD.log`; archives older than 30 days are pruned. Best-effort — log failures never crash the process. No size rotation, no retention config, no remote shipping (主进程自身输出, 不含子进程/沙箱/vendor CLI)。
