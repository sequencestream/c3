/** Shared error-stringify helper for feature handlers (was a `server.ts` local). */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
