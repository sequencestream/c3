import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Intent } from '@ccc/shared/protocol'
import { MACHINE_SPEC_APPROVER } from '@ccc/shared/protocol'
import IntentSpecTab from './IntentSpecTab.vue'

const SPEC = '/home/u/.c3/specs/proj/2026/07/07/x/spec.md'

function intent(overrides: Partial<Intent> & { id: string }): Intent {
  return {
    workspaceId: '/proj',
    title: 'T',
    shortEnTitle: null,
    content: 'B',
    priority: 'P1',
    module: '',
    status: 'todo',
    dependsOn: [],
    dependsOnTypes: {},
    lastWorkSessionId: null,
    automate: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    runStatus: 'idle',
    branchName: null,
    latestCommitHash: null,
    prId: null,
    prUrl: null,
    prStatus: null,
    specPath: SPEC,
    specApproved: false,
    specApproveUser: null,
    specSessionId: null,
    specReviewSessionId: null,
    specReviewVerdict: null,
    specReviewReason: null,
    specReviewAt: null,
    specReviewFingerprint: null,
    specReviewReworkRounds: 0,
    specReviewMachineApprovalBlocked: false,
    intentSessionId: null,
    sessionActive: false,
    ...overrides,
    id: overrides.id,
  }
}

function mountSpec(
  current: Intent,
  opts: {
    intentSpecContent?: string | null
    intentSpecLoading?: boolean
    specSessionRunning?: boolean
    intentActionErrorSeq?: number
    showApprove?: boolean
    showModify?: boolean
    modifyDisabled?: boolean
  } = {},
) {
  return mount(IntentSpecTab, {
    props: {
      intent: current,
      intentSpecContent: opts.intentSpecContent ?? '# spec source',
      intentSpecLoading: opts.intentSpecLoading ?? false,
      specSessionRunning: opts.specSessionRunning ?? false,
      intentActionErrorSeq: opts.intentActionErrorSeq ?? 0,
      showApprove: opts.showApprove ?? false,
      showModify: opts.showModify ?? false,
      modifyDisabled: opts.modifyDisabled ?? false,
    },
    global: { stubs: { MarkdownText: { template: '<div class="md" />' } } },
  })
}

const EDIT = '[data-testid="intent-detail-spec-edit"]'
const TEXTAREA = '[data-testid="intent-detail-spec-textarea"]'
const SAVE = '[data-testid="intent-detail-spec-save"]'
const APPROVE = '[data-testid="intent-detail-spec-approve"]'
const MODIFY = '[data-testid="intent-detail-spec-modify"]'

describe('IntentSpecTab.vue', () => {
  it('renders the empty state without a spec path', () => {
    const w = mountSpec(intent({ id: 'i1', specPath: null }))
    expect(w.find('[data-testid="intent-detail-spec-empty"]').exists()).toBe(true)
  })

  it('gates the Edit entry on specPath + todo + no work session + no live spec session', () => {
    expect(
      mountSpec(intent({ id: 'ok', status: 'todo' }))
        .find(EDIT)
        .exists(),
    ).toBe(true)
    expect(
      mountSpec(intent({ id: 'p', status: 'in_progress' }))
        .find(EDIT)
        .exists(),
    ).toBe(false)
    expect(
      mountSpec(intent({ id: 'w', status: 'todo', lastWorkSessionId: 'x' }))
        .find(EDIT)
        .exists(),
    ).toBe(false)
    expect(
      mountSpec(intent({ id: 'l', status: 'todo' }), { specSessionRunning: true })
        .find(EDIT)
        .exists(),
    ).toBe(false)
  })

  it('runs the edit save lifecycle and re-reads on refill', async () => {
    const item = intent({ id: 'i1', updatedAt: 1 })
    const w = mountSpec(item, { intentSpecContent: '# a' })
    await w.find(EDIT).trigger('click')
    expect((w.find(TEXTAREA).element as HTMLTextAreaElement).value).toBe('# a')
    await w.find(TEXTAREA).setValue('# b')
    await w.find(SAVE).trigger('click')
    expect(w.emitted('save-spec-content')).toEqual([['i1', '# b']])
    expect((w.find(SAVE).element as HTMLButtonElement).disabled).toBe(true)

    await w.setProps({ intent: { ...item, updatedAt: 2, specApproved: false } })
    expect(w.find(TEXTAREA).exists()).toBe(false)
    const reads = w.emitted('read-spec') as unknown[][] | undefined
    expect(reads?.some((c) => c[0] === 'i1' && c[1] === SPEC)).toBe(true)
  })

  it('releases the save guard on an error seq bump, keeping the editor open', async () => {
    const w = mountSpec(intent({ id: 'i1' }), { intentSpecContent: '# a' })
    await w.find(EDIT).trigger('click')
    await w.find(TEXTAREA).setValue('# b')
    await w.find(SAVE).trigger('click')
    await w.setProps({ intentActionErrorSeq: 1 })
    expect(w.find(TEXTAREA).exists()).toBe(true)
    expect((w.find(SAVE).element as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows approve/modify per props and hides them (and edit) while editing', async () => {
    const w = mountSpec(intent({ id: 'i1' }), { showApprove: true, showModify: true })
    expect(w.find(APPROVE).exists()).toBe(true)
    expect(w.find(MODIFY).exists()).toBe(true)

    await w.find(APPROVE).trigger('click')
    expect(w.emitted('approve-spec')).toEqual([['i1']])
    await w.find(MODIFY).trigger('click')
    expect(w.emitted('modify')).toEqual([[]])

    await w.find(EDIT).trigger('click')
    expect(w.find(APPROVE).exists()).toBe(false)
    expect(w.find(MODIFY).exists()).toBe(false)
    expect(w.find(EDIT).exists()).toBe(false)
  })

  it('disables the modify button when modifyDisabled is set', () => {
    const w = mountSpec(intent({ id: 'i1' }), { showModify: true, modifyDisabled: true })
    const modify = w.find(MODIFY)
    expect((modify.element as HTMLButtonElement).disabled).toBe(true)
    expect(modify.attributes('title')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Review facts + the revoke channel
// ---------------------------------------------------------------------------

const REVOKE = '[data-testid="intent-detail-spec-revoke"]'
const REVIEW = '[data-testid="intent-detail-spec-review"]'
const VERDICT = '[data-testid="intent-detail-spec-review-verdict"]'
const APPROVER = '[data-testid="intent-detail-spec-approver"]'

describe('IntentSpecTab — review conclusion + revoke', () => {
  it('shows nothing review-related when there is no conclusion and no approval', () => {
    const w = mountSpec(intent({ id: 'i1' }))
    expect(w.find(REVIEW).exists()).toBe(false)
    expect(w.find(REVOKE).exists()).toBe(false)
  })

  it('renders a pass verdict with its reason', () => {
    const w = mountSpec(
      intent({ id: 'i1', specReviewVerdict: 'pass', specReviewReason: 'grounded' }),
    )
    expect(w.find(VERDICT).classes()).toContain('is-pass')
    expect(w.find(REVIEW).text()).toContain('grounded')
  })

  it('renders a changes-requested verdict with the rework round', () => {
    const w = mountSpec(
      intent({
        id: 'i1',
        specReviewVerdict: 'changes_requested',
        specReviewReason: 'missing acceptance criteria',
        specReviewReworkRounds: 2,
      }),
    )
    expect(w.find(VERDICT).classes()).toContain('is-changes')
    expect(w.find(REVIEW).text()).toContain('2')
    expect(w.find(REVIEW).text()).toContain('missing acceptance criteria')
  })

  it('distinguishes a machine approval from a human one', () => {
    const machine = mountSpec(
      intent({
        id: 'i1',
        specApproved: true,
        specApproveUser: MACHINE_SPEC_APPROVER,
        specReviewVerdict: 'pass',
      }),
    )
    const human = mountSpec(
      intent({ id: 'i2', specApproved: true, specApproveUser: 'alice', specReviewVerdict: 'pass' }),
    )
    expect(machine.find(APPROVER).text()).not.toBe(human.find(APPROVER).text())
    expect(human.find(APPROVER).text()).toContain('alice')
    // The machine identity constant is never shown raw as if it were a user.
    expect(machine.find(APPROVER).text()).not.toContain(MACHINE_SPEC_APPROVER)
  })

  it('offers revoke once approved — for BOTH machine and human approval', () => {
    for (const approver of [MACHINE_SPEC_APPROVER, 'alice']) {
      const w = mountSpec(intent({ id: 'i1', specApproved: true, specApproveUser: approver }))
      expect(w.find(REVOKE).exists()).toBe(true)
    }
  })

  it('emits revoke-spec-approval with the intent id', async () => {
    const w = mountSpec(intent({ id: 'i9', specApproved: true, specApproveUser: 'alice' }))
    await w.find(REVOKE).trigger('click')
    expect(w.emitted('revoke-spec-approval')).toEqual([['i9']])
  })

  it('hides the revoke entry and the review band while editing the spec source', async () => {
    const w = mountSpec(intent({ id: 'i1', specApproved: true, specReviewVerdict: 'pass' }), {
      showApprove: false,
    })
    expect(w.find(REVOKE).exists()).toBe(true)
    await w.find(EDIT).trigger('click')
    // Editing must not race an approval change, and the reviewer's verdict
    // describes the text being replaced — showing it here would mislead.
    expect(w.find(REVOKE).exists()).toBe(false)
    expect(w.find(REVIEW).exists()).toBe(false)
  })
})
