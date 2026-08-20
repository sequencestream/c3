/**
 * Wiring — bring the IM supervisor up and down with the server.
 *
 * Mirrors `scheduler-startup.ts`: the composition root calls these two, and the
 * feature module stays free of any knowledge about process lifecycle.
 *
 * The stop side matters more than it looks. `stopAndRelease` in `server.ts` runs
 * on SIGINT/SIGTERM *and* on a self-update relaunch, so a link left open here
 * would survive into the next process and two builds would answer the same chat.
 */
import { startImSupervisor, stopImSupervisor } from '../features/im/supervisor.js'
import { ensureRobotSchema } from '../features/im/robot-store.js'
import { makeRunRobotTurn, type RobotTurnDeps } from './robot-turn.js'

export function startImRobotsWiring(deps: RobotTurnDeps): void {
  // Materialize the tables first, so an unusable database surfaces here rather
  // than on the first inbound message.
  if (!ensureRobotSchema()) {
    console.warn('[c3][im] robot store unavailable; chat robots are disabled this run')
    return
  }
  startImSupervisor({ runTurn: makeRunRobotTurn(deps) })
}

export async function stopImRobotsWiring(timeoutMs = 30_000): Promise<void> {
  await stopImSupervisor(timeoutMs)
}
