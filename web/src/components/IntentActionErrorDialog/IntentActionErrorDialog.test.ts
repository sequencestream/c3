/**
 * The intent-action error dialog: what it says for each kind of failure, and
 * what it refuses to offer.
 *
 * Assertions key off data-testid and emitted events, plus — where the contract IS
 * the text (the raw error must appear verbatim) — off the raw string the server
 * sent, never off translated app copy.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { GitActionFailureGuidance, GitActionFailureReason } from '@ccc/shared/protocol'
import { GIT_ACTION_FAILURE_REASONS } from '@ccc/shared/protocol'
import IntentActionErrorDialog from './IntentActionErrorDialog.vue'
import { GUIDANCE_MESSAGE_KEYS, RETRY_BUTTON_KEYS } from '@/lib/git-failure-guidance'
import { i18n } from '@/i18n'

const t = i18n.global.t as (key: string) => string

function guidanceFor(
  reason: GitActionFailureReason,
  over: Partial<GitActionFailureGuidance> = {},
): GitActionFailureGuidance {
  return {
    reason,
    detail: 'fatal: raw git output',
    retry: { type: 'intent-action', intentId: 'i-1', action: 'create-pr' },
    ...over,
  }
}

function mountDialog(guidance: GitActionFailureGuidance | null, message = 'PR creation failed.') {
  return mount(IntentActionErrorDialog, { props: { open: true, message, guidance } })
}

describe('IntentActionErrorDialog.vue — no guidance', () => {
  it('shows the plain translated error with no detail block and no action', () => {
    const w = mountDialog(null, 'Cannot start work from status "done".')

    expect(w.find('[data-testid="error-dialog-message"]').text()).toBe(
      'Cannot start work from status "done".',
    )
    expect(w.find('[data-testid="error-dialog-detail"]').exists()).toBe(false)
    expect(w.find('[data-testid="error-dialog-action"]').exists()).toBe(false)
  })
})

describe('IntentActionErrorDialog.vue — a classified reason', () => {
  it('shows the targeted instruction for every known reason', () => {
    for (const reason of GIT_ACTION_FAILURE_REASONS) {
      if (reason === 'unknown') continue
      const w = mountDialog(guidanceFor(reason))
      expect(w.find('[data-testid="error-dialog-message"]').text()).toBe(
        t(GUIDANCE_MESSAGE_KEYS[reason]),
      )
    }
  })

  it('keeps the raw error verbatim as a labelled diagnostic detail', () => {
    const detail = 'git push 失败: ! [rejected]\n  hint: fetch first'
    const w = mountDialog(guidanceFor('push_rejected', { detail }))

    const block = w.find('[data-testid="error-dialog-detail"]')
    expect(block.exists()).toBe(true)
    // Verbatim, newlines and all — this is what a user debugs with.
    expect(block.find('pre').text()).toBe(detail)
    expect(block.text()).toContain(t('intent.gitFailure.rawDetail.label'))
  })

  it('renders the raw error as text, never as markup', () => {
    const detail = 'fatal: <img src=x onerror="alert(1)"> & <b>bold</b>'
    const w = mountDialog(guidanceFor('filesystem_denied', { detail }))

    const block = w.find('[data-testid="error-dialog-detail"]')
    expect(block.find('pre').text()).toBe(detail)
    expect(block.find('img').exists()).toBe(false)
    expect(block.find('b').exists()).toBe(false)
  })

  it('labels the retry with the action the failure came from', () => {
    const dev = mountDialog(
      guidanceFor('worktree_branch_or_path_taken', {
        retry: { type: 'intent-action', intentId: 'i-1', action: 'start-development' },
      }),
    )
    expect(dev.find('[data-testid="error-dialog-action"]').text()).toBe(
      t(RETRY_BUTTON_KEYS['start-development']),
    )

    const pr = mountDialog(guidanceFor('push_rejected'))
    expect(pr.find('[data-testid="error-dialog-action"]').text()).toBe(
      t(RETRY_BUTTON_KEYS['create-pr']),
    )
  })

  it('emits exactly one retry (and one close) per click', async () => {
    const guidance = guidanceFor('push_rejected')
    const w = mountDialog(guidance)

    await w.find('[data-testid="error-dialog-action"]').trigger('click')

    expect(w.emitted('retry')).toHaveLength(1)
    expect(w.emitted('retry')![0]).toEqual([guidance])
    // The failed run's dialog goes away; the retry itself is the caller's job.
    expect(w.emitted('close')).toHaveLength(1)
  })
})

describe('IntentActionErrorDialog.vue — an unknown reason', () => {
  it('shows the raw multi-line error itself and guesses no repair steps', () => {
    const detail = 'fatal: something nobody classified\n  more context\n  and more'
    const w = mountDialog(guidanceFor('unknown', { detail }))

    expect(w.find('[data-testid="error-dialog-message"]').text()).toBe(detail)
    // No duplicate: the raw text is the main display, so no detail block.
    expect(w.find('[data-testid="error-dialog-detail"]').exists()).toBe(false)
    // And none of the targeted instructions leaked in.
    for (const key of Object.values(GUIDANCE_MESSAGE_KEYS)) {
      expect(w.text()).not.toContain(t(key))
    }
  })

  it('falls back to stable copy when the failure returned no detail', () => {
    for (const detail of ['', '   \n ']) {
      const w = mountDialog(guidanceFor('unknown', { detail }))
      expect(w.find('[data-testid="error-dialog-message"]').text()).toBe(
        t('intent.gitFailure.noDetail'),
      )
    }
  })

  it('still offers the retry — an unclassified failure may still be transient', () => {
    const w = mountDialog(guidanceFor('unknown'))
    expect(w.find('[data-testid="error-dialog-action"]').text()).toBe(
      t(RETRY_BUTTON_KEYS['create-pr']),
    )
  })

  it('shows the link-existing-PR secondary action when requested', async () => {
    const w = mount(IntentActionErrorDialog, {
      props: {
        open: true,
        message: 'failed',
        guidance: null,
        showLinkExistingPr: true,
      },
    })
    expect(w.find('[data-testid="error-dialog-secondary-action"]').text()).toBe(
      t('intent.prLink.action.label'),
    )
    await w.find('[data-testid="error-dialog-secondary-action"]').trigger('click')
    expect(w.emitted('close')).toBeUndefined()
    expect(w.emitted('linkExistingPr')).toHaveLength(1)
  })
})
