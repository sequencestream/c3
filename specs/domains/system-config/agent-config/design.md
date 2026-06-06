# agent-config — Design

Implements the [spec](spec.md). Lives in `server/src/settings.ts` (persistence + resolution),
the WS handler in `server/src/server.ts` (event dispatch + per-run resolution), the SDK launch
in `server/src/claude.ts` (override application), and the full-page settings view in `web/src/App.vue`.

## Module split

| Concern                         | File                                   | Notes                                                                                                                 |
| ------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Settings + binding persistence  | `server/src/settings.ts`               | Two files under `~/.c3/`; module cache; atomic write; fail-soft                                                       |
| Vendor config schema + routing  | `kernel/agent-config/schema.ts`        | zod discriminated-union per `vendor`; type-pinned to the wire `AgentConfig`; extension point for new vendors (AC-R12) |
| Event dispatch + run resolution | `server/src/server.ts`                 | `get_settings` / `save_settings`; `resolveSessionLaunch` per run                                                      |
| Override application            | `server/src/claude.ts`                 | Maps overrides onto `query()` `env` (merged over `process.env`) + `model`                                             |
| Full-page settings view         | `web/src/components/SettingsPanel.vue` | Editable draft, one row per agent, add/remove, pick default agent, pick default mode, save                            |

## Persistence (`settings.ts`)

- **`settings.json`** at `~/.c3/settings.json` — `{ agents, defaultAgentId, defaultMode }`.
- **`state.json`** at `~/.c3/state.json` — `{ version, sessionAgents }` (the binding).
- Each loaded lazily into a module cache; every mutation persists synchronously.
- **Atomic write:** write `…json.<pid>.tmp` then `renameSync` over the target.
- **Fail-soft:** a missing/corrupt file falls back to defaults (system agent only / empty
  binding) and the system still boots (AC-R7, AVAIL).

## Vendor schema + routing (`kernel/agent-config/schema.ts`, AC-R12)

`AgentConfig` is a `vendor`-discriminated union. The **type** lives in `shared/protocol.ts`
(zero-runtime, SDK-free — ADR-0009); the **runtime zod schema** lives in
`kernel/agent-config/schema.ts` so zod never enters the wire module. A compile-time assertion
(`z.infer<typeof agentConfigSchema>` ↔ `AgentConfig`, both directions) pins the two so they cannot
drift — the same discipline `AdapterCapability` ↔ `AdapterCapabilities` uses. `agentConfigSchema`
is a `z.discriminatedUnion('vendor', […])`; today the only arm is `claude`
(`{ baseUrl, apiKey, model }`). `VENDOR_AGENT_SCHEMAS` is the per-vendor registry / **extension
point**: a new vendor adds its `z.object` arm, appends it to the union, and the type pin forces the
matching wire arm. `parseAgentConfig(raw)` routes by tag and returns the typed agent or `null`.

## Normalization (`normalize`)

`save_settings` and every load run through `normalize` (AC-R1/R2/R3/R12):

- The system agent is re-injected at the front as a `claude` agent with the vendor **default**
  (empty) config; any incoming `system` entry is dropped (its config is never honoured).
- Each non-system agent keeps its `id`, or gets a fresh `randomUUID()` if missing; duplicate ids
  are dropped. The record is shaped into a candidate (`migrateAgentCandidate`) — **legacy-flat →
  claude arm** (`name → displayName`, flat `baseUrl`/`apiKey`/`model` → `config`); new-shape records
  keep their `vendor`/nested `config`. String fields are trimmed; `displayName` falls back to the
  id. The candidate is then validated/routed by `parseAgentConfig`; an unknown vendor or a config
  that fails its arm yields `null` and the agent is **dropped** (fail-soft).
- `defaultAgentId` is kept only if it references a surviving agent; otherwise it falls back to
  `SYSTEM_AGENT_ID`.
- `defaultMode` is kept only if it is one of the five `PermissionMode` values; otherwise it falls
  back to `default` (AC-R8). Consumed by `getDefaultMode()`, which seeds a new session's runtime
  mode in `create_session` (SR-R6).
- `enabled` is persisted as an explicit boolean using `a.enabled !== false` (absent/`true` ⇒
  `true`, only explicit `false` ⇒ `false`) — so old configs lacking the field stay enabled
  (AC-R10). The re-injected system agent's `enabled` is read from the incoming `system` entry the
  same way (its overrides are still ignored — AC-R1).

The normalized object is echoed to the client as `settings`, so the browser's temporary
client-side ids (`new-…`) are replaced by the server's stable uuids.

## Enabled filtering (AC-R10)

`enabledAgents(settings?)` returns `agents.filter(a => a.enabled !== false)` — the single source
the "list of agents" consumers draw from:

- **Discussion participants** — `orchestrator.ts` `participants: () => enabledAgents()`.
- **Consensus voters** — `consensusVoters()` filters `enabledAgents()` (minus the session's own).
- **Degradation chain** — `normalizeDegradationChain` builds its `valid` id set from enabled
  agents only, so disabled ids are dropped from the stored/loaded chain; `server.ts` assembles
  `agentsToTry` from `getDegradationChain()` (already filtered) with entry 0 = the resolved
  session agent.
- **Default-agent picker** — `SettingsPanel.vue` disables the default radio on a disabled row.

`resolveAgent`/`resolveSessionLaunch`/`resolveDegradationAgent` (the launch path) deliberately do
**not** call `enabledAgents` — a disabled agent stays a valid fallback so a bound/default/system
launch is never blocked (AC-R10).

## Launch resolution (`resolveSessionLaunch`)

```
agentId   = sessionAgents[sessionId] ?? null
agent     = agents.find(id === agentId) ?? agents.find(id === defaultAgentId) ?? system agent
overrides = {}
  switch agent.vendor:
    case 'claude':
      agent.config.baseUrl → ANTHROPIC_BASE_URL
      agent.config.apiKey  → ANTHROPIC_API_KEY + ANTHROPIC_AUTH_TOKEN
      agent.config.model   → model
      (non-system agent only) CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = "1"   // claude-scoped workaround, see below
    case 'codex' | 'opencode':           // custom ⇒ neutral { baseUrl, apiKey, model } (AC-R5)
      agent.config.{baseUrl,apiKey,model} → overrides   // codex's are then re-routed through the relay in its driver (AC-R15)
```

`resolveSessionLaunch` returns the neutral overrides unchanged; the **codex driver** is what re-routes
a custom provider through c3's in-process Responses→Chat relay (registers the real `{baseUrl, apiKey}`
behind a token, points codex at the loopback relay; AC-R15 / ADR-0014). The relay translator + HTTP
handler are transport (`transport/codex-relay/`), not kernel (ADR-0009 R2).

Empty fields contribute nothing, so the system agent yields `{}` and the run gets no `env`/`model`
override — the SDK's own resolution applies (AC-R4/R5). In `claude.ts`, a present `envOverrides`
is merged as `env: { ...process.env, ...envOverrides }` so the spawned process keeps its full
environment; an absent one omits `env` entirely.

### `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` workaround (temporary)

Recent Claude Code introduced an **adaptive-thinking** mechanism that changed the request
message format. Third-party Anthropic-compatible gateways (e.g. DeepSeek's `/anthropic`
endpoint) do **not** yet accept that format — they reject the inline `system`-role messages
with `400 messages[].role: unknown variant system`. As a stopgap, every **non-system** agent's
launch sets `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`, which turns off just that mechanism and
restores the compatible message format. Verified against DeepSeek: the 400 is gone and
CLAUDE.md/memory, Skills, hooks, and the working-directory context all still work.

- **Why not `CLAUDE_CODE_SIMPLE=1`:** that flag (the CLI `--bare` mode) also clears it, but as a
  heavy hammer — it additionally disables CLAUDE.md/auto-memory, Skills, and hooks and
  simplifies the system prompt, weakening the working-directory/git context from agent-session's
  `systemPrompt: claude_code` preset. `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` is the surgical
  choice and is what we use.
- **Scope:** only non-system agents; the system agent talks to first-party Anthropic and needs
  no fallback.
- **REMOVE when:** the third-party providers support the adaptive-thinking message format —
  then drop this env injection. (A request-rewriting proxy that hoists inline `system` messages
  into the top-level `system` field is the other long-term option.)

## Non-functional considerations

- **Secrets** — `apiKey` is stored in plaintext under `~/.c3/settings.json` (same trust model
  as the user's `~/.claude` credentials); the view renders the field as a password input.
- **System agent invariant** — re-injected on every load/save, so it cannot be deleted or given
  overrides even by hand-editing the file (AC-R1).
- **Decoupled persistence** — the binding lives in `~/.c3/state.json`, independent of the
  session-registry's `~/.claude/c3/state.json`, so the two concerns evolve separately.
- **Temporary workaround (tech debt)** — `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` on
  non-system agents is a stopgap for the adaptive-thinking message-format incompatibility;
  remove it once third-party providers support the new format (see the workaround subsection
  above).

## Dependencies

- **agent-session** — consumes `resolveSessionLaunch` output (`envOverrides` / `model`).
- **Node `fs`/`os`/`path`** — atomic JSON persistence under `~/.c3/`.
