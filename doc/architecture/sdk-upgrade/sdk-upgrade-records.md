# SDK 升级记录索引

c3 驱动多个 agent vendor，各自依赖一个 SDK（见
[`../agent-sdk.md`](../agent-sdk.md) 的「SDK 升级纪律」：至少每两周检查、读 changelog、串行升级、
commit 写明、适配器同步）。每次升级的逐项 changelog 评估（接入/不接入 + 依据 + 留痕去向）
独立成一份按日期命名的记录，存放于本目录：

```
doc/architecture/sdk-upgrade/yyyy-mm-dd-<sdk>-upgrade-to-v<version>.md
```

## 记录

| 日期       | SDK                              | 版本                  | 记录                                                                                                     |
| ---------- | -------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| 2026-07-06 | `@openai/codex-sdk`              | `0.142.3 → 0.142.5`   | [2026-07-06-codex-sdk-upgrade-to-v0.142.5.md](2026-07-06-codex-sdk-upgrade-to-v0.142.5.md)               |
| 2026-07-06 | `@anthropic-ai/claude-agent-sdk` | `^0.3.195 → ^0.3.201` | [2026-07-06-claude-agent-sdk-upgrade-to-v0.3.201.md](2026-07-06-claude-agent-sdk-upgrade-to-v0.3.201.md) |
| 2026-07-17 | `@anthropic-ai/claude-agent-sdk` | `^0.3.201 → ^0.3.207` | [2026-07-17-claude-agent-sdk-upgrade-to-v0.3.207.md](2026-07-17-claude-agent-sdk-upgrade-to-v0.3.207.md) |
| 2026-07-17 | `@openai/codex-sdk`              | `0.142.5 → 0.144.1`   | [2026-07-17-codex-sdk-upgrade-to-v0.144.1.md](2026-07-17-codex-sdk-upgrade-to-v0.144.1.md)               |
| 2026-07-21 | `@anthropic-ai/claude-agent-sdk` | `^0.3.207 → ^0.3.215` | [2026-07-21-claude-agent-sdk-upgrade-to-v0.3.215.md](2026-07-21-claude-agent-sdk-upgrade-to-v0.3.215.md) |
| 2026-07-21 | `@openai/codex-sdk`              | `0.144.1 → 0.144.6`   | [2026-07-21-codex-sdk-upgrade-to-v0.144.6.md](2026-07-21-codex-sdk-upgrade-to-v0.144.6.md)               |
| 2026-07-24 | `@anthropic-ai/claude-agent-sdk` | `^0.3.215 → ^0.3.218` | [2026-07-24-claude-agent-sdk-upgrade-to-v0.3.218.md](2026-07-24-claude-agent-sdk-upgrade-to-v0.3.218.md) |
| 2026-07-24 | `@openai/codex-sdk`              | `0.144.6 → 0.145.0`   | [2026-07-24-codex-sdk-upgrade-to-v0.145.0.md](2026-07-24-codex-sdk-upgrade-to-v0.145.0.md)               |
| 2026-06-29 | `@openai/codex-sdk`              | `0.141.0 → 0.142.3`   | [2026-06-29-codex-sdk-upgrade-to-v0.142.3.md](2026-06-29-codex-sdk-upgrade-to-v0.142.3.md)               |
| 2026-06-28 | `@anthropic-ai/claude-agent-sdk` | `^0.3.183 → ^0.3.195` | [2026-06-28-claude-agent-sdk-upgrade-to-v0.3.195.md](2026-06-28-claude-agent-sdk-upgrade-to-v0.3.195.md) |
