steps:

## Smoke test (permission flow)

- `pnpm start --project /tmp --port 13000`
- `node scripts/e2e/e2e-ws-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.

## Consensus voting test (multi-agent decision)

Exercises the multi-agent consensus flow against the real `~/.c3/settings.json`
agents. Seeds a throwaway coding project in `/tmp`, asks the model to edit a
file (forcing a sensitive tool through the permission gateway), and checks that
voting actually ran — `consensus_auto` (unanimous) or a `permission_request`
carrying a `consensus` outcome (split). Consensus is enabled for the run and the
original settings are restored on exit; the agents are never modified.

Requires at least one agent besides the default (to vote). Hits the configured
providers' APIs (spends real tokens).

- `pnpm build` then `pnpm start --project /tmp --port 13000`
  (or `pnpm dev` and use `ws://localhost:3000/ws`)
- `node scripts/e2e/e2e-consensus-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.
