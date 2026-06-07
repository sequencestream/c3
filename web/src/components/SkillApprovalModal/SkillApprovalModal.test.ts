import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SkillApprovalModal from './SkillApprovalModal.vue'
import type { ApprovalRequest } from './SkillApprovalModal.vue'

let nextId = 1
function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: `req-${nextId++}`,
    kind: 'gitignore',
    id: 'my-skills',
    vendor: 'claude',
    repo: 'https://github.com/owner/repo',
    ref: 'main',
    detail: '_c3_*/',
    ...over,
  }
}

function mountModal(approvalReq: ApprovalRequest | null, open = true) {
  return mount(SkillApprovalModal, { props: { open, approval: approvalReq } })
}

describe('SkillApprovalModal.vue — gitignore kind', () => {
  it('renders the gitignore modal with detail line', () => {
    const w = mountModal(approval({ detail: '_c3_*' }))
    expect(w.find('[data-testid="skill-approval-overlay"]').exists()).toBe(true)
    expect(w.find('.sa-gitignore-line').exists()).toBe(true)
    expect(w.find('.sa-gitignore-line').text()).toBe('_c3_*')
  })

  it('emits approve with the request id', async () => {
    const req = approval()
    const w = mountModal(req)
    await w.find('[data-testid="sa-approve"]').trigger('click')
    expect(w.emitted('approve')).toBeTruthy()
    expect((w.emitted('approve') as [string][])[0][0]).toBe(req.requestId)
  })

  it('emits cancel with the request id', async () => {
    const req = approval({ requestId: 'req-42' })
    const w = mountModal(req)
    await w.find('[data-testid="sa-cancel"]').trigger('click')
    expect(w.emitted('cancel')).toBeTruthy()
    expect((w.emitted('cancel') as [string][])[0][0]).toBe('req-42')
  })

  it('renders nothing when open is false', () => {
    const w = mountModal(approval(), false)
    expect(w.find('[data-testid="skill-approval-overlay"]').exists()).toBe(false)
  })

  it('renders nothing when approval is null', () => {
    const w = mountModal(null)
    expect(w.find('[data-testid="skill-approval-overlay"]').exists()).toBe(false)
  })
})
