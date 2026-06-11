// Session-token persistence for the web console (ADR-0023 auth, Roadmap step 3).
//
// The browser WebSocket cannot set an `Authorization` header, so the token the
// server mints on `login` is re-presented on every (re)connect as a `?token=`
// handshake query param (see `lib/ws.ts`). Persisting it in localStorage keeps
// the session alive across hard refreshes and reconnects — the "smooth session"
// the login UI promises.
//
// localStorage is guarded so this module imports cleanly under the Node test
// environment (where `localStorage` is undefined); there it simply no-ops.

const STORAGE_KEY = 'c3.authToken'

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    // Access can throw in sandboxed/privacy contexts — treat as unavailable.
    return null
  }
}

/** The persisted session token, or `null` when absent / storage unavailable. */
export function getToken(): string | null {
  return storage()?.getItem(STORAGE_KEY) ?? null
}

/** Persist the session token minted by a successful `login`. */
export function setToken(token: string): void {
  storage()?.setItem(STORAGE_KEY, token)
}

/** Drop the persisted token (logout, or the server rejecting it as invalid/expired). */
export function clearToken(): void {
  storage()?.removeItem(STORAGE_KEY)
}
