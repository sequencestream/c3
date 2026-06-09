# sandbox — Domain Spec

## Overview

The sandbox domain provides **container-based isolation** for agent execution. Rather than running vendor CLI processes directly on the host, the sandbox layer creates lightweight containers with configurable resource limits, filesystem isolation, network controls, and seccomp security profiles.

This is a **kernel infrastructure** domain (inner domain, ADR-0009) — it provides the plumbing that higher-level features (runs, schedules, permissions) consume through the {@link SandboxDriver} interface. It knows nothing about agents, sessions, or business logic.

**Scope:** sandbox type definitions, driver interface, configuration schema, named definition registry, Docker runtime implementation, seccomp profile loading/merging.
**Boundary:** it does not manage containers directly (the driver does), does not decide which sandbox to use (the caller does), and does not implement container orchestration (Kubernetes, Swarm).

## Module Structure

```
server/src/kernel/sandbox/
├── types.ts                  — Pure type definitions (zero runtime cost)
├── SandboxDriver.ts          — Driver interface (6 methods)
├── SandboxConfig.ts          — Zod schemas + merge logic
├── SandboxRegistry.ts        — Named def registry (register/get/resolve)
├── SandboxRegistry.test.ts   — Registry unit tests
├── docker/
│   ├── DockerDriver.ts       — Docker runtime implementation (dockerode)
│   └── DockerDriver.test.ts  — Docker driver unit tests (mock dockerode)
└── seccomp/
    ├── default.json          — MVP permissive seccomp profile
    └── profiles.ts           — Load + merge seccomp profiles
```

### Layer Architecture

```
features/ (schedules, runs, …)
    │  calls SandboxDriver via interface
    ▼
kernel/sandbox/
    │  SandboxDriver (interface) ← implemented by → DockerDriver
    │  SandboxRegistry (registers system defs, resolves with project overrides)
    │  SandboxConfig (parses + validates config)
    ▼
docker/DockerDriver.ts → dockerode → Docker daemon
seccomp/profiles.ts → seccomp JSON files
```

### File Responsibilities

| File                     | Responsibility                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`               | `SandboxType`, `SystemSandboxDef`, `ProjectSandboxConfig`, `ResolvedSandboxConfig`, `SandboxHandle`, `ExecResult`, `HealthStatus`, `StartOptions`, `StopOptions` |
| `SandboxDriver.ts`       | Abstract interface with `start` / `stop` / `exec` / `spawnStream` / `snapshot` / `healthCheck`                                                                   |
| `SandboxConfig.ts`       | Zod `systemSandboxDefSchema` + `projectSandboxConfigSchema` + `mergeSandboxConfig()` function                                                                    |
| `SandboxRegistry.ts`     | `class SandboxRegistry` — stores named defs, `register/get/resolve/has/names/size`                                                                               |
| `docker/DockerDriver.ts` | `class DockerDriver implements SandboxDriver` using dockerode                                                                                                    |
| `seccomp/default.json`   | Docker-compatible seccomp JSON profile (SCMP_ACT_ALLOW)                                                                                                          |
| `seccomp/profiles.ts`    | `loadDefaultProfile()`, `loadProfile(path)`, `mergeProfiles(base, override)`                                                                                     |

### Driver Method Contract

| Method        | Input                                             | Output            | Docker Implementation                                    |
| ------------- | ------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| `start`       | `ResolvedSandboxConfig` + optional `StartOptions` | `SandboxHandle`   | `docker.createContainer()` + `.start()`                  |
| `stop`        | `SandboxHandle` + optional `StopOptions`          | `void`            | `docker.getContainer().stop()` + optionally `.remove()`  |
| `exec`        | `SandboxHandle` + `string[]`                      | `ExecResult`      | `container.exec()` + `exec.start()` + `exec.inspect()`   |
| `spawnStream` | `SandboxHandle` + `string[]`                      | `Readable` stream | `container.exec()` + `exec.start()` returning raw stream |
| `snapshot`    | `SandboxHandle` + `tag`                           | image ID string   | `container.commit()`                                     |
| `healthCheck` | `SandboxHandle`                                   | `HealthStatus`    | `container.inspect()`                                    |

## Business Rules

| ID     | Rule                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SND-R1 | A sandbox must be **Docker runtime only** in Phase 1 (MVP). gVisor, Kata, and Firecracker are Phase 2 (planned).                                                  |
| SND-R2 | Each sandbox definition has a unique `name`. The registry overwrites on re-registration.                                                                          |
| SND-R3 | Project config references a system def by `name`. The `resolve()` call merges system def + project overrides.                                                     |
| SND-R4 | Project overrides take precedence over system def values for the same field. The env vars are **merged** (not replaced), with project values winning on conflict. |
| SND-R5 | Unspecified optional fields get sensible defaults: `memoryLimit: "512m"`, `cpuLimit: 1`, `networkDisabled: true`, `readonlyRootfs: false`, `envVars: {}`.        |
| SND-R10 | Sandboxed containers run with **`--network none`** by default (`networkDisabled: true`). Network egress requires explicit allowlist configuration (Phase 2). |
| SND-R11 | The `networkAllowlist` field is the SPI for egress rules. Setting it to a non-empty array **throws** in MVP (Phase 2 will introduce MITM proxy filtering).  |
| SND-R12 | Resource limits can be set via the flat `memoryLimit`/`cpuLimit` fields OR via the structured `resourceLimits` sub-object. When both are set, `resourceLimits` values **take precedence**. The `resourceLimits.stopTimeoutMs` field is the only way to set the container stop timeout. |
| SND-R6 | The Docker driver connects to the **local Docker daemon** via the default socket. Remote Docker hosts are not supported (constitution: localhost-only).           |
| SND-R7 | `stop()` swallows errors from already-stopped containers (idempotent).                                                                                            |
| SND-R8 | `healthCheck()` returns `{ status: 'error', running: false }` (never throws) on inspect failure.                                                                  |
| SND-R9 | The seccomp `default.json` profile is permissive (`SCMP_ACT_ALLOW`) for MVP. Hardening will follow in Phase 2.                                                    |

## Phase Plan

| Phase         | Scope                                                                                                      | Status     |
| ------------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| Phase 1 (MVP) | Docker runtime only, types + interface + registry + config, seccomp default profile, unit tests with mocks | ✅ Current |
| Phase 2       | gVisor/Kata/Firecracker backends, seccomp hardening, resource monitoring, snapshot management              | 📋 Planned |
| Phase 3       | Remote sandbox support (E2B, Firecracker microVM) — requires ADR + constitution change (localhost-only)    | 🔮 Future  |
