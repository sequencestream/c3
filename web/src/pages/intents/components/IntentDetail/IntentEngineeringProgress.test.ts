import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { EngineeringProgressInput } from '../../../../lib/intent-engineering-progress'
import IntentEngineeringProgress from './IntentEngineeringProgress.vue'

function mountProgress(
  intent: EngineeringProgressInput,
  opts: { sddEnabled?: boolean; workspaceGitBranchMode?: 'worktree' | 'current-branch' } = {},
) {
  return mount(IntentEngineeringProgress, {
    props: {
      intent,
      sddEnabled: opts.sddEnabled ?? false,
      workspaceGitBranchMode: opts.workspaceGitBranchMode,
    },
  })
}

function stages(w: ReturnType<typeof mountProgress>) {
  return w.findAll('[data-stage]')
}

describe('IntentEngineeringProgress.vue', () => {
  it('renders the accessible ol with localized stage/state text when SDD is enabled', () => {
    const w = mountProgress({ status: 'todo' }, { sddEnabled: true })
    const ol = w.find('[data-testid="intent-engineering-progress"]')
    expect(ol.element.tagName).toBe('OL')
    expect(ol.attributes('aria-label')).toBeTruthy()

    const s = stages(w)
    expect(s.map((x) => x.attributes('data-stage'))).toEqual(['intent', 'spec', 'work'])
    expect(s.map((x) => x.attributes('data-state'))).toEqual([
      'completed',
      'not_started',
      'not_started',
    ])
    // 每段结构:名称 → 标记点 → 状态,且状态文本非空(已本地化)。
    expect(
      s.every((stage) => {
        const c = Array.from(stage.element.children)
        return (
          c[0]?.classList.contains('intent-engineering-progress-name') &&
          c[1]?.classList.contains('intent-engineering-progress-marker') &&
          c[2]?.classList.contains('intent-engineering-progress-state') &&
          (c[2] as HTMLElement).textContent?.trim()
        )
      }),
    ).toBeTruthy()
  })

  it('omits the spec stage when SDD is disabled even with historical spec data', () => {
    const w = mountProgress(
      { status: 'todo', specPath: 'spec.md', specSessionId: 'spec-session' },
      { sddEnabled: false },
    )
    expect(stages(w).map((x) => x.attributes('data-stage'))).toEqual(['intent', 'work'])
  })

  it('renders the PR stage with the closed state and label in worktree mode', () => {
    const w = mountProgress(
      { status: 'done', prId: '42', prStatus: 'closed' },
      { sddEnabled: true, workspaceGitBranchMode: 'worktree' },
    )
    const s = stages(w)
    expect(s.map((x) => x.attributes('data-stage'))).toEqual(['intent', 'spec', 'work', 'pr'])
    const pr = s.at(-1)
    expect(pr?.attributes('data-state')).toBe('closed')
    expect(pr?.classes()).toContain('is-closed')
    expect(pr?.find('.intent-engineering-progress-name').text()).toBe('PR')
    expect(pr?.find('.intent-engineering-progress-state').text()).toBe('Closed / failed')
  })

  it('appends the PR stage reactively when the branch mode resolves to worktree', async () => {
    const w = mountProgress(
      { status: 'in_progress', prId: '42', prStatus: 'reviewing' },
      { sddEnabled: true },
    )
    expect(stages(w).map((x) => x.attributes('data-stage'))).toEqual(['intent', 'spec', 'work'])

    await w.setProps({ workspaceGitBranchMode: 'worktree' })
    const s = stages(w)
    expect(s.map((x) => x.attributes('data-stage'))).toEqual(['intent', 'spec', 'work', 'pr'])
    expect(s.at(-1)?.attributes('data-state')).toBe('in_progress')
  })

  it('keeps the PR stage hidden in current-branch mode', async () => {
    const w = mountProgress(
      { status: 'in_progress', prId: '42', prStatus: 'reviewing' },
      { sddEnabled: true },
    )
    await w.setProps({ workspaceGitBranchMode: 'current-branch' })
    expect(stages(w).map((x) => x.attributes('data-stage'))).toEqual(['intent', 'spec', 'work'])
  })

  it('reacts when intent fields are backfilled', async () => {
    const w = mountProgress({ status: 'draft' }, { sddEnabled: true })
    expect(stages(w).map((x) => x.attributes('data-state'))).toEqual([
      'in_progress',
      'not_started',
      'not_started',
    ])

    await w.setProps({
      intent: {
        status: 'in_progress',
        specPath: 'spec.md',
        specApproved: true,
        lastWorkSessionId: 'work-session',
      },
    })
    expect(stages(w).map((x) => x.attributes('data-state'))).toEqual([
      'completed',
      'completed',
      'in_progress',
    ])
  })
})
