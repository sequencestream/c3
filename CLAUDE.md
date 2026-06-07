# CLAUDE.md

## What this is

`c3` (Claude Code Center) is a local web UI for Claude Code: tool-use permission prompts are answered in a browser instead of the terminal.

## Commands

```bash
pnpm install                                   # bootstrap
pnpm dev                                        # server :3000 + Vite :5173 — open :5173
pnpm build                                      # web THEN server (order matters)
pnpm start [--project /abs/path] [--port 3000] # start is default cmd; --project defaults to cwd, --port to 3000
pnpm typecheck                                  # vue-tsc --noEmit across packages
pnpm lint                                        # eslint . (add --fix via pnpm lint:fix)
pnpm format                                      # prettier --write . (--check via format:check)
pnpm pkg                                         # build + single binaries in dist/
```

## SDK Dependencies

c3 驱动三种 agent vendor，通过各自不同的 SDK，每个 SDK 包装一个宿主 CLI 二进制：

| Vendor   | SDK 包                           | 宿主 CLI   | GitHub 仓库                                                                                         |
| -------- | -------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| Claude   | `@anthropic-ai/claude-agent-sdk` | `claude`   | [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) |
| Codex    | `@openai/codex-sdk`              | `codex`    | [openai/codex](https://github.com/openai/codex)                                                     |
| OpenCode | `@opencode-ai/sdk`               | `opencode` | [opencode-ai/sdk](https://github.com/opencode-ai/sdk)                                               |

三个 SDK 的架构差异很大（子进程包装 vs 远程服务），见 `specs/architecture/architecture.md` 的 architecture 与
`specs/architecture/adr/0011-vendor-neutral-agent-abstraction.md`。

### SDK 升级纪律

- **定期检查**：每个 SDK **至少每两周**检查一次新版发布。
- **阅读 CHANGELOG**：升级前必须阅读对应 SDK 的 changelog/release notes，评估 breaking change、
  新能力（如新 capability flag、protocol 变更）和废弃特性。
- **串行升级**：一次升一个 SDK，`pnpm typecheck && pnpm lint && pnpm vitest run` 全绿后再升下一个。
- **提交说明**：commit message 中写明升级了什么、涵盖了哪些关键更新。
- **适配器同步**：如果 SDK 变更影响 adapter 层（`server/src/kernel/agent/adapters/`），一并更新，
  并在 `specs/architecture/adr/0011-vendor-neutral-agent-abstraction.md` 的 capability ledger 中反映。

各 SDK changelog 地址：

- Claude Agent SDK — <https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md>
- Codex SDK — <https://github.com/openai/codex/releases>
- OpenCode SDK — <https://github.com/opencode-ai/sdk/releases>

## Index

- server: Hono server
- web: Vue 3 frontend
- shared: protocol definitions, common code
- scripts/e2e/e2e-guide.md: E2E tests, make sure e2e pass if relative paths are changed.
- specs/: specs is the source of truth, keep synchronized with code, without ask. Read spec first then code for logics.
- specs/overview.md: overview of the system
- specs/constitution.md: constitution of the system
- specs/glossary.md: glossary of the system
- specs/architecture/architecture.md: architecture spec
- specs/adr/adr.md: architecture decision records
- specs/domains/: domain specs
- specs/non-functional/: non-functional specs
