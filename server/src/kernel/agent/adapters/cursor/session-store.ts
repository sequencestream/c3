/**
 * Cursor {@link SessionStore} — c3's own canonical mirror, deliberately NOT a
 * reader of Cursor's store.
 *
 * Cursor keeps its chats in `~/.cursor/chats` as a private SQLite database. c3
 * does not read or reverse it: that format carries no compatibility promise, and
 * a mirror decoded from it would silently rot on the next CLI release. What c3
 * persists instead is the canonical message stream it observed itself, keyed by
 * the native session id — enough to list a session and replay it in the console.
 *
 * The consequence is stated honestly in the capability ledger as `list`/`read` =
 * `'partial'`: this mirror shows exactly the turns c3 ran, and nothing the user
 * ran in the Cursor IDE or another client. **Recovery never comes from here** —
 * resume always replays Cursor's own context through `--resume`, so a mirror that
 * has drifted changes what the console displays, never what the model remembers.
 *
 * `rename`/`delete` are absent by design (`'none'` in the ledger): c3 must not
 * pretend to mutate a store it does not own.
 */
import type {
  CanonicalMessage,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'

/** Persistence seam — the mirror lives in c3's own store, injected by the caller. */
export interface CursorMirror {
  list(cwd: string): Promise<SessionSummary[]>
  read(sessionId: string, cwd: string): Promise<CanonicalMessage[]>
}

/**
 * An empty mirror. Used when no c3-side store is wired: an empty history is the
 * truthful answer for "what did c3 record", whereas fabricating turns from
 * Cursor's private database would not be.
 */
const EMPTY_MIRROR: CursorMirror = {
  list: async () => [],
  read: async () => [],
}

export class CursorSessionStore implements SessionStore {
  constructor(private readonly mirror: CursorMirror = EMPTY_MIRROR) {}

  async list(opts: SessionListOptions): Promise<SessionSummary[]> {
    return this.mirror.list(opts.cwd)
  }

  async read(sessionId: string, opts: SessionListOptions): Promise<CanonicalMessage[]> {
    return this.mirror.read(sessionId, opts.cwd)
  }
}
