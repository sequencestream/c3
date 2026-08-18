import type { AppCtx } from './types'

// Install discussion-tab actions (read path + composer + lifecycle) onto the ctx.
export function installDiscussionActions(ctx: AppCtx): void {
  const send = ctx.send
  const {
    discussionsProject,
    activeDiscussionId,
    activeDiscussion,
    discussionMessages,
    discussionMaxSeq,
    discussionInput,
    discussionDispatch,
    activeTab,
    intentsProject,
  } = ctx

  // Enter the discussion view for a project: fetch its list and reset the right pane.
  ctx.openDiscussions = (path: string): void => {
    activeTab.value = 'discussion'
    discussionsProject.value = path
    activeDiscussionId.value = null
    activeDiscussion.value = null
    discussionMessages.value = []
    discussionMaxSeq.value = 0
    discussionInput.value = ''
    ctx.persistViewMode()
    send({ type: 'list_discussions', workspaceName: path })
  }

  // Click a discussion in the list: pull its detail (discussion + full history).
  ctx.openDiscussion = (discussionId: string): void => {
    if (discussionId === activeDiscussionId.value) return
    activeDiscussionId.value = discussionId
    discussionInput.value = ''
    // Reset any stale dispatch (in-flight/failed) status for the freshly-opened one.
    if (discussionDispatch.value[discussionId]) {
      const d = { ...discussionDispatch.value }
      delete d[discussionId]
      discussionDispatch.value = d
    }
    ctx.persistViewMode()
    send({ type: 'open_discussion', discussionId })
  }

  // Mobile drill-down back from the read-only history pane to the discussion list.
  ctx.onDiscussionMobileBack = (targetKey: string): void => {
    if (targetKey === 'discussions') {
      activeDiscussionId.value = null
      activeDiscussion.value = null
      discussionInput.value = ''
      ctx.persistViewMode()
    }
  }

  // "+" form submit in the discussion list: create a discussion.
  ctx.createDiscussion = (payload: {
    type: string
    goal: string
    context: string
    participantAgentIds: string[]
    organizerAgentId: string
  }): void => {
    if (!discussionsProject.value) return
    send({
      type: 'create_discussion',
      workspaceName: discussionsProject.value,
      discussionType: payload.type,
      goal: payload.goal,
      context: payload.context,
      participantAgentIds: payload.participantAgentIds,
      organizerAgentId: payload.organizerAgentId,
    })
  }

  // The title bar's launch button: kick off the organizer engine. Serves both the
  // draft's manual Start and the restart of an `in_progress` discussion whose run
  // died (engine error / server restart) — the server tells them apart by status and
  // resumes the dangling one from its persisted transcript without appending anything.
  ctx.startDiscussion = (): void => {
    const id = activeDiscussionId.value
    if (!id) return
    send({ type: 'start_discussion', discussionId: id })
  }

  // Pause / resume the live orchestration of the open discussion.
  ctx.pauseDiscussion = (): void => {
    const id = activeDiscussionId.value
    if (id) send({ type: 'pause_discussion', discussionId: id })
  }
  ctx.resumeDiscussion = (): void => {
    const id = activeDiscussionId.value
    if (id) send({ type: 'resume_discussion', discussionId: id })
  }

  // The title bar's Stop: terminate the open discussion as `cancelled`. The
  // irreversible confirmation is the view's (ConfirmDialog); by the time this runs
  // the user has already confirmed. Terminal discussions are rejected server-side,
  // so a stale click can never rewrite a conclusion.
  ctx.cancelDiscussion = (): void => {
    const id = activeDiscussionId.value
    if (id) send({ type: 'cancel_discussion', discussionId: id })
  }

  // Submit the discussion composer.
  ctx.submitDiscussionInput = (): void => {
    const id = activeDiscussionId.value
    const text = discussionInput.value.trim()
    const status = activeDiscussion.value?.status
    if (!id || !text || !status) return
    if (status === 'in_progress') {
      send({ type: 'discussion_speak', discussionId: id, text })
    } else if (status === 'completed') {
      send({ type: 'continue_discussion', discussionId: id, text })
    } else {
      return
    }
    discussionInput.value = ''
  }

  // The 「研究会话」 tab asks for its session to become the globally active one, so the
  // embedded chat column binds. Same shape as `selectWorkSession` on the intents side:
  // fill the active session but stay on the discussion page — no console jump, no
  // console-session pin. Follow-up prompts and Stop then ride the ordinary session
  // channel from there.
  ctx.openResearchSession = (sessionId: string): void => {
    if (!discussionsProject.value || !sessionId) return
    send({ type: 'select_session', workspaceName: discussionsProject.value, sessionId })
  }

  // "Convert to Intent" in a completed discussion's title bar. The server creates
  // an empty draft intent and binds a comm session to it, then replies with
  // `create_intent_result` — so switching to the intents tab (and setting its
  // project) BEFORE sending is what lets that reply's workspace guard pass and
  // land us on the new intent's intent-session tab, exactly as after "+ intent".
  ctx.convertDiscussionToIntent = (): void => {
    const d = activeDiscussion.value
    if (!d || d.status !== 'completed') return
    // Landing on intents for a different create path discards any prior bind wait.
    ctx.awaitingIntentSessionBindId.value = null
    intentsProject.value = d.workspaceName
    activeTab.value = 'intents'
    ctx.persistViewMode()
    send({ type: 'discussion_to_intent', discussionId: d.id })
  }
}
