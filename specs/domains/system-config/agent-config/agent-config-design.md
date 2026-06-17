# agent-config — Design

Implements the [spec](agent-config-spec.md). Spans four responsibilities: settings persistence + resolution, the
WebSocket event dispatch + per-run resolution, the SDK launch override application, and the full-page
settings view in the web console.

## Responsibility split

| Concern                         | Behaviour                                                                                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings + binding persistence  | Two files under `~/.c3/`; in-memory cache; atomic write; fail-soft                                                                                                                                                                                        |
| Vendor config schema + routing  | A `vendor`-discriminated union validator; type-pinned to the wire agent shape; extension point for new vendors (AC-R12)                                                                                                                                   |
| Quota reset parsing             | A pure parser for quota/session-limit errors carrying a `reset(s) <time>`; maps the reset wall-clock through `SystemSettings.timezone` to a Unix-ms instant (AC-R22)                                                                                      |
| Event dispatch + run resolution | Handles `get_settings` / `save_settings`; resolves a session launch per run                                                                                                                                                                               |
| Override application            | Maps overrides onto the SDK launch `env` (merged over the process environment) + `model`                                                                                                                                                                  |
| Full-page settings view         | Editable draft, one row per agent, add/remove, drag-reorder; a single **default-agent dropdown** below the list (enabled agents only, in order-sequence order) replaces the per-row radio; save. Per-project controls moved to the workspace-setting view |

## Persistence

- **`settings.json`** at `~/.c3/settings.json` — holds the agent registry, the default agent id, and
  the per-project configs (under a `projectConfigs` key, see [system-config overview](../system-config-overview.md)).
- **`state.json`** at `~/.c3/state.json` — the two-key binding (ADR-0015), versioned: a pending-intent
  map (pending id → desired agent + creation time) is the mutable intent; a session-agent map (real id
  → agent + frozen vendor) is the frozen fact. A legacy single-map blob migrates on first read:
  `pending:` keys become intents, others become claude-frozen facts.
- Each is loaded lazily into an in-memory cache; every mutation persists synchronously.
- **Atomic write:** write to a per-process temp file, then rename over the target.
- **Fail-soft:** a missing/corrupt file falls back to defaults (system agent only / empty
  binding) and the system still boots (AC-R7, AVAIL).

## Vendor schema + routing (AC-R12)

The agent config is a `vendor`-discriminated union. The wire **type** is zero-runtime and SDK-free
(ADR-0009); the **runtime validation schema** lives apart so the validator never enters the wire
module. A compile-time assertion pins the two in both directions so they cannot drift — the same
discipline the adapter-capability shapes use. The union is keyed on `vendor`; today the only arm is
`claude` (base URL, API key, model). A per-vendor registry is the **extension point**: a new vendor
adds its arm, appends it to the union, and the type pin forces the matching wire arm. A parse routine
routes a raw record by its tag and returns the typed agent or nothing.

## Normalization

`save_settings` and every load run through normalization (AC-R1/R2/R3/R12):

- The system agent is re-injected at the front as a `claude` agent with the vendor **default**
  (empty) config; any incoming `system` entry is dropped (its config is never honoured).
- Each non-system agent keeps its id, or gets a fresh generated uuid if missing; duplicate ids
  are dropped. The record is shaped into a candidate — **legacy-flat → claude arm** (legacy `name`
  becomes the display name; flat base URL / API key / model become the nested config); new-shape
  records keep their vendor / nested config. String fields are trimmed; the display name falls back
  to the id. The candidate is then validated/routed by the vendor parser; an unknown vendor or a
  config that fails its arm yields nothing and the agent is **dropped** (fail-soft).
- The default agent id is resolved by the shared resolution rule (AC-R2, 2026-06-15-001): kept iff it
  references a surviving **enabled** agent; an unknown, removed, or now-disabled default is
  **rewritten** to the next enabled agent in order-sequence order (scan forward from its position,
  then wrap to the first enabled overall); if **no** agent is enabled it falls back to the synthesized
  fallback id. Normalization runs after order regularization, so the registry is already in dense
  order-sequence order when the scan runs. The rule is **single-sourced in the shared protocol module**
  so the web console (on disable/remove) and the server (on save/load) rewrite identically.
- The legacy global default mode (deprecated in system settings) is still accepted for backward
  compatibility during the migration window. The authoritative source is the per-project default
  mode, read from the workspace setting; the same validation (one of the five permission-mode values)
  and fallback (`default`) apply per-project. It seeds a new session's runtime mode at session
  creation (SR-R6).
- The enabled flag is persisted as an explicit boolean treating absent/`true` as `true`, only an
  explicit `false` as `false` — so old configs lacking the field stay enabled (AC-R10). The
  re-injected system agent's enabled flag is read from the incoming `system` entry the same way (its
  overrides are still ignored — AC-R1).

The normalized object is echoed to the client as `settings`, so the browser's temporary
client-side ids are replaced by the server's stable uuids.

## Order regularization (AC-R20)

After the parse/de-dupe loop, normalization collects each survivor together with its raw order read
**straight off the on-disk record** (a finite number or absent), independent of the schema default,
so the "this record had no explicit position" signal is not lost. A pure leaf routine then produces
the canonical order with a single stable sort, three tiers:

1. the system agent is **pinned to the front** (kept on top even if its stored order is larger);
2. then agents with an explicit raw order, ascending;
3. then agents missing one, in their current array order, appended at the **tail**.

Ties (and the whole missing group) break by original index ⇒ stable. The final order sequence is then
reassigned to a dense `0..n`, which also **dedupes** any duplicate positions a hand-edited config
might carry. The order sequence is **optional on the wire** (matching the back-compat convention used
for the enabled/icon fields), but a normalized/persisted registry always carries a dense sequence. The
empty-registry fallback seeds the synthesized system agent at order sequence 0.

**Out of scope of the order sequence:** the degradation chain is an independent user-authored ordered
id list (its sequence IS the fallback priority) and is **not** re-sorted here; launch resolution
resolves by id, never by position.

## Enabled filtering (AC-R10, AC-R20)

Enabled-agent selection returns the agents whose enabled flag is not `false`, **in order-sequence
ascending order** (a defensive ascending sort guards an un-normalized settings object passed straight
in; the canonical registry is already ordered) — the single source the "list of agents" consumers
draw from:

- **Discussion participants** — the orchestrator's participant set is the enabled agents.
- **Consensus voters** — the voter set filters the enabled agents (minus the session's own).
- **Degradation chain** — chain normalization builds its valid id set from enabled agents only, so
  disabled ids are dropped from the stored/loaded chain; the server assembles the agents-to-try list
  from the already-filtered chain with entry 0 = the resolved session agent.
- **Default-agent picker** — the settings view renders a single dropdown below the agent list (enabled
  draft agents, options in array/order-sequence order); the per-row radio is gone. Disabling (or
  removing) an agent re-resolves the default id to the next enabled agent immediately, so the dropdown
  never points at a disabled agent (AC-R2).

The front-end mirrors the order-sequence order so an unsaved local edit looks like the server result:
the new-session and discussion views sort their enabled-agent lists by order sequence, and the
settings view renders/reorders the draft in array order. The settings list is drag-reorderable via
**native HTML5 drag-and-drop** (no library): a grip handle is the drag source so the row's text inputs
stay selectable, the row is the drop target, and saving stamps the order sequence from the final array
order before emitting — so a reorder (or add/copy/remove) survives the round-trip, after which the
server normalization re-pins the system agent and regularizes to a dense `0..n` (AC-R20).

The launch-resolution path deliberately does **not** filter on enabled — a disabled agent stays a
valid fallback so a bound/default/system launch is never blocked (AC-R10).

## Quota-limit auto-disable + recovery (AC-R22)

A resident subscriber is wired at startup to the kernel `agent:error` event. On each degradable agent
failure it parses the error for a quota reset, using the configured timezone. The parser is
intentionally narrow: the message must look like a quota/session/rate-limit exhaustion and must
contain a `reset`/`resets` time such as `10:40pm` or `22:40`. The time is interpreted as a wall-clock
in the normalized system timezone; if that local time has already passed for the current local day, it
rolls to the next local day.

When parsing succeeds, the agent's enabled flag is persisted as `false` through the normal save path.
This means default/tool/intent fall-through is not special-cased: if the disabled agent was the
default, a non-empty tool agent, or a non-empty intent agent, normalization rewrites those ids to the
next enabled agent by order sequence. The recovery subscriber then creates an internal one-shot
schedule through the schedules store; when it fires, the schedule dispatcher re-enables the agent, and
the scheduler pauses that one-shot row and clears its next-run time.

If parsing fails, or the schedule store is unavailable, the existing agent error/degradation flow is
left intact. A store outage can still leave the agent disabled without a timed recovery; the warning
is logged and the user can re-enable the agent manually.

## Launch resolution

The launch resolver does the following per run:

- The agent id is read from the binding (a pending id resolves via the pending-intent space; a real id
  via the session-agent fact — AC-R6/R16).
- The agent is the one matching that id, else the one matching the default agent id, else the system
  agent.
- Overrides are then derived by vendor. For a `claude` agent: the config base URL maps to the
  Anthropic base-URL environment variable; the API key maps to both the Anthropic API-key and
  auth-token environment variables; the model maps to the model override. For any **non-system** agent
  the adaptive-thinking workaround env (see below) is set. A codex agent's neutral provider triple is
  carried through unchanged here and then re-routed through the relay inside its driver (AC-R15).

The resolver returns the neutral overrides unchanged; the **codex driver** is what re-routes a custom
provider through c3's in-process Responses→Chat relay (it registers the real base URL + key behind a
token and points codex at the loopback relay; AC-R15 / ADR-0014). The relay translator + HTTP handler
are transport, not kernel (ADR-0009 R2).

Empty fields contribute nothing, so the system agent yields no overrides and the run gets no
`env`/`model` override — the SDK's own resolution applies (AC-R4/R5). When environment overrides are
present they are merged over the full process environment so the spawned process keeps its complete
environment; when absent the launch omits `env` entirely.

### Adaptive-thinking workaround (temporary)

Recent Claude Code introduced an **adaptive-thinking** mechanism that changed the request
message format. Third-party Anthropic-compatible gateways (e.g. DeepSeek's `/anthropic`
endpoint) do **not** yet accept that format — they reject the inline `system`-role messages
with `400 messages[].role: unknown variant system`. As a stopgap, every **non-system** agent's
launch sets an env flag that turns off just that mechanism and restores the compatible message
format. Verified against DeepSeek: the 400 is gone and CLAUDE.md/memory, Skills, hooks, and the
working-directory context all still work.

- **Why not the CLI bare mode:** that mode also clears it, but as a heavy hammer — it additionally
  disables CLAUDE.md/auto-memory, Skills, and hooks and simplifies the system prompt, weakening the
  working-directory/git context from the Claude Code system-prompt preset. The adaptive-thinking
  disable flag is the surgical choice and is what we use.
- **Scope:** only non-system agents; the system agent talks to first-party Anthropic and needs
  no fallback.
- **REMOVE when:** the third-party providers support the adaptive-thinking message format —
  then drop this env injection. (A request-rewriting proxy that hoists inline `system` messages
  into the top-level `system` field is the other long-term option.)

### Tool & intent agent routing (AC-R21 / AC-R23)

Two settings let specific session classes run on a different agent than "default for new sessions",
both decoupled from the default agent id and from each other:

- **Tool agent** (AC-R21) — background tool sessions (completion judge, schedule/session-name
  derivation), resolved through the tool-agent resolution path.
- **Intent agent** (AC-R23) — intent-communication sessions (the intent analyst's
  requirement-breakdown conversation), resolved through the intent-agent resolution path and bound
  onto each newly-created intent comm session right after its runtime is ensured.

Both share the **same sentinel + fall-through** as the default but with the "follow default"
exception: an **empty string** means "follow the default agent" and is kept empty on store (never
auto-filled); a **non-empty** id pointing at a removed/disabled agent is rewritten to the next
enabled agent by order sequence. The runtime resolves either through the common agent resolver, so the
chain is `<setting> → default agent → synthesized fallback`. The web console renders them as the
second (tool) and third (intent) dropdowns under the default-agent picker; the disable handler applies
the same fall-through the instant an agent is disabled, but only when the id is non-empty. Intent
routing only changes the **initial** binding — the title-bar same-vendor switcher still lets the user
re-target an open intent comm session manually.

## Binding mechanics — two-key space + frozen vendor (ADR-0015)

The binding splits into **intent** and **fact** so a pending session's desired agent (mutable) is
kept apart from a real session's settled agent (vendor-bearing).

- **Storage, vendor-blind.** Reading an agent id consults both spaces; reading a vendor reads the
  frozen vendor; setting/clearing an intent stamps its creation time; the first-bind freeze writes
  the fact iff absent and always deletes the intent (idempotent); a fact change enforces the invariant
  (same-vendor → write; cross-vendor → reject); a janitor sweeps stale pending intents. Vendor is
  always a plain argument, so the storage layer never imports the agent registry (the
  storage → agent-config boundary stays acyclic — ADR-0009).
- **Resolution.** The freeze routine resolves the agent's vendor and performs the first-bind freeze; the
  set-agent routine routes a pending id to set-intent and a real id to fact-change, returning an
  ok/not-ok result.
- **Bind timing.** The freeze fires at the same moment as the runtime re-key on the first real session
  id, in both run paths (the claude lifecycle path and the via-driver path).
- **Janitor.** The server runs the stale-intent cleanup with a 7-day TTL at boot and hourly. Clearing
  an intent never touches the fact space, so a fact is never orphaned.

```
first run:  pending:<uuid>  --bindPending(runtime re-key)-->  realId
                  │                                              │
            pending intent  --freeze-->  session fact = { agent, vendor }   (vendor frozen)
                  │                                              ▲
            (intent deleted) ───────────────────────────────────┘
re-target:  set-agent(realId, newAgent) → same vendor ? write fact : reject (not ok)
janitor:    pending intents older than 7 days → reaped (facts untouched)
```

## Non-functional considerations

- **Secrets** — the API key is stored in plaintext under `~/.c3/settings.json` (same trust model
  as the user's `~/.claude` credentials); the view renders the field as a password input.
- **System agent invariant** — re-injected on every load/save, so it cannot be deleted or given
  overrides even by hand-editing the file (AC-R1).
- **Decoupled persistence** — the binding lives in `~/.c3/state.json`, independent of the
  session-registry's state file under `~/.claude/c3/`, so the two concerns evolve separately.
- **Temporary workaround (tech debt)** — the adaptive-thinking disable env on non-system agents is a
  stopgap for the message-format incompatibility; remove it once third-party providers support the new
  format (see the workaround subsection above).

## Dependencies

- **agent-session** — consumes the resolved launch output (environment overrides / model).
- **Node filesystem facilities** — atomic JSON persistence under `~/.c3/`.
