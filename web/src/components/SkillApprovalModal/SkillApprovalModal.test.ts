import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SkillApprovalModal from './SkillApprovalModal.vue'
import type { ApprovalRequest } from './SkillApprovalModal.vue'

let nextId = 1
function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: `req-${nextId++}`,
    kind: 'trust',
    id: 'my-skills',
    vendor: 'claude',
    repo: 'https://github.com/owner/repo',
    ref: 'main',
    detail: 'first-load: The repository has not been reviewed yet.',
    ...over,
  }
}

function mountModal(approvalReq: ApprovalRequest | null, open = true) {
  return mount(SkillApprovalModal, { props: { open, approval: approvalReq } })
}

describe('SkillApprovalModal.vue — trust kind', () => {
  it('renders the trust modal when kind is trust', () => {
    const w = mountModal(approval({ kind: 'trust' }))
    expect(w.find('[data-testid="skill-approval-overlay"]').exists()).toBe(true)
    expect(w.find('[data-testid="sa-approve"]').exists()).toBe(true)
    expect(w.find('[data-testid="sa-cancel"]').exists()).toBe(true)
  })

  it('emits approve with the request id', async () => {
    const req = approval({ kind: 'trust' })
    const w = mountModal(req)
    await w.find('[data-testid="sa-approve"]').trigger('click')
    expect(w.emitted('approve')).toBeTruthy()
    expect((w.emitted('approve') as [string][])[0][0]).toBe(req.requestId)
  })

  it('emits cancel with the request id', async () => {
    const req = approval({ kind: 'trust', requestId: 'req-42' })
    const w = mountModal(req)
    await w.find('[data-testid="sa-cancel"]').trigger('click')
    expect(w.emitted('cancel')).toBeTruthy()
    expect((w.emitted('cancel') as [string][])[0][0]).toBe('req-42')
  })

  it('renders nothing when open is false', () => {
    const w = mountModal(approval({ kind: 'trust' }), false)
    expect(w.find('[data-testid="skill-approval-overlay"]').exists()).toBe(false)
  })

  it('renders nothing when approval is null', () => {
    const w = mountModal(null)
    expect(w.find('[data-testid="skill-approval-overlay"]').exists()).toBe(false)
  })
})

describe('SkillApprovalModal.vue — gitignore kind', () => {
  it('renders the gitignore modal with detail line', () => {
    const w = mountModal(
      approval({
        kind: 'gitignore',
        detail: '_c3_*',
      }),
    )
    expect(w.find('[data-testid="skill-approval-overlay"]').exists()).toBe(true)
    expect(w.find('.sa-gitignore-line').exists()).toBe(true)
    expect(w.find('.sa-gitignore-line').text()).toBe('_c3_*')
  })

  it('emits approve on click', async () => {
    const req = approval({ kind: 'gitignore' })
    const w = mountModal(req)
    await w.find('[data-testid="sa-approve"]').trigger('click')
    expect(w.emitted('approve')).toBeTruthy()
  })
})

describe('SkillApprovalModal.vue — orphan kind', () => {
  it('renders the orphan modal', () => {
    const w = mountModal(approval({ kind: 'orphan' }))
    expect(w.find('[data-testid="skill-approval-overlay"]').exists()).toBe(true)
    expect(w.find('[data-testid="sa-approve"]').exists()).toBe(true)
    expect(w.find('[data-testid="sa-cancel"]').exists()).toBe(true)
  })

  it('emits approve on click', async () => {
    const req = approval({ kind: 'orphan', id: 'orphan-skill' })
    const w = mountModal(req)
    await w.find('[data-testid="sa-approve"]').trigger('click')
    expect(w.emitted('approve')).toBeTruthy()
  })
})
