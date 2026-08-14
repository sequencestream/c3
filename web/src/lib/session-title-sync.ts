import type { SessionInfo } from '@ccc/shared/protocol'

export interface ActiveSessionTitleInput {
  activeWorkspace: string | null
  activeSession: string | null
  workspaceName: string
  sessions: SessionInfo[]
}

export function activeSessionTitleFromSessions(input: ActiveSessionTitleInput): string | null {
  if (!input.activeWorkspace || !input.activeSession) return null
  if (input.workspaceName !== input.activeWorkspace) return null

  return input.sessions.find((session) => session.sessionId === input.activeSession)?.title ?? null
}
