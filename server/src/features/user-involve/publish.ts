/**
 * Publish a workspace's wait-user todo snapshot: the paged/live items stay
 * separate from the authoritative todoCount that feeds the badge projection.
 */
import type { WaitUserInvolveEvent } from '@ccc/shared/protocol'
import { pathToName } from '../../state.js'
import { badgeProjection } from '../../kernel/activity/index.js'
import { listEvents, listTodoIds } from './store.js'

export interface WaitUserTodoSnapshot {
  workspaceName: string
  items: WaitUserInvolveEvent[]
  todoCount: number
}

export function waitUserTodoSnapshot(workspacePath: string): WaitUserTodoSnapshot {
  const workspaceName = pathToName(workspacePath) ?? workspacePath
  const todoIds = listTodoIds(workspacePath)
  return {
    workspaceName,
    items: listEvents(workspacePath, 'todo'),
    todoCount: todoIds.length,
  }
}

export function syncTodoAttention(workspacePath: string): void {
  const workspaceName = pathToName(workspacePath) ?? workspacePath
  badgeProjection.setAttentionMembers('todo', workspaceName, listTodoIds(workspacePath))
}

export function emitWaitUserTodoSnapshot(
  workspacePath: string,
  send: (msg: {
    type: 'wait_user_events'
    workspaceName: string
    items: WaitUserInvolveEvent[]
    todoCount: number
  }) => void,
): void {
  const snapshot = waitUserTodoSnapshot(workspacePath)
  send({
    type: 'wait_user_events',
    workspaceName: snapshot.workspaceName,
    items: snapshot.items,
    todoCount: snapshot.todoCount,
  })
  badgeProjection.setAttentionMembers('todo', snapshot.workspaceName, listTodoIds(workspacePath))
}
