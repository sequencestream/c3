steps:

- `pnpm start --project /tmp --port 13000`
- `node scripts/e2e-ws-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.
