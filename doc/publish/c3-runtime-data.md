## 运行时数据(`~/.c3`)

所有运行时状态都锚定在 c3 主目录下(默认 `~/.c3`,可通过 `--settings` / `C3_DIR` 覆盖):

- `settings.json` / `state.json` — 配置 + 工作区注册表
- `c3.db` — 单一 SQLite(intents、discussions……)
- `worktrees/` — intent worktree(锚定在 HOME 下,统一放置便于沙箱同路径放行)
- `doc/` — 按项目目录集中存放的文档
- `log/` — 运行时日志:实时文件 `c3.log`(控制台输出同时写入磁盘);每日轮转为 `c3-YYYY-MM-DD.log`;超过 30 天的归档会被清理。尽力而为 —— 日志失败不会导致进程崩溃。无大小轮转、无保留配置、无远程上报(主进程自身输出, 不含子进程/沙箱/vendor CLI)。
