/**
 * `features/` barrel — slice 1/3 (ADR-0009).
 *
 * One directory per top-level user action, mirroring `ClientToServer['type']`.
 * `registerHandlers()` assembles the exhaustive handler map at startup.
 */
export { handlerMap, registerHandlers } from './register.js'
