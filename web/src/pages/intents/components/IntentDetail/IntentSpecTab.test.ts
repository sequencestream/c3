import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Intent } from '@ccc/shared/protocol'
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
