import type { StateDeps } from './types'
import { buildAppState } from './body'

/** Assemble the shared reactive state surface (refs, computeds, helpers). */
export function createState(deps: StateDeps) {
  return buildAppState(deps)
}

export type AppState = ReturnType<typeof createState>
