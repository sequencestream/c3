import type { IntentStatus } from '@ccc/shared/protocol'
import type { DepType } from './state'
import type { AppCtx } from './types'

// Install intent-tab actions (filter / lifecycle / comm-session list) onto the ctx.
export function installIntentActions(ctx: AppCtx): void {
  const send = ctx.send
  const { intentsProject, selectedIntentSessionId, activeTab } = ctx

  ctx.openIntents = (path: string): void => {
    activeTab.value = 'intents'
    intentsProject.value = path
    ctx.persistViewMode()
    // The response carries both the comm `session_selected` and the list.
    send({ type: 'open_intent_chat', workspaceId: path })
    // Populate the middle-column intent session list.
    send({ type: 'list_intent_sessions', workspaceId: path })
  }

  // "+" in the intent title bar: start a brand-new comm session.
  ctx.newIntentChat = (): void => {
    if (!intentsProject.value) return
    send({ type: 'new_intent_chat', workspaceId: intentsProject.value })
  }

  // Select an existing intent communication session by id.
  ctx.selectIntentSession = (sessionId: string): void => {
    if (!intentsProject.value) return
    selectedIntentSessionId.value = sessionId
    send({ type: 'open_intent_chat', workspaceId: intentsProject.value, sessionId })
  }

  ctx.renameIntentSession = (sessionId: string, title: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'rename_intent_session',
      workspaceId: intentsProject.value,
      sessionId,
      title,
    })
  }

  // Delete an intent communication session.
  ctx.deleteIntentSession = (sessionId: string): void => {
    if (!intentsProject.value) return
    send({ type: 'delete_intent_session', workspaceId: intentsProject.value, sessionId })
  }

  ctx.setIntentFilter = (status: IntentStatus | null): void => {
    if (!intentsProject.value) return
    send({
      type: 'list_intents',
      workspaceId: intentsProject.value,
      ...(status ? { status } : {}),
    })
  }

  ctx.refineIntent = (intentId: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'refine_intent',
      workspaceId: intentsProject.value,
      intentId,
    })
  }

  ctx.writeSpec = (intentId: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'write_spec',
      workspaceId: intentsProject.value,
      intentId,
    })
  }

  ctx.approveSpec = (intentId: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'approve_spec',
      workspaceId: intentsProject.value,
      intentId,
    })
  }

  ctx.createPr = (intentId: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'create_pr',
      workspaceId: intentsProject.value,
      intentId,
    })
  }

  ctx.startDevelopment = (intentId: string, hasUnfinishedDeps: boolean): void => {
    if (!intentsProject.value) return
    void hasUnfinishedDeps
    send({
      type: 'start_development',
      workspaceId: intentsProject.value,
      intentId,
    })
  }

  ctx.setIntentStatus = (intentId: string, status: IntentStatus): void => {
    send({ type: 'update_intent_status', intentId, status })
  }

  ctx.setIntentAutomate = (intentId: string, automateOn: boolean): void => {
    send({ type: 'set_intent_automate', intentId, automate: automateOn })
  }

  ctx.updateIntentDeps = (
    intentId: string,
    deps: { dependsOnId: string; depType: DepType }[],
  ): void => {
    send({ type: 'update_intent_deps', intentId, deps })
  }

  ctx.startAutomation = (): void => {
    if (!intentsProject.value) return
    send({ type: 'start_automation', workspaceId: intentsProject.value })
  }

  ctx.stopAutomation = (): void => {
    if (!intentsProject.value) return
    send({ type: 'stop_automation', workspaceId: intentsProject.value })
  }
}
