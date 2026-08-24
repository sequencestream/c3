/**
 * IM robot persistence barrel.
 *
 * The four responsibilities of the former single file now live in split modules:
 *
 *  - `robot-schema.ts` — table DDL, whole-table rebuild migrations, `ensureSchema`
 *  - `robot-config-store.ts` — `im_robots` configuration CRUD + row mapping
 *  - `robot-context-store.ts` — Conversations and bounded IM-visible context
 *  - `robot-turn-store.ts` — outbound turn audit
 *  - `robot-db.ts` — shared base (`requireDb` / tx / clock / `RobotStoreError`)
 *
 * This barrel re-exports the whole public surface so the consumers importing
 * `./robot-store.js` stay unchanged.
 */
export * from './robot-db.js'
export * from './robot-config-store.js'
export * from './robot-context-store.js'
export * from './robot-turn-store.js'
export * from './robot-schema.js'
