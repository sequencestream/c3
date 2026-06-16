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
    send({ type: 'list_discussions', workspaceId: path })
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
      workspaceId: discussionsProject.value,
      discussionType: payload.type,
      goal: payload.goal,
      context: payload.context,
      participantAgentIds: payload.participantAgentIds,
      organizerAgentId: payload.organizerAgentId,
    })
  }

  // "Start" in the discussion title bar (draft only): kick off the organizer engine.
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

  // "Convert to Intent" in a completed discussion's title bar.
  ctx.convertDiscussionToIntent = (): void => {
    const d = activeDiscussion.value
    if (!d || d.status !== 'completed') return
    intentsProject.value = d.workspaceId
    activeTab.value = 'intents'
    ctx.persistViewMode()
    send({ type: 'discussion_to_intent', discussionId: d.id })
  }
}
