# c3 Configuration Reference

> **Persistent system configuration** lives at `~/.c3/settings.json` (the only
> persistence store per the Constitution). Per-project overrides live in the
> same file under `systemSettings.projectConfigs`. There is no database; all
> state is in-process (ADR-0006) and config is file-backed.

---

## Table of Contents

- [System Settings](#system-settings)
- [Project Config](#project-config)
- [Sandbox Configuration](#sandbox-configuration)
- [Backward Compatibility](#backward-compatibility)

---

## System Settings

The top-level keys in `~/.c3/settings.json`. Mapped to `SystemSettings` in
[`shared/src/protocol.ts`](shared/src/protocol.ts).

| Key                | Type                            | Default      | Description                                  |
| ------------------ | ------------------------------- | ------------ | -------------------------------------------- |
| `agents`           | `AgentConfig[]`                 | —            | Agent profiles (url/key/model/name)          |
| `defaultAgentId`   | `string`                        | —            | Agent id for new/unassigned sessions         |
| `uiLang`           | `UiLang`                        | `"en"`       | UI display language (en/zh/ja/ko/ru)         |
| `timezone`         | `string`                        | Server local | IANA time zone for schedule cron evaluation  |
| `showToolSessions` | `boolean`                       | `false`      | Show tool-created sessions in sidebar        |
| `sandboxes`        | `SystemSandboxDef[]`            | `[]`         | System-level sandbox definitions (see below) |
| `projectConfigs`   | `Record<string, ProjectConfig>` | `{}`         | Per-project (workspace) configuration        |
| `socketAutoResume` | `boolean`                       | `false`      | Auto-resume sessions on socket reconnect     |

---

## Project Config

Each project workspace has its own config entry in `systemSettings.projectConfigs`,
keyed by the resolved absolute project path. All settings are optional; absent
fields use their defaults.

| Key                 | Type                     | Default | Description                                        |
| ------------------- | ------------------------ | ------- | -------------------------------------------------- |
| `defaultMode`       | `Record<VendorId, ...>`  | Vendor  | Per-vendor permission mode                         |
| `sandbox`           | `WorkspaceSandboxConfig` | —       | Per-project sandbox configuration (see below)      |
| `consensus`         | `ConsensusConfig`        | `null`  | Multi-agent consensus settings                     |
| `devSkill`          | `string`                 | `""`    | Slash command prefix for dev sessions              |
| `maxRoundsPerStage` | `number`                 | `8`     | Per-stage round cap (minimum 8, clamped)           |
| `maxSpeechChars`    | `number`                 | `300`   | Per-turn character guidance (minimum 300, clamped) |
| `skillRepos`        | `SkillRepoConfig[]`      | `[]`    | External git repos mounted as skills               |

---

## Sandbox Configuration

Sandbox allows running agent vendor CLIs inside a container for filesystem,
network, and resource isolation. It's **opt-in**: no sandbox config means no
isolation — behaviour is identical to today.

### Quick Start

```jsonc
// ~/.c3/settings.json
{
  "sandboxes": [
    {
      "name": "default",
      "type": "docker",
      "image": "node:20-alpine",
      "memoryLimit": "512m",
      "cpuLimit": 1,
    },
  ],
  "projectConfigs": {
    "/path/to/my-project": {
      "sandbox": {
        "enabled": true,
        "sandbox": "default",
      },
    },
  },
}
```

### System-Level: `sandboxes`

Defined at system level (`SystemSettings.sandboxes`). Each entry is a
"template" that projects reference by name. Admin-only CRUD via the System
Settings panel.

| Field              | Type                      | Required | Default     | Description                                               |
| ------------------ | ------------------------- | -------- | ----------- | --------------------------------------------------------- |
| `name`             | `string`                  | ✅       | —           | Unique identifier for this definition                     |
| `type`             | `'docker'`                | ✅       | —           | Runtime backend (Phase 1: Docker only)                    |
| `image`            | `string`                  | ✅       | —           | Container image (e.g. `"node:20-alpine"`)                 |
| `seccomp`          | `string`                  | —        | `undefined` | Seccomp profile name (Phase 1: unconfined)                |
| `memoryLimit`      | `string`                  | —        | `"512m"`    | Memory limit (Docker format: `"256m"`, `"2g"`, etc.)      |
| `cpuLimit`         | `number`                  | —        | `1`         | CPU cores (fractional: `0.5` = half a core)               |
| `resourceLimits`   | `ResourceLimits`          | —        | `undefined` | Structured resource limits (overrides flat fields)        |
| `description`      | `string`                  | —        | `undefined` | Human-readable description shown in UI                    |
| `networkDisabled`  | `boolean`                 | —        | `true`      | Disable network access (`--network none`)                 |
| `networkAllowlist` | `string[]`                | —        | `undefined` | Egress allowlist — **Phase 2, MVP throws if non-empty**   |
| `readonlyRootfs`   | `boolean`                 | —        | `false`     | Read-only container root filesystem                       |
| `envVars`          | `Record<string, string>`  | —        | `{}`        | Environment variables injected into the container         |
| `workingDir`       | `string`                  | —        | `undefined` | Working directory inside the container                    |
| `entrypoint`       | `string[]`                | —        | `[]`        | Override container entrypoint (default: `sleep infinity`) |
| `dockerOptions`    | `Record<string, unknown>` | —        | `undefined` | Additional Docker options (passed verbatim to dockerode)  |

### Structured Resource Limits (`resourceLimits`)

Set via the `resourceLimits` sub-object. When `resourceLimits.memory` or
`resourceLimits.cpu` are set, they take **precedence** over the flat
`memoryLimit`/`cpuLimit` fields. The `stopTimeoutMs` is only expressible
via this sub-object.

| Field           | Type     | Description                                                    |
| --------------- | -------- | -------------------------------------------------------------- |
| `memory`        | `string` | Memory limit (overrides `memoryLimit` when set)                |
| `cpu`           | `number` | CPU limit (overrides `cpuLimit` when set)                      |
| `stopTimeoutMs` | `number` | Container stop timeout in ms (converted to seconds for Docker) |

### Project-Level: `sandbox`

Configured per-project via `WorkspaceSetting.sandbox`. The project **selects** a
system definition by name and may enable/disable sandboxing. Only non-security
fields are overridable.

Two normalize invariants apply (`normalizeSandboxConfig`):

- **worktree-only**: the whole `sandbox` block is dropped unless the workspace's
  `gitBranchMode` is `worktree` — under `current-branch` the container would
  bind-mount the live project checkout, so sandboxing offers no isolation.
- **custom-only**: `agentIds` keeps only `enabled && configMode: 'custom'` agent
  ids; invalid / system / disabled ids are silently dropped.

| Field                 | Type       | Required | Description                                                           |
| --------------------- | ---------- | -------- | --------------------------------------------------------------------- |
| `enabled`             | `boolean`  | —        | Master switch. `false` or unset → no sandbox.                         |
| `sandbox`             | `string`   | —        | Name of the system sandbox definition to use.                         |
| `agentIds`            | `string[]` | —        | Custom agents allowed in the container (worktree-only + custom-only). |
| `networkDisabled`     | `boolean`  | —        | Override system def's network setting.                                |
| `imageOverride`       | `string`   | —        | Override the base image (overrides system `image`).                   |
| `memoryLimitOverride` | `string`   | —        | Override system `memoryLimit`.                                        |
| `cpuLimitOverride`    | `number`   | —        | Override system `cpuLimit`.                                           |
| `envVarsOverride`     | `Record`   | —        | Additional env vars (merged with system `envVars`; wins conflicts).   |

### Merge Precedence

```
Project override > System definition > Defaults
```

1. If `project.sandbox` is absent, `enabled === false`, or `sandbox` name is
   missing → **no sandbox** (run executes on the host as today).
2. Project overrides win for the same field (image, memory, CPU, env vars).
3. Env vars are **merged** (not replaced), with project values winning on key
   conflict.
4. `resourceLimits.memory`/`resourceLimits.cpu` win over flat `memoryLimit`/
   `cpuLimit` **within the same layer**.
5. Unspecified optional fields receive sensible defaults.

### Activation Flow

```
session starts
  → launchRun()
    → getProjectSandbox(workspacePath)
      → undefined? -> skip (host-only execution)
    → registry.resolve(name, projectCfg)
      → unknown name? -> throw
    → driver.start(resolvedConfig, {binds: [...]})
      → Docker unavailable / fail? -> console.warn + skip
    → rt.sandboxHandle = handle
      -> run proceeds
    → run completes
      → finalizeRun -> rt.sandboxStop() -> container cleanup
```

### Security Constraints

| Constraint           | Detail                                                      |
| -------------------- | ----------------------------------------------------------- |
| Network default      | Containers start with `--network none`; no egress.          |
| Image/type/seccomp   | Not overridable at project level — set only by admin.       |
| Network allowlist    | Phase 2 feature. Non-empty array in MVP throws at start.    |
| Seccomp profile      | Phase 1: `unconfined`. Hardening follows in Phase 2.        |
| Host file access     | Only the project directory is bind-mounted at `/workspace`. |
| Resource limits      | Default memory ceiling: 512 MB. Default CPU: 1 core.        |
| Graceful degradation | Sandbox launch failure → `console.warn` → host execution.   |

### Sandbox Wrapper

not spawned directly on the host. Instead, `SandboxLauncher.createSandboxWrapper()`
creates a shell script that invokes `docker exec --env-file <env> -i -w /workspace
<container> <binary> "$@"`. The wrapper:

- Passes API keys and config via `--env-file` (never on the command line)
- Sets the working directory to `/workspace` (the project bind mount)
- Forwards all CLI arguments transparently
- Is created in a temp directory cleaned up on container stop

---

## Backward Compatibility

### Scenario 1: No sandbox fields in config

**Result: behavior unchanged.** If neither `SystemSettings.sandboxes` nor
`ProjectConfig.sandbox` exists, no sandbox code path is activated.
`getProjectSandbox()` returns `undefined`, `launchSandbox()` returns `null`,
and the run proceeds on the host exactly as before.

### Scenario 2: system.sandboxes is empty / absent

**Result: Workspace setting hides sandbox UI.** When `sandboxes` is `[]` or
absent, there are no system definitions to reference. The UI checks this array
and hides the sandbox configuration section in the Workspace Setting panel.

### Scenario 3: sandbox.enabled === false

**Result: identical to no sandbox.** The `launchSandbox()` check
(`if (!projectCfg?.enabled || !projectCfg.sandbox) return null`) treats
`enabled: false` as "skip sandbox", regardless of whether a system def name
is set. Run proceeds on the host.

### Scenario 4: System definition name deleted while project references it

**Result: fail-fast at session launch.** When a system definition is removed
but a project still references it by name, `registry.resolve()` throws
`Unknown sandbox definition: "name"`. The error is caught by `launchRun`,
logged as `console.warn`, and the run **degrades gracefully** to host-only
execution. The session is not blocked.

### Scenario 5: Docker unavailable

**Result: non-sandbox path unaffected.** Docker unavailability is detected by
`checkDockerAvailable()` or by the failed `driver.start()` call. The error is
caught in `launchRun`, logged, and the run proceeds without sandbox. Sessions
that do not have sandbox enabled are never affected.

### Scenario 6: Empty / undefined project sandbox config

**Result: same as disabled.** `normalizeSandboxConfig(undefined)` returns
`undefined`. `getProjectSandbox()` returns `undefined`. `launchSandbox()`
returns `null`. Run proceeds on the host.

---

## Validation

All sandbox configuration is validated at persistence time via Zod schemas in
`server/src/kernel/sandbox/SandboxConfig.ts`. Two TypeScript type pins
(`_AssertEqual`) ensure the Zod schemas stay in sync with the kernel's
`SystemSandboxDef` and `WorkspaceSandboxConfig` interfaces.

Server-side normalization in `server/src/kernel/config/index.ts`:

- `normalizeSandboxConfig()` trims string fields and strips empty strings
- **worktree-only** — the config is dropped entirely unless `gitBranchMode` is `worktree`
- **custom-only** — `agentIds` is filtered to `enabled && configMode: 'custom'` agents
- Unknown system definition names are caught at `registry.resolve()` time

---

## References

- [Sandbox domain spec](specs/domains/core/sandbox/spec.md) — full specification
- [ADR-0020](specs/architecture/adr/0020-sandbox-driver-independent-kernel-module.md) — SandboxDriver module decision
- [ADR-0021](specs/architecture/adr/0021-system-project-two-tier-sandbox-config.md) — Two-tier config decision
- [ADR-0022](specs/architecture/adr/0022-canonical-not-extended.md) — CanonicalMessage not extended for sandbox
- [Protocol types](shared/src/protocol.ts) — `SystemSandboxDef`, `WorkspaceSandboxConfig`, `ResourceLimits`
- [Kernel types](server/src/kernel/sandbox/types.ts) — Runtime types with strict readonly
